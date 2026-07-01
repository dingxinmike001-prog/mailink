/**
 * IMAP flag sync Worker
 * Handles IMAP flag sync operations in independent threads
 * Responsibilities:
 * - Sync email read/unread status to server
 * - Get email status from server
 * - Use local lock mechanism to avoid conflicts
 */
const { parentPort } = require('worker_threads');
const path = require('path');
const connectionManager = require('../imap-connection-manager');
const { getInstance: getLockManager } = require('./imap-flags-lock-manager');

// Global lock manager
const lockManager = getLockManager();

/**
 * Send log message to main thread
 * @param {string} level - Log level
 * @param {string} message - Message content
 */
function sendLog(level, message) {
    try {
        parentPort.postMessage({
            type: 'log',
            level,
            message: `[IMAPFlagsWorker] ${message}`
        });
    } catch (err) {
        console.error(`[IMAPFlagsWorker] Failed to send log: ${err.message}`);
    }
}

/**
 * Handle single email flag sync
 * @param {Object} task - {id, username, password, host, port, tls, uid, action}
 */
async function handleSingleFlagSync(task) {
    const { id, username, password, host, port, tls, uid, action, mailbox } = task;
    let lockObject = null;

    try {
        sendLog('debug', `Starting single flag sync - UID=${uid}, action=${action}`);

        // Acquire lock
        lockObject = await lockManager.acquireLock(username, mailbox);
        const lockId = lockObject.acquire();

        // Build IMAP configuration
        const config = { username, password, host, port, tls };

        // Get connection
        const { imap } = await connectionManager.getConnection(config);

        // Execute flag operation
        const result = await new Promise((resolve, reject) => {
            if (action === 'addSeen') {
                imap.addFlags(parseInt(uid, 10), '\\Seen', (err) => {
                    if (err) reject(err);
                    else resolve(true);
                });
            } else if (action === 'delSeen') {
                imap.delFlags(parseInt(uid, 10), '\\Seen', (err) => {
                    if (err) reject(err);
                    else resolve(true);
                });
            } else {
                reject(new Error(`Unknown action: ${action}`));
            }
        });

        sendLog('info', `Successfully synced flag for UID=${uid}, action=${action}`);

        parentPort.postMessage({
            id,
            success: true,
            uid,
            action
        });
    } catch (error) {
        sendLog('error', `Failed to sync flag for UID=${uid}: ${error.message}`);

        parentPort.postMessage({
            id,
            success: false,
            error: error.message,
            uid,
            action
        });
    } finally {
        // Release lock
        if (lockObject) {
            lockObject.release();
        }
    }
}

/**
 * Handle batch flag sync
 * @param {Object} task - {id, username, password, host, port, tls, uids, action}
 */
async function handleBatchFlagSync(task) {
    const { id, username, password, host, port, tls, uids, action, mailbox } = task;
    let lockObject = null;

    if (!Array.isArray(uids) || uids.length === 0) {
        sendLog('warn', `No valid UIDs provided for batch sync`);
        parentPort.postMessage({
            id,
            success: false,
            error: 'Empty UID list',
            syncedCount: 0,
            failedCount: 0
        });
        return;
    }

    try {
        sendLog('info', `Starting batch flag sync - ${uids.length} emails, action=${action}`);

        // Acquire lock
        lockObject = await lockManager.acquireLock(username, mailbox);
        const lockId = lockObject.acquire();

        // Build IMAP configuration
        const config = { username, password, host, port, tls };

        // Validate and convert UID
        const validUids = uids
            .map(uid => parseInt(uid, 10))
            .filter(uid => !isNaN(uid) && uid > 0);

        if (validUids.length === 0) {
            sendLog('warn', `No valid UIDs for batch sync`);
            parentPort.postMessage({
                id,
                success: false,
                error: 'No valid UIDs',
                syncedCount: 0,
                failedCount: uids.length
            });
            return;
        }

        // Get connection
        const { imap } = await connectionManager.getConnection(config);

        // Execute batch flag operation
        try {
            await new Promise((resolve, reject) => {
                if (action === 'addSeen') {
                    imap.addFlags(validUids, '\\Seen', (err) => {
                        if (err) reject(err);
                        else resolve(true);
                    });
                } else if (action === 'delSeen') {
                    imap.delFlags(validUids, '\\Seen', (err) => {
                        if (err) reject(err);
                        else resolve(true);
                    });
                } else {
                    reject(new Error(`Unknown action: ${action}`));
                }
            });

            sendLog(
                'info',
                `Successfully batch synced ${validUids.length} emails, action=${action}`
            );

            parentPort.postMessage({
                id,
                success: true,
                syncedCount: validUids.length,
                failedCount: uids.length - validUids.length,
                action
            });
        } catch (batchError) {
            sendLog(
                'warn',
                `Batch sync failed, attempting individual sync. Error: ${batchError.message}`
            );

            // Batch operation failed, try syncing one by one
            let syncedCount = 0;
            let failedCount = 0;

            for (const uid of validUids) {
                try {
                    await new Promise((resolve, reject) => {
                        if (action === 'addSeen') {
                            imap.addFlags(uid, '\\Seen', (err) => {
                                if (err) reject(err);
                                else resolve(true);
                            });
                        } else {
                            imap.delFlags(uid, '\\Seen', (err) => {
                                if (err) reject(err);
                                else resolve(true);
                            });
                        }
                    });
                    syncedCount++;
                } catch (err) {
                    sendLog('debug', `Failed to sync UID ${uid}: ${err.message}`);
                    failedCount++;
                }
            }

            parentPort.postMessage({
                id,
                success: syncedCount > 0,
                syncedCount,
                failedCount: failedCount + (uids.length - validUids.length),
                action,
                fallbackSync: true
            });
        }
    } catch (error) {
        sendLog('error', `Batch sync failed: ${error.message}`);

        parentPort.postMessage({
            id,
            success: false,
            error: error.message,
            syncedCount: 0,
            failedCount: uids.length
        });
    } finally {
        // Release lock
        if (lockObject) {
            lockObject.release();
        }
    }
}

