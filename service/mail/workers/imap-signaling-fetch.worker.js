/**
 * IMAP signaling email fetch Worker
 * Specifically handles fast fetching of WebRTC signaling emails
 * Optimized: only signaling emails, faster response, does not block normal emails
 */
const { parentPort, workerData } = require('worker_threads');
const path = require('path');

// Add project root directory to module search path
const projectRoot = path.resolve(__dirname, '../../../');
require('module').Module.globalPaths.push(projectRoot);

const { SIGNALING_EMAIL_PREFIX } = require('../../../shared/config/signaling-constants');

// Import required modules
const connectionManager = require('../imap-connection-manager');
const logger = require('../../logger');
const { Worker } = require('worker_threads');
const ImapSessionLogger = require('../imap-session-logger');
const { getInstance: getDedupManager } = require('../email-dedup-manager');

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
    logger.error('[SignalingWorker] Fatal error:', err?.stack || err);

    const task = currentTask;
    currentTask = null;

    if (task?.username) {
        try {
            connectionManager.disconnectPolling(task.username);
        } catch (e) {
            logger.error('[SignalingWorker] Failed to reset connections after fatal error:', e?.stack || e);
        }
    }

    if (task?.id && parentPort) {
        try {
            parentPort.postMessage({
                id: task.id,
                success: false,
                error: err?.stack || err?.message || String(err)
            });
        } catch (e) {
            logger.error('[SignalingWorker] Failed to notify parent about fatal error:', e?.stack || e);
        }
    }

    handlingFatal = false;
};

process.on('uncaughtException', handleFatal);
process.on('unhandledRejection', handleFatal);

// Global deduplication manager instance
let dedupManager = null;
const getDedupManagerInstance = () => {
    if (!dedupManager) {
        dedupManager = getDedupManager();
    }
    return dedupManager;
};

/**
 * Email parser manager - signaling email dedicated
 */
class SignalingParserWorkerManager {
    constructor() {
        this.worker = null;
        this.pendingParses = new Map();
        this.isReady = false;
        this.maxPendingParses = 50;
        this.initWorker();
    }

    initWorker() {
        try {
            this.worker = new Worker(path.join(__dirname, 'email-parser.worker.js'));
            
            this.worker.on('message', (response) => {
                if (response.type === 'log') {
                    const { level, message } = response;
                    if (level === 'error') logger.error(message);
                    else if (level === 'warn') logger.warn(message);
                    else logger.info(message);
                    return;
                }

                const { id, success, data, error } = response;
                const pending = this.pendingParses.get(id);

                if (pending) {
                    clearTimeout(pending.timeout);
                    this.pendingParses.delete(id);
                    if (success) pending.resolve(data);
                    else pending.reject(new Error(error || 'Unknown parsing error'));
                }
            });

            this.worker.on('error', (err) => {
                logger.error('[SignalingWorker] Parser worker error:', err);
                for (const [id, pending] of this.pendingParses) {
                    clearTimeout(pending.timeout);
                    pending.reject(new Error(`Parser worker crashed: ${err.message}`));
                }
                this.pendingParses.clear();
                setTimeout(() => this.initWorker(), 1000);
            });

            this.worker.on('exit', (code) => {
                if (code !== 0) {
                    logger.error(`[SignalingWorker] Parser worker exited with code ${code}`);
                    for (const [id, pending] of this.pendingParses) {
                        clearTimeout(pending.timeout);
                        pending.reject(new Error(`Parser worker exited with code ${code}`));
                    }
                    this.pendingParses.clear();
                    setTimeout(() => this.initWorker(), 1000);
                }
            });

            this.isReady = true;
            logger.info('[SignalingWorker] Parser worker initialized');
        } catch (err) {
            logger.error('[SignalingWorker] Failed to initialize parser worker:', err);
        }
    }

