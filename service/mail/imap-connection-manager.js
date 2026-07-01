const logger = require('../logger');
const { ConnectionPool } = require('./connection-pool');
const { ConnectionStrategy } = require('./connection-strategy');
const { ImapHealthChecker } = require('./imap-health-checker');
const { ImapReconnectManager } = require('./imap-reconnect-manager');
const { ImapIdleManager } = require('./imap-idle-manager');
const libmime = require('libmime');

class ImapConnectionManager {
    constructor() {
        this.mainPool = new ConnectionPool(this, ConnectionStrategy.MAIN);
        this.deletePool = new ConnectionPool(this, ConnectionStrategy.DELETE);
        this.idlePool = new ConnectionPool(this, ConnectionStrategy.IDLE);
        this.pollingPool = new ConnectionPool(this, ConnectionStrategy.POLLING);
        this.normalEmailPool = new ConnectionPool(this, ConnectionStrategy.NORMAL_EMAIL);
        this.fetchBodyPool = new ConnectionPool(this, ConnectionStrategy.FETCH_BODY);

        this.maxRetries = 3;
        this.baseRetryDelay = 3000;
        this.maxRetryDelay = 300000;

        this.heartbeatInterval = 120000;

        this.idleEnabled = true;
        this.idleRenewInterval = 25 * 60 * 1000;

        this.connectionIdleTimeout = 30 * 60 * 1000;
        this.idleCleanupInterval = 5 * 60 * 1000;
        this.idleCleanupTimer = null;

        this.fetchLoopEnabled = true;
        this.fetchTimeout = 30000;
        this.fetchPauseInterval = 500;
        this.maxFetchRetries = 5;

        this.fetchLoopTimers = new Map();
        this.fetchTimeoutTimers = new Map();

        this.healthCheckTimeout = 10000;
        this.healthCheckMaxRetries = 2;
        this.healthCheckRetryDelay = 1000;
        this.maxConsecutiveFailures = 3;
        this.minConnectionAge = 10000;

        this.backoffMultiplier = 1.5;
        this.jitterRange = 0.2;
        this.maxConsecutiveFailuresForBackoff = 5;
        this.backoffDuration = 30 * 1000;

        this.connectionStats = {
            totalChecks: 0,
            successfulChecks: 0,
            failedChecks: 0,
            reconnections: 0,
            avgConnectionLifetime: 0,
            connectionLifetimeSamples: []
        };

        this._startIdleCleanup();
    }

    _startIdleCleanup() {
        if (this.idleCleanupTimer) {
            return;
        }

        this.idleCleanupTimer = setInterval(() => {
            const now = Date.now();
            const idleTimeout = this.connectionIdleTimeout;

            for (const pool of [this.mainPool, this.deletePool, this.pollingPool, this.normalEmailPool, this.fetchBodyPool, this.idlePool]) {
                for (const [username, connInfo] of pool.pool.entries()) {
                    if (connInfo.status === 'CONNECTED' && now - connInfo.lastActivity > idleTimeout) {
                        const poolName = pool.strategy.name;
                        const ImapLogger = require('./imap-logger');
                        const imapLogger = ImapLogger.getInstance(username);
                        imapLogger.info(`[ConnectionManager] clean idle${poolName}connection: ${username}, idle time: ${Math.round((now - connInfo.lastActivity) / 1000)}s`);
                        pool.disconnect(username);
                    }
                }
            }
        }, this.idleCleanupInterval);

        logger.info('[ConnectionManager] idle connection cleanup timer started');
    }

    getConnection(config) {
        return this.mainPool.getConnection(config);
    }

    getDeleteConnection(config) {
        return this.deletePool.getConnection(config);
    }

    getIdleConnection(config) {
        return this.idlePool.getConnection(config);
    }

    getPollingConnection(config) {
        return this.pollingPool.getConnection(config);
    }

    getNormalEmailConnection(config) {
        return this.normalEmailPool.getConnection(config);
    }

