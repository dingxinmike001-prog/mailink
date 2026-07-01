/**
 * IMAP management Worker
 * Specifically handles IMAP management operations:
 * - Clear log directory (clearLogs)
 * - Search and delete emails (searchAndDeleteEmails)
 * - Delete emails by UID (deleteEmailsByUid)
 */
const { parentPort } = require('worker_threads');
const path = require('path');

// Add project root directory to module search path
const projectRoot = path.resolve(__dirname, '../../../');
require('module').Module.globalPaths.push(projectRoot);

// Import required modules
const connectionManager = require('../imap-connection-manager');
const logger = require('../../logger');

let currentTask = null;
let handlingFatal = false;

const toError = (value) => {
    if (value instanceof Error) return value;
    const err = new Error(typeof value === 'string' ? value : JSON.stringify(value));
    err.name = 'WorkerUnhandledError';
    return err;
};

const handleFatal = (value) => {
    if (handlingFatal) return;
    handlingFatal = true;

    const err = toError(value);
    logger.error('[ManagementWorker] Fatal error:', err?.stack || err);

    const task = currentTask;
    currentTask = null;

    if (task?.id && parentPort) {
        try {
            parentPort.postMessage({
                id: task.id,
                success: false,
                error: err?.stack || err?.message || String(err)
            });
        } catch (e) {
            logger.error('[ManagementWorker] Failed to notify parent about fatal error:', e?.stack || e);
        }
    }

    handlingFatal = false;
};

process.on('uncaughtException', handleFatal);
process.on('unhandledRejection', handleFatal);

/**
 * Wrap IMAP search as Promise
 */
const searchEmails = (imap, criteria) => {
    return new Promise((resolve, reject) => {
        imap.search(criteria, (err, results) => {
            if (err) reject(new Error(`Email search failed: ${err.message}`));
            else resolve(results);
        });
    });
};

/**
 * Delete email
 */
const deleteEmailsByUid = (imap, uids) => {
    return new Promise((resolve, reject) => {
        if (uids.length === 0) {
            resolve(0);
            return;
        }

        let deletedCount = 0;
        let processedCount = 0;

        uids.forEach((uid) => {
            imap.addFlags(uid, '\\Deleted', (err) => {
                processedCount++;
                if (!err) deletedCount++;
                
                if (processedCount === uids.length) {
                    imap.expunge((err) => {
                        if (err) reject(new Error(`Failed to expunge emails: ${err.message}`));
                        else resolve(deletedCount);
                    });
                }
            });
        });
    });
};

/**
 * Clear log directory
 */
const clearLogDirectories = async (username) => {
    const fs = require('fs');
    const pathUtils = require('../../../shared/path/path-utils');

    const clearedDirs = [];
    const errors = [];

    try {
        // Clear global log directory (async version)
        const globalLogDir = path.join(pathUtils.getResourcesDir(), 'users', 'log');
        try {
            await fs.promises.access(globalLogDir, fs.constants.F_OK);
            const files = await fs.promises.readdir(globalLogDir);
            let deletedCount = 0;
            for (const file of files) {
                const filePath = path.join(globalLogDir, file);
                try {
                    const stats = await fs.promises.lstat(filePath);
                    if (stats.isFile()) {
                        await fs.promises.unlink(filePath);
                        deletedCount++;
                    }
                } catch (fileErr) {
                    errors.push(`Failed to delete ${file}: ${fileErr.message}`);
                }
            }
            if (deletedCount > 0) {
                clearedDirs.push(`global(${deletedCount} files)`);
            }
        } catch {
            // directory does not exist，skip
        }

        // Clear user log directory (async version)
        if (username) {
            try {
                const userLogDir = pathUtils.getUserLogDir(username);
                try {
                    await fs.promises.access(userLogDir, fs.constants.F_OK);
                    const files = await fs.promises.readdir(userLogDir);
                    let deletedCount = 0;
                    for (const file of files) {
                        const filePath = path.join(userLogDir, file);
                        try {
                            const stats = await fs.promises.lstat(filePath);
                            if (stats.isFile()) {
                                await fs.promises.unlink(filePath);
                                deletedCount++;
                            }
                        } catch (fileErr) {
                            errors.push(`Failed to delete user log ${file}: ${fileErr.message}`);
                        }
                    }
                    if (deletedCount > 0) {
                        clearedDirs.push(`user:${username}(${deletedCount} files)`);
                    }
                } catch {
                    // directory does not exist，skip
                }
            } catch (userLogErr) {
                errors.push(`Failed to clear user log directory for ${username}: ${userLogErr.message}`);
            }
        }

        let resultMessage = '';
        if (clearedDirs.length > 0) {
            resultMessage = `Log directories cleared: ${clearedDirs.join(', ')}`;
        } else {
            resultMessage = 'No log directories found or no files to clear';
        }
        
        if (errors.length > 0) {
            resultMessage += `. Errors: ${errors.length} file(s) could not be deleted`;
        }

        return {
            success: true,
            message: resultMessage,
            clearedDirs: clearedDirs,
            errors: errors
        };
    } catch (err) {
        throw new Error(`Failed to clear log directory: ${err.message}`);
    }
};

