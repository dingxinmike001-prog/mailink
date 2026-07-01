/**
 * IMAP normal email fetch Worker
 * Specifically handles normal email fetching
 * Optimized: only normal emails, batch processing, does not block signaling emails
 */
const { parentPort, workerData } = require('worker_threads');
const path = require('path');

const projectRoot = path.resolve(__dirname, '../../../');
require('module').Module.globalPaths.push(projectRoot);

const { SIGNALING_EMAIL_PREFIX } = require('../../../shared/config/signaling-constants');

const connectionManager = require('../imap-connection-manager');
const logger = require('../../logger');
const ImapSessionLogger = require('../imap-session-logger');
const { getInstance: getDedupManager } = require('../email-dedup-manager');
const libmime = require('libmime');

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
    logger.error('[NormalWorker] Fatal error:', err?.stack || err);
    const task = currentTask;
    currentTask = null;
    if (task?.username) {
        try {
            connectionManager.disconnectNormalEmail(task.username);
        } catch (e) {
            logger.error('[NormalWorker] Failed to reset connections:', e?.stack || e);
        }
    }
    if (task?.id && parentPort) {
        try {
            parentPort.postMessage({ id: task.id, success: false, error: err?.stack || err?.message || String(err) });
        } catch (e) {
            logger.error('[NormalWorker] Failed to notify parent:', e?.stack || e);
        }
    }
    handlingFatal = false;
};

process.on('uncaughtException', handleFatal);
process.on('unhandledRejection', handleFatal);

let dedupManager = null;
const getDedupManagerInstance = () => {
    if (!dedupManager) dedupManager = getDedupManager();
    return dedupManager;
};