    getFetchBodyConnection(config) {
        return this.fetchBodyPool.getConnection(config);
    }

    disconnect(username) {
        this.mainPool.disconnect(username);
        this.deletePool.disconnect(username);
        this.idlePool.disconnect(username);
        this.pollingPool.disconnect(username);
        this.normalEmailPool.disconnect(username);
        this.fetchBodyPool.disconnect(username);
    }

    disconnectFetchBody(username) {
        this.fetchBodyPool.disconnect(username);
    }

    disconnectDelete(username) {
        this.deletePool.disconnect(username);
    }

    disconnectIdle(username) {
        this.idlePool.disconnect(username);
    }

    disconnectPolling(username) {
        this.pollingPool.disconnect(username);
    }

    disconnectNormalEmail(username) {
        this.normalEmailPool.disconnect(username);
    }

    disconnectAll() {
        logger.info(`[ConnectionManager] disconnect all connections`);

        for (const [username, timer] of this.fetchLoopTimers.entries()) {
            clearTimeout(timer);
        }
        this.fetchLoopTimers.clear();

        for (const [username, timer] of this.fetchTimeoutTimers.entries()) {
            clearTimeout(timer);
        }
        this.fetchTimeoutTimers.clear();

        const usernames = Array.from(this.mainPool.pool.keys());
        usernames.forEach(username => this.disconnect(username));

        const deleteUsernames = Array.from(this.deletePool.pool.keys());
        deleteUsernames.forEach(username => this.deletePool.disconnect(username));

        const idleUsernames = Array.from(this.idlePool.pool.keys());
        idleUsernames.forEach(username => this.idlePool.disconnect(username));

        const pollingUsernames = Array.from(this.pollingPool.pool.keys());
        pollingUsernames.forEach(username => this.pollingPool.disconnect(username));

        const normalEmailUsernames = Array.from(this.normalEmailPool.pool.keys());
        normalEmailUsernames.forEach(username => this.normalEmailPool.disconnect(username));

        const fetchBodyUsernames = Array.from(this.fetchBodyPool.pool.keys());
        fetchBodyUsernames.forEach(username => this.fetchBodyPool.disconnect(username));
    }

    async resetConnection(username, config) {
        const ImapLogger = require('./imap-logger');
        const imapLogger = ImapLogger.getInstance(username);
        imapLogger.info(`[ConnectionManager] reset connection: ${username}`);
        this.disconnect(username);
        return this.getConnection(config);
    }

    async resetDeleteConnection(username, config) {
        const ImapLogger = require('./imap-logger');
        const imapLogger = ImapLogger.getInstance(username);
        imapLogger.info(`[ConnectionManager] reset delete connection: ${username}`);
        this.disconnectDelete(username);
        return this.getDeleteConnection(config);
    }