    async parse(data) {
        if (!this.worker) this.initWorker();
        if (this.pendingParses.size >= this.maxPendingParses) {
            throw new Error(`Too many pending parse requests (${this.maxPendingParses})`);
        }

        return new Promise((resolve, reject) => {
            const { id } = data;
            const timeout = setTimeout(() => {
                if (this.pendingParses.has(id)) {
                    this.pendingParses.delete(id);
                    reject(new Error(`Email processing timeout for UID: ${data.uid}`));
                }
            }, 30000); // Signaling email 30-second timeout

            this.pendingParses.set(id, { resolve, reject, timeout });
            try {
                this.worker.postMessage(data);
            } catch (err) {
                clearTimeout(timeout);
                this.pendingParses.delete(id);
                reject(new Error(`Failed to send to parser worker: ${err.message}`));
            }
        });
    }
}

const parserManager = new SignalingParserWorkerManager();

const streamToBuffer = (stream) => {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
};

const searchEmails = (imap, criteria) => {
    return new Promise((resolve, reject) => {
        imap.search(criteria, (err, results) => {
            if (err) reject(new Error(`Email search failed: ${err.message}`));
            else resolve(results);
        });
    });
};

const ensureInboxOpen = (imap) => {
    return new Promise((resolve, reject) => {
        if (imap && imap._box && imap._box.name === 'INBOX') {
            resolve(imap._box);
            return;
        }
        imap.openBox('INBOX', false, (err, box) => {
            if (err) reject(err);
            else resolve(box);
        });
    });
};

/**
 * Handle signaling email (full fetch) - signaling email dedicated version
 */