const searchEmails = (imap, criteria) => {
    return new Promise((resolve, reject) => {
        imap.search(criteria, (err, results) => {
            if (err) reject(new Error(`Search failed: ${err.message}`));
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

const parseEmailHeaders = (headerContent) => {
    const headers = {};
    if (!headerContent) return headers;
    const lines = headerContent.split('\r\n');
    let currentField = null;
    let currentValue = '';
    for (const line of lines) {
        if (line.startsWith(' ') || line.startsWith('\t')) {
            if (currentField) currentValue += ' ' + line.trim();
        } else {
            if (currentField) headers[currentField.toLowerCase()] = currentValue.trim();
            const colonIndex = line.indexOf(':');
            if (colonIndex > 0) {
                currentField = line.substring(0, colonIndex).trim();
                currentValue = line.substring(colonIndex + 1).trim();
            } else {
                currentField = null;
                currentValue = '';
            }
        }
    }
    if (currentField) headers[currentField.toLowerCase()] = currentValue.trim();
    return {
        subject: libmime.decodeWords(headers['subject'] || ''),
        from: libmime.decodeWords(headers['from'] || ''),
        to: libmime.decodeWords(headers['to'] || ''),
        date: headers['date'] ? new Date(headers['date']) : new Date(),
        messageId: headers['message-id'] || ''
    };
};

const buildMinimalEmailFromAttributes = (attrs, uid) => {
    if (!attrs) {
        logger.warn(`[NormalWorker] Email attrs empty UID=${uid}`);
        return {
            uid, subject: 'No Subject', from: 'Unknown Sender', to: '', cc: '',
            date: new Date(), receivedDate: new Date(), text: '[Attrs failed]',
            html: '', messageId: `minimal-${uid}-${Date.now()}`, attachments: [],
            priority: null, headers: {}, is_read: 0
        };
    }
    // Check whether email is read (from flags)
    const isSeen = attrs.flags && attrs.flags.includes('\\Seen');
    const isRead = isSeen ? 1 : 0;
    const extractEmail = (f) => {
        if (!f) return '';
        if (typeof f === 'string') return f;
        if (Array.isArray(f) && f.length > 0) {
            return f.map(a => typeof a === 'string' ? a : (a.text || a.address || '')).join(', ');
        }
        return f.text || f.address || '';
    };
    const email = {
        uid, subject: attrs.subject || 'No Subject',
        from: extractEmail(attrs.from) || 'Unknown Sender',
        to: extractEmail(attrs.to) || '',
        cc: extractEmail(attrs.cc) || '',
        date: attrs.date || new Date(),
        receivedDate: attrs.date || new Date(),
        text: '[Body not downloaded]', html: '',
        messageId: attrs.messageId || `minimal-${uid}-${Date.now()}`,
        attachments: [], priority: null, headers: {},
        is_read: isRead
    };
    if (attrs.struct) {
        const extractAtts = (struct) => {
            const atts = [];
            const traverse = (part, prefix = '') => {
                if (!part) return;
                // Handle array-type struct
                if (Array.isArray(part)) {
                    for (let i = 0; i < part.length; i++) {
                        traverse(part[i], `${prefix}${i + 1}.`);
                    }
                    return;
                }
                // Determine whether it is an attachment
                const isAttachment = part.disposition?.type === 'attachment' ||
                                   (part.type && part.type.toUpperCase() !== 'TEXT' && part.type.toUpperCase() !== 'MULTIPART' && part.partID);
                
                if (isAttachment || (part.disposition && part.partID)) {
                    const rawFilename = part.disposition?.params?.filename ||
                                    part.params?.name ||
                                    part.params?.filename ||
                                    (part.disposition?.parameters?.filename) ||
                                    (part.partID ? `attachment_${part.partID}` : 'unknown');
                    const filename = libmime.decodeWords(rawFilename);
                    atts.push({ 
                        filename: filename,
                        contentType: `${part.type}/${part.subtype}`, 
                        size: part.size || 0, 
                        cid: part.id || part.partID || '' 
                    });
                }
                // Recursively process parts or nested arrays
                if (part.parts && Array.isArray(part.parts)) {
                    part.parts.forEach((p, i) => traverse(p, `${prefix}${i + 1}.`));
                }
            };
            traverse(struct);
            return atts;
        };
        email.attachments = extractAtts(attrs.struct);
    }
    return email;
};

const checkExistingEmailsInDatabase = async (username, uids) => {
    if (!uids || uids.length === 0) return { existingUids: new Set(), existingEmails: new Map() };
    try {
        const { getDatabase } = require('../imap-database');
        const db = getDatabase(username);
        const existingUids = new Set();
        const existingEmails = new Map();
        const batchSize = 100;
        for (let i = 0; i < uids.length; i += batchSize) {
            const batch = uids.slice(i, i + batchSize).map(uid => String(uid));
            const placeholders = batch.map(() => '?').join(',');
            const sql = `SELECT imap_uid, is_read FROM recv WHERE imap_uid IN (${placeholders})`;
            const rows = await db.query(sql, batch);
            rows.forEach(row => { 
                if (row.imap_uid) {
                    const uid = parseInt(row.imap_uid);
                    existingUids.add(uid);
                    existingEmails.set(uid, { is_read: row.is_read });
                }
            });
        }
        await db.close();
        if (existingUids.size > 0) logger.info(`[NormalWorker] ${existingUids.size} emails already in DB`);
        return { existingUids, existingEmails };
    } catch (error) {
        logger.warn(`[NormalWorker] DB check failed: ${error.message}`);
        return { existingUids: new Set(), existingEmails: new Map() };
    }
};

const updateEmailReadStatus = async (username, uid, isRead) => {
    try {
        const { getDatabase } = require('../imap-database');
        const db = getDatabase(username);
        const sql = `UPDATE recv SET is_read = ? WHERE imap_uid = ?`;
        await db.query(sql, [isRead, String(uid)]);
        await db.close();
        logger.info(`[NormalWorker] Updated email UID=${uid} is_read=${isRead}`);
        return true;
    } catch (error) {
        logger.warn(`[NormalWorker] Failed to update email UID=${uid}: ${error.message}`);
        return false;
    }
};

const processNormalEmails = async (imap, uids, config) => {
    if (uids.length === 0) return { newEmails: [], allEmails: [] };
    
    // Detailed flow trace logs
    const processStartTime = Date.now();
    logger.info(`[NormalWorker] [DIAGNOSTIC] Start processing normal emails`, {
        uidCount: uids.length,
        uids: uids.slice(0, 10), // only log the first10item(s)UID
        imapState: imap?.state,
        imapAuthenticated: imap?.state === 'authenticated',
        config: {
            username: config.username,
            host: config.host,
            port: config.port
        }
    });
    
    return new Promise((resolveGroup) => {
        const emails = [];
        const uidArray = [...uids];
        let messageIndex = 0;
        let successCount = 0;
        let errorCount = 0;
        let timeoutCount = 0;
        const dedupManager = getDedupManagerInstance();

        // Normal emails fetch header + structure info, not body content (avoid large email timeout)
        // Specify struct: true to ensure email structure (BODYSTRUCTURE) is fetched, used to extract attachment info
        // Only fetch necessary header fields, not email body content
        const headerOnlyOptions = {
            bodies: 'HEADER.FIELDS (SUBJECT FROM TO CC DATE MESSAGE-ID)',
            struct: true  // ✅ Key: must set struct: true to get BODYSTRUCTURE
        };

        logger.info(`[NormalWorker] [DIAGNOSTIC] Start fetching emails`, {
            fetchOptions: headerOnlyOptions,
            imapState: imap?.state
        });

        const f = imap.fetch(uids, headerOnlyOptions);
        
        // Add fetch-level error listener
        f.on('error', (err) => {
            logger.error(`[NormalWorker] [DIAGNOSTIC] Fetch stream error`, {
                error: err.message,
                code: err.code,
                stack: err.stack?.substring(0, 300),
                processedCount: messageIndex,
                totalCount: uids.length,
                imapState: imap?.state
            });
        });
        
        f.on('message', (msg, seqno) => {
            const uid = uidArray[messageIndex++];
            const msgStartTime = Date.now();
            
            logger.info(`[NormalWorker] [DIAGNOSTIC] Start processing email`, {
                uid,
                seqno,
                progress: `${messageIndex}/${uids.length}`,
                imapState: imap?.state
            });
            
            let emailAttrs = null;
            let headerContent = '';

            const emailPromise = new Promise((resolveEmail) => {
                const timeout = setTimeout(() => {
                    timeoutCount++;
                    const elapsed = Date.now() - msgStartTime;
                    logger.warn(`[NormalWorker] [DIAGNOSTIC] Email processing timeout`, {
                        uid,
                        elapsed,
                        hasAttrs: !!emailAttrs,
                        headerLength: headerContent.length,
                        imapState: imap?.state
                    });
                    resolveEmail(null);
                }, 15000); // 15-second timeout (only fetching email headers)

                msg.on('attributes', (attrs) => { 
                    emailAttrs = attrs;
                    logger.info(`[NormalWorker] [DIAGNOSTIC] Received email attributes`, {
                        uid,
                        attrs: {
                            uid: attrs.uid,
                            flags: attrs.flags,
                            date: attrs.date,
                            struct: !!attrs.struct,
                            structType: Array.isArray(attrs.struct) ? 'array' : typeof attrs.struct
                        }
                    });
                    if (attrs.struct) {
                        logger.info(`[NormalWorker] [DIAGNOSTIC] attrs.struct content`, {
                            uid,
                            struct: JSON.stringify(attrs.struct)
                        });
                    }
                });

                let streamError = null;

                msg.on('body', (stream, info) => {
                    logger.info(`[NormalWorker] [DIAGNOSTIC] Received email body`, {
                        uid,
                        which: info.which,
                        size: info.size
                    });
                    
                    try {
                        const chunks = [];
                        
                        stream.on('data', (chunk) => {
                            chunks.push(chunk);
                        });
                        
                        stream.on('error', (streamErr) => {
                            streamError = streamErr;
                            logger.error(`[NormalWorker] [DIAGNOSTIC] Stream error`, {
                                uid,
                                error: streamErr.message,
                                code: streamErr.code
                            });
                        });
                        
                        stream.on('end', () => {
                            headerContent = Buffer.concat(chunks).toString('utf8');
                            logger.info(`[NormalWorker] [DIAGNOSTIC] Body reception completed`, {
                                uid,
                                headerLength: headerContent.length
                            });
                        });
                    } catch (err) {
                        streamError = err;
                        logger.error('[NormalWorker] [DIAGNOSTIC] Stream failed:', {
                            uid,
                            error: err.message,
                            stack: err.stack?.substring(0, 300)
                        });
                    }
                });

                msg.once('end', () => {
                    if (streamError) {
                        errorCount++;
                        clearTimeout(timeout);
                        resolveEmail(null);
                        return;
                    }
                    try {
                        const emailData = buildMinimalEmailFromAttributes(emailAttrs, uid);
                        const parsedHeaders = parseEmailHeaders(headerContent);
                        if (parsedHeaders.subject) emailData.subject = parsedHeaders.subject;
                        if (parsedHeaders.from) emailData.from = parsedHeaders.from;
                        if (parsedHeaders.to) emailData.to = parsedHeaders.to;
                        if (parsedHeaders.date) emailData.date = parsedHeaders.date;
                        if (parsedHeaders.messageId) emailData.messageId = parsedHeaders.messageId;

                        // Not fetching body content, set as placeholder
                        emailData.text = '';

                        clearTimeout(timeout);

                        if (emailData.subject && emailData.subject.startsWith(SIGNALING_EMAIL_PREFIX)) {
                            logger.info(`[NormalWorker] [DIAGNOSTIC] Skip signaling email`, { uid });
                            resolveEmail(null);
                            return;
                        }

                        let sender = 'unknown';
                        if (emailData.from) {
                            if (typeof emailData.from === 'string') {
                                const match = emailData.from.match(/<([^>]+)>/);
                                sender = match ? match[1] : emailData.from;
                            } else if (emailData.from.address) {
                                sender = emailData.from.address;
                            }
                        }

                        const messageIdHeader = emailData.messageId || null;
                        if (dedupManager.isProcessed(uid, messageIdHeader, emailData.subject, sender)) {
                            logger.info(`[NormalWorker] [DIAGNOSTIC] Skip duplicate email`, { uid });
                            resolveEmail(null);
                            return;
                        }
                        dedupManager.markAsProcessed(uid, messageIdHeader, emailData.subject, sender);

                        successCount++;
                        logger.info(`[NormalWorker] [DIAGNOSTIC] Email processing succeeded`, {
                            uid,
                            elapsed: Date.now() - msgStartTime,
                            subject: emailData.subject,
                            from: sender,
                            attachments: emailData.attachments?.length || 0,
                            is_read: emailData.is_read
                        });
                        
                        const sessionLogger = ImapSessionLogger.getInstance(config.username, sender, config.username);
                        sessionLogger.info('Normal email processed (header only):', {
                            uid, subject: emailData.subject, from: sender,
                            isSignaling: false,
                            attachments: emailData.attachments?.length || 0,
                            is_read: emailData.is_read
                        });
                        resolveEmail(emailData);
                    } catch (err) {
                        errorCount++;
                        clearTimeout(timeout);
                        logger.error('[NormalWorker] [DIAGNOSTIC] Processing failed:', {
                            uid,
                            error: err.message,
                            stack: err.stack?.substring(0, 300)
                        });
                        resolveEmail(null);
                    }
                });
            });
            emails.push(emailPromise);
        });

        f.once('error', (err) => {
            logger.error('[NormalWorker] [DIAGNOSTIC] Fetch failed:', {
                error: err.message,
                code: err.code,
                stack: err.stack?.substring(0, 500),
                processedCount: messageIndex,
                totalCount: uids.length,
                imapState: imap?.state
            });
            resolveGroup({ newEmails: [], allEmails: [] });
        });

        f.once('end', () => {
            logger.info(`[NormalWorker] [DIAGNOSTIC] Fetch ended`, {
                totalEmails: emails.length,
                processedCount: messageIndex,
                imapState: imap?.state
            });
            
            Promise.all(emails).then((results) => {
                const valid = results.filter(e => e !== null);
                const totalTime = Date.now() - processStartTime;
                
                logger.info(`[NormalWorker] [DIAGNOSTIC] Processing completion statistics`, {
                    totalProcessed: results.length,
                    validEmails: valid.length,
                    successCount,
                    errorCount,
                    timeoutCount,
                    totalTime: `${totalTime}ms`,
                    avgTimePerEmail: results.length > 0 ? `${Math.round(totalTime / results.length)}ms` : 'N/A',
                    imapState: imap?.state
                });
                
                resolveGroup({ newEmails: valid, allEmails: results });
            }).catch(err => {
                logger.error('[NormalWorker] [DIAGNOSTIC] Processing error:', {
                    error: err.message,
                    stack: err.stack?.substring(0, 500)
                });
                resolveGroup({ newEmails: [], allEmails: [] });
            });
        });
    });
};

const fetchNormalEmails = async (config, minutes) => {
    const { imap, box } = await connectionManager.getNormalEmailConnection(config);
    logger.debug('[NormalWorker] Using normalEmail connection');
    imap.__mailinkBusy = true;
    try {
        await ensureInboxOpen(imap);
        const date = new Date();
        date.setTime(date.getTime() - (minutes || 10080) * 60 * 1000);
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const day = date.getDate().toString().padStart(2, '0');
        const month = months[date.getMonth()];
        const year = date.getFullYear();
        const dateString = `${day}-${month}-${year}`;

        const searchCriteria = [['SINCE', dateString]];
        const results = await searchEmails(imap, searchCriteria);
        logger.debug(`[NormalWorker] Search found ${results.length} emails`);

        if (results.length === 0) return [];

        const { isSignalingMap, expiredSignalingUids } = await identifySignalingEmails(imap, results);

        // Delete expired signaling emails (>3 minutes)
        if (expiredSignalingUids.length > 0) {
            try {
                const deletedCount = await deleteExpiredSignalingEmails(imap, expiredSignalingUids);
                logger.info(`[NormalWorker] Successfully deleted ${deletedCount}/${expiredSignalingUids.length} expired signaling email(s)`);
            } catch (deleteErr) {
                logger.error('[NormalWorker] Delete expired signaling emails failed:', deleteErr.message);
                // delete failure does not affect normal email processing，continue execution
            }
        }

        const normalUids = results.filter(uid => !isSignalingMap.get(uid));

        const { existingUids, existingEmails } = await checkExistingEmailsInDatabase(config.username, normalUids);
        const newNormalUids = normalUids.filter(uid => !existingUids.has(uid));

        logger.info(`[NormalWorker] Total: ${results.length}, Signaling: ${results.length - normalUids.length}, Normal: ${normalUids.length}, Existing: ${existingUids.size}, New: ${newNormalUids.length}`);

        // Process all normal emails (including existing ones) to get is_read status
        const { newEmails, allEmails } = await processNormalEmails(imap, normalUids, config);
        
        // Update is_read status of existing emails
        const updatePromises = [];
        for (const email of allEmails) {
            if (email && existingUids.has(email.uid)) {
                const existingEmail = existingEmails.get(email.uid);
                if (existingEmail && existingEmail.is_read !== email.is_read) {
                    updatePromises.push(updateEmailReadStatus(config.username, email.uid, email.is_read));
                }
            }
        }
        
        if (updatePromises.length > 0) {
            await Promise.all(updatePromises);
            logger.info(`[NormalWorker] Updated ${updatePromises.length} emails' read status`);
        }

        // Only return new emails for saving
        return newEmails;
    } finally {
        imap.__mailinkBusy = false;
    }
};

/**
 * Delete expired signaling emails
 * @param {Object} imap - IMAP connection
 * @param {Array} uids - Email UID list to delete
 * @returns {Promise<number>} - Number of deleted emails
 */
const deleteExpiredSignalingEmails = (imap, uids) => {
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
                if (!err) {
                    deletedCount++;
                } else {
                    logger.warn(`[NormalWorker] Delete expired signaling email failed UID=${uid}: ${err.message}`);
                }

                if (processedCount === uids.length) {
                    imap.expunge((err) => {
                        if (err) {
                            logger.error('[NormalWorker] Expunge failed:', err.message);
                            reject(new Error(`Failed to expunge emails: ${err.message}`));
                        } else {
                            resolve(deletedCount);
                        }
                    });
                }
            });
        });
    });
};