/**
 * Search and delete emails
 */
const searchAndDeleteEmails = async (config, sender, subjectPrefix, options) => {
    const { imap } = await connectionManager.getDeleteConnection(config);
    logger.debug('[ManagementWorker] Using delete connection for search and delete');

    const searchCriteria = [];

    if (sender) {
        searchCriteria.push(['FROM', sender]);
    }

    searchCriteria.push(['SUBJECT', subjectPrefix]);

    if (options?.since) {
        searchCriteria.push(['SINCE', options.since]);
    }
    if (options?.before) {
        searchCriteria.push(['BEFORE', options.before]);
    }

    const results = await searchEmails(imap, searchCriteria);
    logger.debug('[ManagementWorker] Search results for deletion:', { count: results.length });

    if (results.length === 0) {
        return { success: true, message: 'No matching emails found', deletedCount: 0 };
    }

    const deletedCount = await deleteEmailsByUid(imap, results);

    return { success: true, message: 'Emails deleted successfully', deletedCount: deletedCount };
};

/**
 * Delete emails by UID
 */
const deleteEmailsByUidAction = async (config, uids) => {
    const { imap } = await connectionManager.getDeleteConnection(config);
    logger.debug('[ManagementWorker] Using delete connection for deleting emails by UID');

    const uidArray = Array.isArray(uids) ? uids : [uids];
    
    const deletedCount = await deleteEmailsByUid(imap, uidArray);

    return { success: true, message: 'Emails deleted successfully by UID', deletedCount: deletedCount };
};

/**
 * Handle request
 */
const handleRequest = async (message) => {
    try {
        if (!message || typeof message !== 'object') {
            throw new Error('Invalid message');
        }

        const { action, config, sender, subjectPrefix, options, uids } = message;

        // clearLogs does not need config.username
        if (action !== 'clearLogs') {
            if (!config || typeof config !== 'object' || !config.username) {
                throw new Error('Invalid config in management worker');
            }
            currentTask = { id: message.id, username: config.username, action };
        } else {
            currentTask = { id: message.id, username: config?.username, action };
        }
        
        logger.info(`[ManagementWorker] Handling request: ${action}`, { username: config?.username || 'N/A' });
        
        if (action === 'clearLogs') {
            const result = await clearLogDirectories(config?.username);
            parentPort.postMessage({
                id: message.id,
                success: true,
                data: result
            });
        } else if (action === 'searchAndDeleteEmails') {
            const result = await searchAndDeleteEmails(config, sender, subjectPrefix, options);
            parentPort.postMessage({
                id: message.id,
                success: true,
                data: result
            });
        } else if (action === 'deleteEmailsByUid') {
            const result = await deleteEmailsByUidAction(config, uids);
            parentPort.postMessage({
                id: message.id,
                success: true,
                data: result
            });
        } else {
            parentPort.postMessage({
                id: message.id,
                success: false,
                error: `[ManagementWorker] Unsupported action: ${action}`
            });
        }
    } catch (error) {
        logger.error('[ManagementWorker] Error handling request:', error);
        parentPort.postMessage({
            id: message.id,
            success: false,
            error: error.message
        });
    } finally {
        currentTask = null;
    }
};

parentPort.on('message', handleRequest);
parentPort.postMessage({ success: true, data: 'IMAP management worker ready' });
