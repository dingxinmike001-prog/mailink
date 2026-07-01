/**
 * Email body download Worker
 * Specifically responsible for downloading and parsing email body
 */
const { parentPort } = require('worker_threads');
const path = require('path');

// Add project root directory to module search path
const projectRoot = path.resolve(__dirname, '../../../');
require('module').Module.globalPaths.push(projectRoot);

// Import required modules
const connectionManager = require('../imap-connection-manager');
const { getInstance: getParserManager } = require('../email-parser-manager');
const pathUtils = require('../../../shared/path/path-utils');
const { UnifiedDB } = require('../../sqlite/sqlite-unified');
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
    logger.error('[FetchEmailBodyWorker] Fatal error:', err?.stack || err);

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
            logger.error('[FetchEmailBodyWorker] Failed to notify parent about fatal error:', e?.stack || e);
        }
    }

    handlingFatal = false;
};

process.on('uncaughtException', handleFatal);
process.on('unhandledRejection', handleFatal);

/**
 * Download email body
 */
const fetchEmailBody = async ({ username, emailId, uid, config }) => {
    const userLogger = logger.Logger.getInstance('default', { username });
    userLogger.info(`[FetchEmailBodyWorker] Fetching email body...`, { username, emailId, uid });

    // Get connection using dedicated fetchBody connection pool
    const { imap } = await connectionManager.getFetchBodyConnection(config);

    // Fetch email (bodies: '') - fetch full email
    const streamBuffer = await new Promise((resolve, reject) => {
        const fetch = imap.fetch([uid], { bodies: '' });
        let received = false;

        fetch.on('message', (msg) => {
            msg.on('body', (stream, info) => {
                userLogger.info(`[FetchEmailBodyWorker] Received email body`, { 
                    uid, 
                    which: info.which, 
                    size: info.size 
                });
                
                received = true;
                const chunks = [];
                stream.on('data', (chunk) => chunks.push(chunk));
                stream.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    userLogger.info(`[FetchEmailBodyWorker] Body reception completed`, { 
                        uid, 
                        bufferLength: buffer.length 
                    });
                    resolve(buffer);
                });
                stream.on('error', reject);
            });
        });

        fetch.once('error', reject);
        fetch.once('end', () => {
            if (!received) {
                reject(new Error('Email body not received from IMAP'));
            }
        });
    });

    // Parse email
    const parserManager = getParserManager();
    const parsed = await parserManager.parseEmail(streamBuffer, uid, { timeout: 120000 });

    // Update database
    const dbPath = pathUtils.getUserDbPath(username);
    const rows = await UnifiedDB.query(dbPath, 'SELECT txtbody, htmbody, attachments FROM recv WHERE id = ?', [emailId]);

    if (!rows || rows.length === 0) {
        throw new Error('Email not found in database');
    }

    // Parse existing attachments
    let existingAttachments = [];
    try {
        existingAttachments = typeof rows[0].attachments === 'string' 
            ? JSON.parse(rows[0].attachments) 
            : (rows[0].attachments || []);
    } catch (e) {
        existingAttachments = [];
    }

    const newTxtbody = parsed.text || '';
    const newHtmbody = parsed.html || '';

    // Merge attachment status
    let newAttachments = existingAttachments;
    if (parsed.attachments && parsed.attachments.length > 0) {
        newAttachments = parsed.attachments.map(newAtt => {
            const oldAtt = existingAttachments.find(a => a.filename === newAtt.filename);
            if (oldAtt) {
                newAtt.downloaded = oldAtt.downloaded;
                newAtt.localPath = oldAtt.localPath;
            }
            return newAtt;
        });
    }

    await UnifiedDB.execute(dbPath, 
        'UPDATE recv SET txtbody = ?, htmbody = ?, attachments = ? WHERE id = ?',
        [newTxtbody, newHtmbody, JSON.stringify(newAttachments), emailId]
    );

    userLogger.info(`[FetchEmailBodyWorker] Email body fetched and database updated successfully`, { username, emailId, uid });
    return { success: true, emailData: { text: newTxtbody, html: newHtmbody, attachments: newAttachments } };
};

/**
 * Handle request
 */
const handleRequest = async (message) => {
    try {
        if (!message || typeof message !== 'object') {
            throw new Error('Invalid message');
        }

        const { username, emailId, uid, config } = message;

        if (!config || typeof config !== 'object' || !config.username) {
            throw new Error('Invalid config in fetch email body worker');
        }

        currentTask = { id: message.id, username: config.username };

        logger.info(`[FetchEmailBodyWorker] Handling fetch email body request`, { username: config.username, emailId, uid });

        const result = await fetchEmailBody({ username, emailId, uid, config });
        parentPort.postMessage({
            id: message.id,
            success: true,
            data: result
        });
    } catch (error) {
        logger.error('[FetchEmailBodyWorker] Error handling request:', error);
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
parentPort.postMessage({ success: true, data: 'Fetch email body worker ready' });