const identifySignalingEmails = (imap, uids) => {
    return new Promise((resolve, reject) => {
        const isSignalingMap = new Map();
        const expiredSignalingUids = []; // Expired signaling email UID list (>3 minutes)
        const headerOptions = { bodies: 'HEADER.FIELDS (SUBJECT DATE)', struct: true };
        const f = imap.fetch(uids, headerOptions);
        let index = 0;

        f.on('message', (msg) => {
            const uid = uids[index++];
            let subject = '';
            let dateStr = '';

            msg.on('body', (stream) => {
                let headerContent = '';
                stream.on('data', (chunk) => { headerContent += chunk.toString('utf8'); });
                stream.on('end', () => {
                    // Parse subject
                    const subjectMatch = headerContent.match(/Subject:\s*(.+)/i);
                    if (subjectMatch) {
                        subject = subjectMatch[1].trim();
                    }
                    // Parse date
                    const dateMatch = headerContent.match(/Date:\s*(.+)/i);
                    if (dateMatch) {
                        dateStr = dateMatch[1].trim();
                    }
                });
            });

            msg.once('end', () => {
                const isSignaling = subject && subject.includes(SIGNALING_EMAIL_PREFIX);
                isSignalingMap.set(uid, isSignaling);

                // If it is a signaling email, check whether expired (>3 minutes)
                if (isSignaling && dateStr) {
                    try {
                        const emailDate = new Date(dateStr);
                        const diffMinutes = (Date.now() - emailDate.getTime()) / (1000 * 60);
                        if (diffMinutes > 3) {
                            expiredSignalingUids.push(uid);
                            logger.info(`[NormalWorker] Found expired signaling email UID=${uid}, expired ${Math.round(diffMinutes)} minutes`);
                        }
                    } catch (e) {
                        logger.warn(`[NormalWorker] Parse email date failed UID=${uid}: ${e.message}`);
                    }
                }
            });
        });

        f.once('end', () => resolve({ isSignalingMap, expiredSignalingUids }));
        f.once('error', (err) => {
            logger.warn('[NormalWorker] Identify signaling failed:', err.message);
            const defaultMap = new Map();
            uids.forEach(uid => defaultMap.set(uid, false));
            resolve({ isSignalingMap: defaultMap, expiredSignalingUids: [] });
        });
    });
};

const handleRequest = async (message) => {
    try {
        if (!message || typeof message !== 'object') throw new Error('Invalid message');
        const { action, config, minutes } = message;
        if (!config || typeof config !== 'object' || !config.username) throw new Error('Invalid config');
        currentTask = { id: message.id, username: config.username, action };
        logger.info(`[NormalWorker] Handling: ${action}`, { username: config.username });

        if (action === 'fetchNormalEmails') {
            const emails = await fetchNormalEmails(config, minutes);
            parentPort.postMessage({ id: message.id, success: true, data: emails });
        } else {
            parentPort.postMessage({ id: message.id, success: false, error: `Unsupported: ${action}` });
        }
    } catch (error) {
        logger.error('[NormalWorker] Error:', error);
        parentPort.postMessage({ id: message.id, success: false, error: error.message });
    } finally {
        currentTask = null;
    }
};

parentPort.on('message', handleRequest);
parentPort.postMessage({ success: true, data: 'IMAP normal fetch worker ready' });