/**
 * Handle getting flag status from server
 * @param {Object} task - {id, username, password, host, port, tls, uids}
 */
async function handleFetchFlags(task) {
    const { id, username, password, host, port, tls, uids, mailbox } = task;
    let lockObject = null;

    if (!Array.isArray(uids) || uids.length === 0) {
        sendLog('warn', `No valid UIDs provided for fetch`);
        parentPort.postMessage({
            id,
            success: true,
            statuses: []
        });
        return;
    }

    try {
        sendLog('info', `Starting fetch flags for ${uids.length} emails`);

        // Acquire lock
        lockObject = await lockManager.acquireLock(username, mailbox);
        const lockId = lockObject.acquire();

        // Build IMAP configuration
        const config = { username, password, host, port, tls };

        // Validate and convert UID
        const validUids = uids
            .map(uid => parseInt(uid, 10))
            .filter(uid => !isNaN(uid) && uid > 0);

        if (validUids.length === 0) {
            sendLog('warn', `No valid UIDs for fetch`);
            parentPort.postMessage({
                id,
                success: true,
                statuses: []
            });
            return;
        }

        // Get connection
        const { imap } = await connectionManager.getConnection(config);

        // Get email attributes
        const statuses = [];

        await new Promise((resolve, reject) => {
            const f = imap.fetch(validUids, { struct: false });

            f.on('message', (msg, seqno) => {
                msg.on('attributes', (attrs) => {
                    const uid = attrs.uid;
                    const isSeen = attrs.flags && attrs.flags.includes('\\Seen');
                    statuses.push({
                        uid: String(uid),
                        seen: isSeen
                    });
                });
            });

            f.once('error', (err) => {
                reject(err);
            });

            f.once('end', () => {
                resolve();
            });
        });

        sendLog('info', `Successfully fetched flags for ${statuses.length} emails`);

        parentPort.postMessage({
            id,
            success: true,
            statuses
        });
    } catch (error) {
        sendLog('error', `Failed to fetch flags: ${error.message}`);

        parentPort.postMessage({
            id,
            success: false,
            error: error.message,
            statuses: []
        });
    } finally {
        // Release lock
        if (lockObject) {
            lockObject.release();
        }
    }
}

/**
 * Get lock status (for debugging)
 * @param {Object} task - {id, username, mailbox}
 */
function handleGetLockStatus(task) {
    const { id, username, mailbox } = task;

    try {
        const status = lockManager.getLockStatus(username, mailbox);
        parentPort.postMessage({
            id,
            success: true,
            lockStatus: status
        });
    } catch (error) {
        parentPort.postMessage({
            id,
            success: false,
            error: error.message
        });
    }
}

/**
 * Get all active locks (for debugging)
 * @param {Object} task - {id}
 */
function handleGetActiveLocks(task) {
    const { id } = task;

    try {
        const locks = lockManager.getActiveLocks();
        parentPort.postMessage({
            id,
            success: true,
            activeLocks: locks
        });
    } catch (error) {
        parentPort.postMessage({
            id,
            success: false,
            error: error.message
        });
    }
}

// Listen to main thread messages
parentPort.on('message', async (message) => {
    const { id, type } = message;

    try {
        sendLog('debug', `Received message type=${type}`);

        switch (type) {
            case 'syncSingleFlag':
                await handleSingleFlagSync(message);
                break;

            case 'syncBatchFlags':
                await handleBatchFlagSync(message);
                break;

            case 'fetchFlags':
                await handleFetchFlags(message);
                break;

            case 'getLockStatus':
                handleGetLockStatus(message);
                break;

            case 'getActiveLocks':
                handleGetActiveLocks(message);
                break;

            default:
                sendLog('warn', `Unknown message type: ${type}`);
                parentPort.postMessage({
                    id,
                    success: false,
                    error: `Unknown message type: ${type}`
                });
        }
    } catch (error) {
        sendLog('error', `Unexpected error: ${error.message}`);
        parentPort.postMessage({
            id,
            success: false,
            error: error.message
        });
    }
});

// Error handling
process.on('uncaughtException', (err) => {
    sendLog('error', `Uncaught exception: ${err.message}`);
});

process.on('unhandledRejection', (reason, promise) => {
    sendLog('warn', `Unhandled rejection handled: ${reason}`);
    // handle silently，avoid crash
});

sendLog('info', 'IMAP Flags Sync Worker initialized');
