/**
 * IMAP email flag sync service
 * 
 * Optimized implementation:
 * - Uses dedicated Worker thread for flag sync without blocking main thread
 * - Implements local lock mechanism to prevent concurrent conflicts
 * - Provides task queue and performance statistics
 * 
 * ⭐ Optimization benefits:
 * - Main thread fully released, no I/O blocking
 * - Better user experience, no lag
 * - Supports large numbers of concurrent flag sync operations
 */
const logger = require('../logger');
const { getInstance: getFlagsSyncManager } = require('./imap-flags-sync-manager');

const flagsSyncManager = getFlagsSyncManager();

/**
 * Sync single email read status to IMAP server (compatible with old API)
 * @param {Object} config - IMAP config {username, password, host, port, tls}
 * @param {string} uid - Email IMAP UID
 * @returns {Promise<boolean>} Whether sync succeeded
 */
async function syncReadStatusToServer(config, uid) {
    if (!config || !config.username) {
        logger.warn('[IMAPFlagsSync] Invalid config provided');
        return false;
    }

    if (!uid) {
        logger.warn('[IMAPFlagsSync] No UID provided for sync');
        return false;
    }

    const uidNum = parseInt(uid, 10);
    if (isNaN(uidNum) || uidNum <= 0) {
        logger.warn(`[IMAPFlagsSync] Invalid UID: ${uid}`);
        return false;
    }

    try {
        logger.debug(
            `[IMAPFlagsSync] Syncing read status for UID ${uidNum} to server: ${config.username}`
        );

        const result = await flagsSyncManager.syncSingleFlag(config, uid, 'addSeen');
        return result;
    } catch (error) {
        logger.error(
            `[IMAPFlagsSync] Failed to sync read status to server: UID=${uidNum}, error=${error.message}`
        );
        return false;
    }
}

/**
 * Batch sync multiple email read statuses to IMAP server (compatible with old API)
 * @param {Object} config - IMAP config {username, password, host, port, tls}
 * @param {Array<string>} uids - Email IMAP UID array
 * @returns {Promise<{success: boolean, syncedCount: number, failedCount: number}>}
 */
async function batchSyncReadStatusToServer(config, uids) {
    if (!config || !config.username) {
        logger.warn('[IMAPFlagsSync] Invalid config provided for batch sync');
        return { success: false, syncedCount: 0, failedCount: uids?.length || 0 };
    }

    if (!uids || !Array.isArray(uids) || uids.length === 0) {
        logger.debug('[IMAPFlagsSync] No UIDs provided for batch sync');
        return { success: true, syncedCount: 0, failedCount: 0 };
    }

    try {
        logger.info(
            `[IMAPFlagsSync] Batch syncing ${uids.length} emails to server: ${config.username}`
        );

        const result = await flagsSyncManager.batchSyncFlags(
            config,
            uids,
            'addSeen',
            'INBOX'
        );

        return result;
    } catch (error) {
        logger.error(
            `[IMAPFlagsSync] Failed to batch sync read status: ${error.message}`
        );
        return { success: false, syncedCount: 0, failedCount: uids.length };
    }
}

/**
 * Get email read statuses from IMAP server (compatible with old API)
 * @param {Object} config - IMAP config {username, password, host, port, tls}
 * @param {Array<string>} uids - Email IMAP UID array
 * @returns {Promise<Map<string, boolean>>} UID to read status mapping
 */
async function fetchReadStatusFromServer(config, uids) {
    if (!config || !config.username) {
        logger.warn('[IMAPFlagsSync] Invalid config provided for fetch');
        return new Map();
    }

    if (!uids || !Array.isArray(uids) || uids.length === 0) {
        logger.debug('[IMAPFlagsSync] No UIDs provided for fetch');
        return new Map();
    }

    try {
        logger.debug(
            `[IMAPFlagsSync] Fetching read status for ${uids.length} emails from server: ${config.username}`
        );

        const statuses = await flagsSyncManager.fetchFlags(config, uids, 'INBOX');

        // Convert to old API format (Map)
        const readStatusMap = new Map();
        for (const { uid, seen } of statuses) {
            readStatusMap.set(String(uid), seen);
        }

        logger.debug(
            `[IMAPFlagsSync] Fetched read status for ${readStatusMap.size} emails`
        );
        return readStatusMap;
    } catch (error) {
        logger.error(`[IMAPFlagsSync] Failed to fetch read status: ${error.message}`);
        return new Map();
    }
}

/**
 * Sync email flag to server (new API)
 * @param {Object} config - IMAP config
 * @param {string|number} uid - Email UID
 * @param {string} action - Operation type ('addSeen' | 'delSeen')
 * @param {string} mailbox - Mailbox folder (default: 'INBOX')
 * @returns {Promise<boolean>}
 */
async function syncFlagToServer(config, uid, action = 'addSeen', mailbox = 'INBOX') {
    return flagsSyncManager.syncSingleFlag(config, uid, action, mailbox);
}

/**
 * Batch sync email flags to server (new API)
 * @param {Object} config - IMAP config
 * @param {Array<string|number>} uids - Email UID array
 * @param {string} action - Operation type ('addSeen' | 'delSeen')
 * @param {string} mailbox - Mailbox folder (default: 'INBOX')
 * @returns {Promise<{success: boolean, syncedCount: number, failedCount: number}>}
 */
async function batchSyncFlagsToServer(config, uids, action = 'addSeen', mailbox = 'INBOX') {
    return flagsSyncManager.batchSyncFlags(config, uids, action, mailbox);
}

/**
 * Get email flag statuses from server (new API)
 * @param {Object} config - IMAP config
 * @param {Array<string|number>} uids - Email UID array
 * @param {string} mailbox - Mailbox folder (default: 'INBOX')
 * @returns {Promise<Array>} [{uid, seen}, ...]
 */
async function fetchFlagsFromServer(config, uids, mailbox = 'INBOX') {
    return flagsSyncManager.fetchFlags(config, uids, mailbox);
}

/**
 * Get performance statistics (for monitoring)
 * @returns {Object} Statistics data
 */
function getStats() {
    return flagsSyncManager.getStats();
}

/**
 * Reset performance statistics
 */
function resetStats() {
    flagsSyncManager.resetStats();
}

/**
 * Gracefully close flag sync service
 * @param {number} timeout - Close timeout (ms)
 */
async function shutdown(timeout = 10000) {
    return flagsSyncManager.shutdown(timeout);
}

module.exports = {
    // Old API (compatible)
    syncReadStatusToServer,
    batchSyncReadStatusToServer,
    fetchReadStatusFromServer,

    // New API (recommended)
    syncFlagToServer,
    batchSyncFlagsToServer,
    fetchFlagsFromServer,

    // Monitoring interface
    getStats,
    resetStats,
    shutdown
};