const processSignalingEmails = async (imap, uids, config) => {
    if (uids.length === 0) return [];
    
    return new Promise((resolveGroup) => {
        const emailPromises = [];
        const uidArray = [...uids];
        let messageIndex = 0;
        const uidsToDelete = new Set();
        const dedupManager = getDedupManagerInstance();
        const processedSignalingSubjects = new Map();
        
        const fetchOptions = {
            bodies: '',
            struct: true,
            markSeen: true
        };
        
        const f = imap.fetch(uids, fetchOptions);
        
        f.on('message', (msg) => {
            const uid = uidArray[messageIndex++];
            
            const emailPromise = new Promise((resolveEmail) => {
                const emailTimeout = setTimeout(() => {
                    logger.warn(`[SignalingWorker] Email processing timeout UID=${uid}`);
                    resolveEmail(null);
                }, 30000);

                msg.on('body', async (stream) => {
                    try {
                        const streamBuffer = await streamToBuffer(stream);
                        const messageId = `signaling-${uid}-${Date.now()}`;
                        
                        const parsedEmail = await parserManager.parse({
                            id: messageId,
                            streamBuffer,
                            uid,
                            onlySignaling: true
                        });
                        
                        clearTimeout(emailTimeout);
                        
                        if (!parsedEmail || typeof parsedEmail !== 'object') {
                            resolveEmail(null);
                            return;
                        }
                        
                        const isSignaling = parsedEmail.subject && parsedEmail.subject.startsWith(SIGNALING_EMAIL_PREFIX);
                        if (!isSignaling) {
                            resolveEmail(null);
                            return;
                        }
                        
                        let sender = 'unknown';
                        if (parsedEmail.from) {
                            if (typeof parsedEmail.from === 'string') {
                                const emailMatch = parsedEmail.from.match(/<([^>]+)>/);
                                sender = emailMatch ? emailMatch[1] : parsedEmail.from;
                            } else if (parsedEmail.from.address) {
                                sender = parsedEmail.from.address;
                            }
                        }

                        const signalKey = parsedEmail.messageId
                            ? `msgid:${parsedEmail.messageId}`
                            : `uid:${uid}:${sender}:${parsedEmail.subject}`;
                            
                        if (processedSignalingSubjects.has(signalKey)) {
                            uidsToDelete.add(uid);
                            resolveEmail(null);
                            return;
                        }
                        processedSignalingSubjects.set(signalKey, uid);
                        
                        if (dedupManager.isSignalingEmailProcessed(parsedEmail.subject, sender, parsedEmail.messageId || null, uid)) {
                            uidsToDelete.add(uid);
                            resolveEmail(null);
                            return;
                        }

                        const messageIdHeader = parsedEmail.messageId || null;
                        if (dedupManager.isProcessed(uid, messageIdHeader, parsedEmail.subject, sender)) {
                            uidsToDelete.add(uid);
                            resolveEmail(null);
                            return;
                        }

                        dedupManager.markAsProcessed(uid, messageIdHeader, parsedEmail.subject, sender);

                        // Check whether signaling email is expired (90 seconds)
                        const now = new Date();
                        const emailDate = new Date(parsedEmail.date);
                        const diffSeconds = (now - emailDate) / 1000;
                        if (diffSeconds > 90) {
                            uidsToDelete.add(uid);
                            resolveEmail(null);
                            return;
                        }

                        uidsToDelete.add(uid);
                        resolveEmail(parsedEmail);
                    } catch (err) {
                        clearTimeout(emailTimeout);
                        logger.error('[SignalingWorker] Email parsing failed:', err);
                        resolveEmail(null);
                    }
                });
            });

            emailPromises.push(emailPromise);
        });

        f.once('error', (err) => {
            logger.error('[SignalingWorker] Failed to fetch signaling emails:', err);
            resolveGroup([]);
        });

        f.once('end', () => {
            Promise.all(emailPromises)
                .then((emailResults) => {
                    const validEmails = emailResults.filter(email => email !== null);
                    logger.info(`[SignalingWorker] Fetched ${validEmails.length} signaling emails, will delete ${uidsToDelete.size} emails`);
                    resolveGroup({ emails: validEmails, uidsToDelete: Array.from(uidsToDelete) });
                })
                .catch(err => {
                    logger.error('[SignalingWorker] Error in signaling email processing:', err);
                    resolveGroup({ emails: [], uidsToDelete: [] });
                });
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
 * Get signaling emails
 */
const fetchSignalingEmails = async (config, minutes) => {
    const { imap, box } = await connectionManager.getPollingConnection(config);
    logger.debug('[SignalingWorker] Using polling connection for signaling emails');
    
    imap.__mailinkBusy = true;
    try {
        await ensureInboxOpen(imap);

        const date = new Date();
        date.setMinutes(date.getMinutes() - (minutes || 2));

        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const day = date.getDate().toString().padStart(2, '0');
        const month = months[date.getMonth()];
        const year = date.getFullYear();
        const dateString = `${day}-${month}-${year}`;

        const searchCriteria = [
            ['SINCE', dateString],
            ['UNSEEN'],
            ['SUBJECT', SIGNALING_EMAIL_PREFIX]
        ];

        const results = await searchEmails(imap, searchCriteria);
        logger.debug(`[SignalingWorker] Search found ${results.length} signaling emails`);

        if (results.length === 0) {
            return [];
        }

        const { emails, uidsToDelete } = await processSignalingEmails(imap, results, config);
        
        // Delete processed signaling emails
        if (uidsToDelete.length > 0) {
            try {
                await deleteEmailsByUid(imap, uidsToDelete);
                logger.debug(`[SignalingWorker] Deleted ${uidsToDelete.length} processed signaling emails`);
            } catch (deleteErr) {
                logger.error('[SignalingWorker] Failed to delete emails:', deleteErr);
            }
        }

        return emails;
    } finally {
        imap.__mailinkBusy = false;
    }
};

/**
 * Handle request
 */
const handleRequest = async (message) => {
    try {
        if (!message || typeof message !== 'object') {
            throw new Error('Invalid message');
        }

        const { action, config, minutes } = message;

        if (!config || typeof config !== 'object' || !config.username) {
            throw new Error('Invalid config in signaling worker');
        }
        
        currentTask = { id: message.id, username: config.username, action };
        
        logger.info(`[SignalingWorker] Handling request: ${action}`, { username: config.username });
        
        if (action === 'fetchSignalingEmails') {
            const emails = await fetchSignalingEmails(config, minutes);
            parentPort.postMessage({
                id: message.id,
                success: true,
                data: emails
            });
        } else {
            parentPort.postMessage({
                id: message.id,
                success: false,
                error: `[SignalingWorker] Unsupported action: ${action}`
            });
        }
    } catch (error) {
        logger.error('[SignalingWorker] Error handling request:', error);
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
parentPort.postMessage({ success: true, data: 'IMAP signaling fetch worker ready' });