    getStatus(username) {
        let isConnected = false;
        let connInfo = null;
        let status = 'NOT_CONNECTED';
        let supportsIdle = false;
        let idleEnabled = false;
        let boxInfo = null;
        let retryCount = 0;
        let lastActivity = 0;

        if (this.mainPool.pool.has(username)) {
            const mainConn = this.mainPool.pool.get(username);
            if (mainConn.status === 'CONNECTED') {
                isConnected = true;
                connInfo = mainConn;
                status = mainConn.status;
                supportsIdle = mainConn.supportsIdle || false;
                idleEnabled = mainConn.idleEnabled || false;
                boxInfo = mainConn.box ? {
                    total: mainConn.box.messages.total,
                    unread: mainConn.box.messages.new
                } : null;
                retryCount = mainConn.retryCount;
                lastActivity = mainConn.lastActivity;
            }
        }

        if (!isConnected && this.pollingPool.pool.has(username)) {
            const pollingConn = this.pollingPool.pool.get(username);
            if (pollingConn.status === 'CONNECTED') {
                isConnected = true;
                connInfo = pollingConn;
                status = pollingConn.status;
                supportsIdle = pollingConn.supportsIdle || false;
                idleEnabled = pollingConn.idleEnabled || false;
                boxInfo = pollingConn.box ? {
                    total: pollingConn.box.messages.total,
                    unread: pollingConn.box.messages.new
                } : null;
                retryCount = pollingConn.retryCount;
                lastActivity = pollingConn.lastActivity;
            }
        }

        if (!isConnected) {
            return {
                connected: false,
                status: 'NOT_CONNECTED',
                supportsIdle: false,
                idleEnabled: false,
                fetchLoopEnabled: this.fetchLoopEnabled,
                fetchTimeout: this.fetchTimeout,
                fetchPauseInterval: this.fetchPauseInterval,
                isFetchLoopRunning: this.fetchLoopTimers.has(username)
            };
        }

        return {
            connected: isConnected,
            status: status,
            retryCount: retryCount,
            lastActivity: lastActivity,
            supportsIdle: supportsIdle,
            idleEnabled: idleEnabled,
            boxInfo: boxInfo,
            fetchLoopEnabled: this.fetchLoopEnabled,
            fetchTimeout: this.fetchTimeout,
            fetchPauseInterval: this.fetchPauseInterval,
            isFetchLoopRunning: this.fetchLoopTimers.has(username)
        };
    }

    getDeleteStatus(username) {
        return this.deletePool.getStatus(username);
    }

    /**
     * Create folder on IMAP server
     * @param {string} username - Username
     * @param {string} folderName - Folder name
     * @returns {Promise<Object>} Creation result
     */
    async createFolder(username, folderName) {
        const ImapLogger = require('./imap-logger');
        const imapLogger = ImapLogger.getInstance(username);
        const userDefaultLogger = logger.Logger.getInstance('default', { username });

        try {
            // Get existing connection
            const connInfo = this.mainPool.pool.get(username);
            if (!connInfo || connInfo.status !== 'CONNECTED' || !connInfo.imap) {
                userDefaultLogger.warn(`[createFolder] cannot create folder, IMAPnot connected: ${username}`);
                return { success: false, error: 'IMAP not connected' };
            }

            const imap = connInfo.imap;

            return new Promise((resolve) => {
                // Use IMAP addBox command to create folder
                imap.addBox(folderName, (err) => {
                    if (err) {
                        // Check if the error is folder already exists
                        if (err.message && err.message.includes('already exists')) {
                            userDefaultLogger.debug(`[createFolder] folder already exists: ${folderName}`);
                            resolve({ success: true, created: false, message: 'Folder already exists' });
                        } else {
                            userDefaultLogger.warn(`[createFolder] folder creation failed: ${folderName}`, err.message);
                            resolve({ success: false, error: err.message });
                        }
                    } else {
                        userDefaultLogger.info(`[createFolder] folder created successfully: ${folderName}`);
                        resolve({ success: true, created: true, message: 'Folder created successfully' });
                    }
                });
            });
        } catch (error) {
            userDefaultLogger.error(`[createFolder] folder creation exception: ${folderName}`, error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Check whether folder exists
     * @param {string} username - Username
     * @param {string} folderName - Folder name
     * @returns {Promise<Object>} Check result
     */
    async folderExists(username, folderName) {
        const ImapLogger = require('./imap-logger');
        const imapLogger = ImapLogger.getInstance(username);
        const userDefaultLogger = logger.Logger.getInstance('default', { username });

        try {
            const connInfo = this.mainPool.pool.get(username);
            if (!connInfo || connInfo.status !== 'CONNECTED' || !connInfo.imap) {
                userDefaultLogger.warn(`[folderExists] cannot check folder, IMAPnot connected: ${username}`);
                return { success: false, error: 'IMAP not connected' };
            }

            const imap = connInfo.imap;

            return new Promise((resolve) => {
                imap.getBoxes((err, boxes) => {
                    if (err) {
                        userDefaultLogger.warn(`[folderExists] failed to get folder list`, err.message);
                        resolve({ success: false, error: err.message });
                    } else {
                        // Check whether folder exists (supports nested paths)
                        const exists = this._checkFolderInBoxes(boxes, folderName);
                        resolve({ success: true, exists });
                    }
                });
            });
        } catch (error) {
            userDefaultLogger.error(`[folderExists] folder check exception`, error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Recursively check whether folder exists in folder tree
     * @param {Object} boxes - Folder tree
     * @param {string} folderName - Folder name to find
     * @returns {boolean}
     */
    _checkFolderInBoxes(boxes, folderName) {
        // Check top level directly
        if (boxes[folderName]) {
            return true;
        }

        // Recursively check subfolders
        for (const [name, box] of Object.entries(boxes)) {
            if (box.children) {
                // Build full path for check
                const fullPath = `${name}${box.delimiter || '/'}${folderName}`;
                if (this._checkFolderInBoxes(box.children, folderName) ||
                    this._checkFolderInBoxes(box.children, fullPath)) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Move emails to specified folder
     * @param {string} username - Username
     * @param {Array<number>} uids - Email UID array
     * @param {string} targetFolder - Target folder name
     * @returns {Promise<Object>} Move result
     */
    async moveEmails(username, uids, targetFolder) {
        const ImapLogger = require('./imap-logger');
        const imapLogger = ImapLogger.getInstance(username);
        const userDefaultLogger = logger.Logger.getInstance('default', { username });

        try {
            // Get existing connection
            const connInfo = this.mainPool.pool.get(username);
            if (!connInfo || connInfo.status !== 'CONNECTED' || !connInfo.imap) {
                userDefaultLogger.warn(`[moveEmails] cannot move email, IMAPnot connected: ${username}`);
                return { success: false, error: 'IMAP not connected' };
            }

            const imap = connInfo.imap;

            // Ensure uids is an array
            const uidArray = Array.isArray(uids) ? uids : [uids];
            if (uidArray.length === 0) {
                return { success: true, message: 'No emails to move' };
            }

            return new Promise((resolve) => {
                // Use IMAP move command to move emails (if supported)
                // Or use copy + delete combination
                const uidSet = uidArray.join(',');

                // First try using move (IMAP extension)
                if (imap.serverSupports('MOVE')) {
                    imap.move(uidSet, targetFolder, (err) => {
                        if (err) {
                            userDefaultLogger.warn(`[moveEmails] MOVEcommand failed, attemptCOPY+DELETE: ${err.message}`);
                            // Fallback to COPY+DELETE
                            this._copyAndDeleteEmails(imap, uidSet, targetFolder, username, resolve);
                        } else {
                            userDefaultLogger.info(`[moveEmails] email move succeeded: ${uidArray.length} emails to ${targetFolder}`);
                            resolve({ success: true, moved: uidArray.length, method: 'MOVE' });
                        }
                    });
                } else {
                    // Use COPY+DELETE
                    this._copyAndDeleteEmails(imap, uidSet, targetFolder, username, resolve);
                }
            });
        } catch (error) {
            userDefaultLogger.error(`[moveEmails] move email exception`, error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Move emails using COPY+DELETE combination (compatible with servers that do not support MOVE)
     * @param {Object} imap - IMAP instance
     * @param {string} uidSet - UID set string
     * @param {string} targetFolder - Target folder
     * @param {string} username - Username
     * @param {Function} resolve - Promise resolve function
     */
    _copyAndDeleteEmails(imap, uidSet, targetFolder, username, resolve) {
        const userDefaultLogger = logger.Logger.getInstance('default', { username });

        // 1. Copy emails to target folder first
        imap.copy(uidSet, targetFolder, (copyErr) => {
            if (copyErr) {
                userDefaultLogger.warn(`[moveEmails] COPYfailed: ${copyErr.message}`);
                resolve({ success: false, error: `Copy failed: ${copyErr.message}` });
                return;
            }

            // 2. Mark original emails as deleted
            imap.addFlags(uidSet, '\\Deleted', (flagErr) => {
                if (flagErr) {
                    userDefaultLogger.warn(`[moveEmails] mark delete failed: ${flagErr.message}`);
                    resolve({ success: false, error: `Add flags failed: ${flagErr.message}` });
                    return;
                }

                // 3. Execute expunge to permanently delete
                imap.expunge((expungeErr) => {
                    if (expungeErr) {
                        userDefaultLogger.warn(`[moveEmails] EXPUNGEfailed: ${expungeErr.message}`);
                        resolve({ success: false, error: `Expunge failed: ${expungeErr.message}` });
                        return;
                    }

                    userDefaultLogger.info(`[moveEmails] email move succeeded(COPY+DELETE): to ${targetFolder}`);
                    resolve({ success: true, moved: uidSet.split(',').length, method: 'COPY+DELETE' });
                });
            });
        });
    }

    /**
     * Search emails (search only, no move)
     * @param {string} username - Username
     * @param {Object} searchCriteria - Search criteria {subject, from, since}
     * @param {Object} options - Optional parameters {limit: limit returned count}
     * @returns {Promise<Object>} Search result {success, uids, emails}
     */
    async searchEmails(username, searchCriteria, options = {}) {
        const ImapLogger = require('./imap-logger');
        const imapLogger = ImapLogger.getInstance(username);
        const userDefaultLogger = logger.Logger.getInstance('default', { username });

        try {
            // Get existing connection
            const connInfo = this.mainPool.pool.get(username);
            if (!connInfo || connInfo.status !== 'CONNECTED' || !connInfo.imap) {
                userDefaultLogger.warn(`[searchEmails] cannot search emails, IMAPnot connected: ${username}`);
                return { success: false, error: 'IMAP not connected' };
            }

            const imap = connInfo.imap;

            return new Promise((resolve) => {
                // Build search criteria
                const criteria = [];
                if (searchCriteria.subject) {
                    criteria.push(['HEADER', 'SUBJECT', searchCriteria.subject]);
                }
                if (searchCriteria.from) {
                    criteria.push(['FROM', searchCriteria.from]);
                }
                if (searchCriteria.since) {
                    criteria.push(['SINCE', searchCriteria.since]);
                }

                if (criteria.length === 0) {
                    resolve({ success: false, error: 'No search criteria provided' });
                    return;
                }

                // Search emails
                imap.search(criteria, (err, results) => {
                    if (err) {
                        userDefaultLogger.warn(`[searchEmails] search failed: ${err.message}`);
                        resolve({ success: false, error: err.message });
                        return;
                    }

                    if (!results || results.length === 0) {
                        userDefaultLogger.debug(`[searchEmails] no matching emails found`);
                        resolve({ success: true, uids: [], emails: [], message: 'No matching emails found' });
                        return;
                    }

                    // If limit is set, take only the latest N (UIDs usually increase over time)
                    let limitedResults = results;
                    if (options.limit && options.limit > 0 && results.length > options.limit) {
                        limitedResults = results.slice(-options.limit);
                        userDefaultLogger.info(`[searchEmails] found ${results.length} matching emails, limited to latest ${options.limit}, UIDs: ${limitedResults.join(',')}`);
                    } else {
                        userDefaultLogger.info(`[searchEmails] found ${results.length} matching emails, UIDs: ${results.join(',')}`);
                    }

                    // Get email details for client-side secondary verification
                    const fetch = imap.fetch(limitedResults, {
                        bodies: 'HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)',
                        struct: false
                    });

                    const emails = [];
                    let fetchError = null;

                    fetch.on('message', (msg, seqno) => {
                        let uid = null;
                        const headers = {};

                        msg.on('attributes', (attrs) => {
                            uid = attrs.uid;
                        });

                        msg.on('body', (stream) => {
                            let buffer = '';
                            stream.on('data', (chunk) => {
                                buffer += chunk.toString('utf8');
                            });
                            stream.on('end', () => {
                                // Parse header fields
                                const lines = buffer.split('\r\n');
                                for (const line of lines) {
                                    const colonIndex = line.indexOf(':');
                                    if (colonIndex > 0) {
                                        const key = line.substring(0, colonIndex).trim().toLowerCase();
                                        const value = line.substring(colonIndex + 1).trim();
                                        headers[key] = value;
                                    }
                                }
                            });
                        });

                        msg.once('end', () => {
                            if (uid) {
                                emails.push({
                                    uid: uid,
                                    subject: libmime.decodeWords(headers.subject || ''),
                                    from: libmime.decodeWords(headers.from || ''),
                                    to: libmime.decodeWords(headers.to || ''),
                                    date: headers.date || '',
                                    messageId: headers['message-id'] || ''
                                });
                            }
                        });
                    });

                    fetch.once('error', (err) => {
                        fetchError = err;
                        userDefaultLogger.warn(`[searchEmails] failed to get email details: ${err.message}`);
                    });

                    fetch.once('end', () => {
                        if (fetchError) {
                            // Even if fetching details fails, return UIDs for client to decide
                            resolve({ 
                                success: true, 
                                uids: results, 
                                emails: emails,
                                partial: true,
                                error: fetchError.message 
                            });
                        } else {
                            resolve({ 
                                success: true, 
                                uids: results, 
                                emails: emails,
                                partial: false
                            });
                        }
                    });
                });
            });
        } catch (error) {
            userDefaultLogger.error(`[searchEmails] search email exception`, error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Search and move emails (with client-side secondary check)
     * @param {string} username - Username
     * @param {Object} searchCriteria - Search criteria {subject, from, since}
     * @param {string} targetFolder - Target folder
     * @param {Function} validatorFn - Client-side validation function (emails) => validatedUids
     * @param {Object} options - Optional parameters {limit: limit returned count}
     * @returns {Promise<Object>} Move result
     */
    async searchAndMoveEmails(username, searchCriteria, targetFolder, validatorFn = null, options = {}) {
        const userDefaultLogger = logger.Logger.getInstance('default', { username });

        try {
            // Step 1: Search emails (search only, no move, pass options)
            const searchResult = await this.searchEmails(username, searchCriteria, options);
            
            if (!searchResult.success) {
                return searchResult;
            }

            if (!searchResult.uids || searchResult.uids.length === 0) {
                return { success: true, moved: 0, message: 'No matching emails found' };
            }

            // Step 2: Client-side secondary verification (if validator function provided)
            let uidsToMove = searchResult.uids;
            
            if (validatorFn && typeof validatorFn === 'function') {
                try {
                    const validatedUids = await validatorFn(searchResult.emails, searchResult.uids);
                    if (validatedUids && validatedUids.length > 0) {
                        uidsToMove = validatedUids;
                        userDefaultLogger.info(`[searchAndMoveEmails] client verification passed: ${validatedUids.length}/${searchResult.uids.length} emails`);
                    } else {
                        userDefaultLogger.warn(`[searchAndMoveEmails] client verification did not pass any email, cancel move`);
                        return { success: true, moved: 0, message: 'No emails passed client validation' };
                    }
                } catch (validationError) {
                    userDefaultLogger.warn(`[searchAndMoveEmails] client verification error: ${validationError.message}, will move all search results`);
                    // when validation fails，still move original search results（conservative strategy）
                }
            }

            // Step 3: Move verified emails
            return await this.moveEmails(username, uidsToMove, targetFolder);
            
        } catch (error) {
            userDefaultLogger.error(`[searchAndMoveEmails] search move email exception`, error.message);
            return { success: false, error: error.message };
        }
    }
}

// Use Mixin pattern to compose functional modules
Object.assign(ImapConnectionManager.prototype, ImapHealthChecker);
Object.assign(ImapConnectionManager.prototype, ImapReconnectManager);
Object.assign(ImapConnectionManager.prototype, ImapIdleManager);

const connectionManager = new ImapConnectionManager();

module.exports = connectionManager;
