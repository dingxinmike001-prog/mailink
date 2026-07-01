const Imap = require('imap');

const logger = require('../logger');

const ImapLogger = require('./imap-logger');

const { ConnectionStrategy } = require('./connection-strategy');

const ConnectionDiagnostic = require('./connection-diagnostic');

const imapConfig = require('../../config/imap-connection-config');



class ConnectionPool {

    constructor(manager, strategy) {

        this.manager = manager;

        this.strategy = strategy;

        this.pool = new Map();

        this.heartbeatTimers = new Map();

        this.idleTimers = new Map();

    }



    async getConnection(config) {

        const username = config.username;

        const imapLogger = ImapLogger.getInstance(username);



        if (this.pool.has(username)) {

            const connInfo = this.pool.get(username);



            if (connInfo.status === 'CONNECTING') {

                imapLogger.info(`[ConnectionManager] waiting${this.strategy.name}connection establishment: ${username}`);

                return connInfo.connectPromise;

            }



            if (connInfo.status === 'RECONNECTING' && connInfo.connectPromise) {

                imapLogger.info(`[ConnectionManager] waiting${this.strategy.name}connection reconnect: ${username}`);

                return connInfo.connectPromise;

            }



            if (connInfo.status === 'CONNECTED' && connInfo.imap && connInfo.imap.state === 'authenticated') {

                const connectionAge = Date.now() - connInfo.lastActivity;

                if (connectionAge < 60000) {

                    imapLogger.debug(`[ConnectionManager] reuse${this.strategy.name}connection (new connection ${Math.round(connectionAge/1000)}seconds): ${username}`);

                    connInfo.lastActivity = Date.now();

                    return { imap: connInfo.imap, box: connInfo.box };

                }



                const isHealthy = await this.manager._checkConnectionHealth(connInfo, username);



                if (isHealthy) {

                    imapLogger.info(`[ConnectionManager] reuse existing${this.strategy.name}connection: ${username}`);

                    connInfo.lastActivity = Date.now();

                    return { imap: connInfo.imap, box: connInfo.box };

                } else {

                    imapLogger.warn(`[ConnectionManager] ${this.strategy.name}connection unhealthy, trying to rebuild: ${username}`);

                    connInfo.status = 'ERROR';

                }

            } else {

                imapLogger.info(`[ConnectionManager] ${this.strategy.name}connection status abnormal(${connInfo.status}), recreate: ${username}`);

            }



            if (connInfo.status === 'ERROR' || connInfo.status === 'DISCONNECTED') {

                this.disconnect(username);

            }

        }



        imapLogger.info(`[ConnectionManager] create new${this.strategy.name}connection: ${username}`);

        return this._createConnection(config);

    }



    _createConnection(config) {

        const username = config.username;

        const imap = this._createImapInstance(config);



        const connInfo = {

            imap,

            config,

            status: 'CONNECTING',

            retryCount: 0,

            lastActivity: Date.now(),

            connectionStartTime: Date.now(),

            healthCheckFailures: 0,

            box: null,

            connectPromise: null,

            supportsIdle: false,

            idleEnabled: false,

            reconnectScheduled: false

        };



        const imapLogger = ImapLogger.getInstance(username);

        imapLogger.info(`[ConnectionManager] started establishing${this.strategy.name}connection: ${username}, start time: ${new Date(connInfo.connectionStartTime).toISOString()}`);



        connInfo.connectPromise = this._setupConnectionEvents(connInfo, username, config);

        this.pool.set(username, connInfo);



        return connInfo.connectPromise;

    }



    _createImapInstance(config) {

        return new Imap({

            user: config.username,

            password: config.password,

            host: config.host,

            port: config.port,

            tls: config.tls || false,

            tlsOptions: {

                rejectUnauthorized: false,

                ...config.tlsOptions

            },

            connTimeout: imapConfig.connection.connTimeout,

            authTimeout: imapConfig.connection.authTimeout,

            keepalive: {

                interval: 10000,

                idleInterval: 300000,

                forceNoop: false

            }

        });

    }



    _setupConnectionEvents(connInfo, username, config) {

        const imap = connInfo.imap;

        const imapLogger = ImapLogger.getInstance(username);

        const userDefaultLogger = logger.Logger.getInstance('default', { username });



        return new Promise((resolve, reject) => {

            let resolved = false;



            const connectionTimeout = setTimeout(() => {

                if (!resolved) {

                    resolved = true;

                    imap.removeAllListeners('ready');

                    imap.removeAllListeners('error');

                    imap.removeAllListeners('end');

                    imap.removeAllListeners('close');



                    try {

                        imap.destroy();

                        userDefaultLogger.info(`[ConnectionManager] ${this.strategy.name}connection timeout, force destroyed`);

                    } catch (e) {

                        userDefaultLogger.error(`[ConnectionManager] destroy${this.strategy.name}connection failed`, e);

                    }



                    connInfo.status = 'ERROR';

                    reject(new Error(`Connection setup timed out (${imapConfig.connection.timeout/1000}s)`));

                }

            }, imapConfig.connection.timeout);



            const originalReadyHandler = () => {

                clearTimeout(connectionTimeout);

                userDefaultLogger.info(`[ConnectionManager] ${this.strategy.name}connection ready`);

                this.manager._logImapProperties(username, imap);

                this._handleReadyEvent(imap, connInfo, username, resolve, reject, resolved);

            };



            const originalErrorHandler = (err) => {

                clearTimeout(connectionTimeout);

                this._handleErrorEvent(connInfo, username, config, err, resolve, reject, resolved);

            };



            imap.once('ready', originalReadyHandler);

            imap.once('error', originalErrorHandler);



            imap.once('end', () => {

                clearTimeout(connectionTimeout);

                this._handleEndEvent(connInfo, username, config);

            });



            imap.once('close', (hadError) => {

                clearTimeout(connectionTimeout);

                this._handleCloseEvent(connInfo, username, config, hadError);

            });



            userDefaultLogger.info(`[ConnectionManager] connecting toIMAPserver(${this.strategy.name}connection)`);

            imap.connect();

        });

    }



    _handleReadyEvent(imap, connInfo, username, resolve, reject, resolved) {

        if (imap.serverSupports('ID')) {

            this.manager._sendImapId(imap, username, () => {

                this._openInbox(imap, connInfo, username, resolve, reject, resolved);

            });

        } else {

            this._openInbox(imap, connInfo, username, resolve, reject, resolved);

        }

    }



    _openInbox(imap, connInfo, username, resolve, reject, resolved) {

        const openBoxMethod = this.strategy.openInboxMethod;

        const userDefaultLogger = logger.Logger.getInstance('default', { username });



        imap.openBox('INBOX', false, (err, box) => {

            if (err) {

                userDefaultLogger.error(`[ConnectionManager] ${this.strategy.name}connection cannot openINBOX`, err);

                connInfo.status = 'ERROR';

                this.disconnect(username);

                if (!resolved) {

                    resolved = true;

                    reject(new Error(`Failed to open INBOX: ${err.message}`));

                }

                return;

            }



            userDefaultLogger.info(`[ConnectionManager] ${this.strategy.name}connectionINBOXopened, total emails: ${box.messages.total}`);

            connInfo.status = 'CONNECTED';

            connInfo.box = box;

            connInfo.lastActivity = Date.now();

            connInfo.retryCount = 0;

            connInfo.reconnectScheduled = false;



            const detectionResults = this.manager._detectIdleSupport(imap);

            userDefaultLogger.info(`[ConnectionManager] ${this.strategy.name}connection capability list detection result: method1=${detectionResults.method1}, method2=${detectionResults.method2}, method3=${detectionResults.method3}, method4=${detectionResults.method4}, hasIdle=${detectionResults.hasIdleInCapabilities}`);



            if (this.strategy.hasFetchLoop) {

                connInfo.supportsIdle = false;

                connInfo.idleEnabled = true;

                this.manager._startPollingHeartbeat(username);

            } else {

                userDefaultLogger.info(`[ConnectionManager] started actual test${this.strategy.name}connection IDLE command`);

                const testIdleMethod = this.strategy.testIdleMethod;

                if (testIdleMethod && this.manager[testIdleMethod]) {

                    this.manager[testIdleMethod](username, detectionResults, imap);

                }

            }



            if (!resolved) {

                resolved = true;

                resolve({ imap, box });

            }

        });

    }



    _handleErrorEvent(connInfo, username, config, err, resolve, reject, resolved) {

        const userDefaultLogger = logger.Logger.getInstance('default', { username });

        const diagnostic = ConnectionDiagnostic.getInstance();

        

        // Use diagnostic tool to log errors

        const errorCategory = diagnostic.logConnectionError(username, err, {

            strategy: this.strategy.name,

            connectionAge: Date.now() - (connInfo.connectionStartTime || Date.now()),

            connectionStatus: connInfo.status,

            imapState: connInfo.imap?.state,

            host: config.host,

            port: config.port

        });



        // If it is an authentication error, set retry count to max and enter backoff mode immediately

        if (errorCategory === 'AUTH_ERROR') {

            const imapLogger = ImapLogger.getInstance(username);

            imapLogger.warn(`[ConnectionManager] detected authentication error, enter backoff mode immediately: ${username}`);

            connInfo.retryCount = this.manager.maxRetries;

        }

        

        // Detailed error diagnostic logs

        const errorDetails = {

            message: err.message,

            code: err.code,

            errno: err.errno,

            syscall: err.syscall,

            stack: err.stack?.substring(0, 500),

            connectionAge: Date.now() - (connInfo.connectionStartTime || Date.now()),

            connectionStatus: connInfo.status,

            imapState: connInfo.imap?.state,

            strategy: this.strategy.name,

            category: errorCategory

        };

        

        // SSL/TLS-specific error detection

        const isSSLError = err.message?.includes('BAD_DECRYPT') || 

                          err.message?.toLowerCase().includes('ssl') || 

                          err.message?.toLowerCase().includes('tls') ||

                          err.message?.includes('cipher') ||

                          err.message?.includes('OPENSSL');

        

        // Timeout error detection

        const isTimeoutError = errorCategory === 'TIMEOUT_ERROR' || 

                              err.code === 'ETIMEDOUT' ||

                              err.message?.toLowerCase().includes('timeout');

        

        if (isSSLError) {

            userDefaultLogger.error(`[ConnectionManager] ${this.strategy.name}connectionSSL/TLSerror [DIAGNOSTIC]`, {

                ...errorDetails,

                errorType: 'SSL/TLS_ERROR',

                tlsConfig: {

                    rejectUnauthorized: config.tlsOptions?.rejectUnauthorized,

                    tls: config.tls

                },

                suggestion: 'check network stability, serverSSLconfiguration or try switchingTLSversion'

            });

        } else if (isTimeoutError) {

            userDefaultLogger.error(`[ConnectionManager] ${this.strategy.name}connection timeout error [DIAGNOSTIC]`, {

                ...errorDetails,

                errorType: 'TIMEOUT_ERROR',

                suggestion: 'increase connection timeout, check network latency or reduce concurrent connections'

            });

        } else if (err.code === 'ECONNRESET') {

            userDefaultLogger.error(`[ConnectionManager] ${this.strategy.name}connection network error [DIAGNOSTIC]`, {

                ...errorDetails,

                errorType: 'NETWORK_ERROR',

                suggestion: 'check network connection stability'

            });

        } else {

            userDefaultLogger.error(`[ConnectionManager] ${this.strategy.name}connection error [DIAGNOSTIC]`, errorDetails);

        }

        

        connInfo.status = 'ERROR';



        const reconnectMethod = this.strategy.reconnectMethod;

        if (reconnectMethod && this.manager[reconnectMethod]) {

            this.manager[reconnectMethod](username, config);

        }



        if (!resolved) {

            resolved = true;

            reject(new Error(`IMAP ${this.strategy.name} connection failed: ${err.message}`));

        }

    }



    _handleEndEvent(connInfo, username, config) {

        const userDefaultLogger = logger.Logger.getInstance('default', { username });

        userDefaultLogger.info(`[ConnectionManager] ${this.strategy.name}connection ended`);

        const wasDisconnecting = connInfo.status === 'DISCONNECTING';

        connInfo.status = 'DISCONNECTED';

        this._stopHeartbeat(username);



        if (!wasDisconnecting) {

            const reconnectMethod = this.strategy.reconnectMethod;

            if (reconnectMethod && this.manager[reconnectMethod]) {

                this.manager[reconnectMethod](username, config);

            }

        }

    }



    _handleCloseEvent(connInfo, username, config, hadError) {

        const userDefaultLogger = logger.Logger.getInstance('default', { username });

        

        // Detailed connection close diagnostics

        const closeDiagnostics = {

            hadError,

            previousStatus: connInfo.status,

            connectionDuration: Date.now() - (connInfo.connectionStartTime || Date.now()),

            lastActivity: connInfo.lastActivity,

            idleTime: Date.now() - (connInfo.lastActivity || Date.now()),

            strategy: this.strategy.name,

            imapState: connInfo.imap?.state,

            totalMessages: connInfo.box?.messages?.total

        };

        

        if (hadError) {

            userDefaultLogger.warn(`[ConnectionManager] ${this.strategy.name}connection closed abnormally [DIAGNOSTIC]`, closeDiagnostics);

        } else {

            userDefaultLogger.info(`[ConnectionManager] ${this.strategy.name}connection closed normally [DIAGNOSTIC]`, closeDiagnostics);

        }

        

        if (connInfo.status === 'CONNECTED') {

            connInfo.status = 'DISCONNECTED';

            this._stopHeartbeat(username);



            if (hadError) {

                const reconnectMethod = this.strategy.reconnectMethod;

                if (reconnectMethod && this.manager[reconnectMethod]) {

                    this.manager[reconnectMethod](username, config);

                }

            }

        }

    }



    _startHeartbeat(username) {

        this._stopHeartbeat(username);



        const timer = setInterval(() => {

            const connInfo = this.pool.get(username);

            if (!connInfo || connInfo.status !== 'CONNECTED') {

                this._stopHeartbeat(username);

                return;

            }



            if (connInfo.idleEnabled) {

                logger.debug(`[ConnectionManager] skip${this.strategy.name}connection heartbeat (IDLE mode): ${username}`);

                return;

            }



            if (!connInfo.imap || typeof connInfo.imap.noop !== 'function') {

                logger.warn(`[ConnectionManager] ${this.strategy.name}connectionimapobject invalid, skipped heartbeat: ${username}`);

                return;

            }



            try {

                connInfo.imap.noop((err) => {

                    if (err) {

                        if (this._isTemporaryError(err)) {

                            logger.warn(`[ConnectionManager] ${this.strategy.name}connection heartbeat temporarily failed, trying to recover: ${username}`, err.message);

                            this._attemptConnectionRecovery(connInfo, username);

                        } else {

                            logger.error(`[ConnectionManager] ${this.strategy.name}connection heartbeat failed: ${username}`, err);

                            connInfo.status = 'ERROR';

                            

                            const reconnectMethod = this.strategy.reconnectMethod;

                            if (reconnectMethod && this.manager[reconnectMethod]) {

                                this.manager[reconnectMethod](username, connInfo.config);

                            }

                        }

                    } else {

                        logger.debug(`[ConnectionManager] ${this.strategy.name}connection heartbeat succeeded: ${username}`);

                        connInfo.lastActivity = Date.now();

                    }

                });

            } catch (error) {

                logger.error(`[ConnectionManager] ${this.strategy.name}connection heartbeat exception: ${username}`, error);

            }

        }, this.manager.heartbeatInterval);



        this.heartbeatTimers.set(username, timer);

        logger.info(`[ConnectionManager] ${this.strategy.name}connection heartbeat started: ${username}, interval: ${this.manager.heartbeatInterval}ms`);

    }



    _isTemporaryError(err) {

        const tempErrorMessages = [

            'timeout',

            'ETIMEDOUT',

            'ECONNREFUSED',

            'ECONNRESET',

            'socket hang up',

            'stream error',

            'socket disconnect',

            'network'

        ];

        

        return tempErrorMessages.some(msg => 

            err.message && err.message.toLowerCase().includes(msg.toLowerCase())

        );

    }



    _attemptConnectionRecovery(connInfo, username) {

        const imapLogger = ImapLogger.getInstance(username);

        

        try {

            if (connInfo.imap && connInfo.imap.state === 'authenticated') {

                imapLogger.info(`[ConnectionManager] trying to recover connection@:  ${username}`);

                connInfo.imap.noop((err) => {

                    if (err) {

                        imapLogger.error(`[ConnectionManager] connection recovery failed: ${username}`, err);

                        connInfo.status = 'ERROR';

                    } else {

                        imapLogger.info(`[ConnectionManager] connection status recovered: ${username}`);

                        connInfo.lastActivity = Date.now();

                        connInfo.status = 'CONNECTED';

                    }

                });

            }

        } catch (error) {

            imapLogger.error(`[ConnectionManager] recovery attempt exception: ${username}`, error);

        }

    }



    _stopHeartbeat(username) {

        if (this.heartbeatTimers.has(username)) {

            clearInterval(this.heartbeatTimers.get(username));

            this.heartbeatTimers.delete(username);

            logger.info(`[ConnectionManager] ${this.strategy.name}connection heartbeat stopped: ${username}`);

        }

    }



    disconnect(username) {

        if (!this.pool.has(username)) {

            return;

        }



        const connInfo = this.pool.get(username);



        if (connInfo && connInfo.connectionStartTime) {

            const lifetime = Date.now() - connInfo.connectionStartTime;

            const imapLogger = ImapLogger.getInstance(username);

            imapLogger.info(`[ConnectionManager] ${this.strategy.name}connection disconnected: ${username}, lifetime: ${(lifetime/1000).toFixed(2)}seconds`);

        }



        // Clear reconnection schedule flag

        connInfo.reconnectScheduled = false;



        const startIdleMethod = this.strategy.startIdleMethod;

        const stopIdleMethod = this.strategy.stopIdleMethod;



        if (stopIdleMethod && this.manager[stopIdleMethod]) {

            this.manager[stopIdleMethod](username);

        }



        this._stopHeartbeat(username);



        if (connInfo.imap) {

            try {

                connInfo.status = 'DISCONNECTING';

                this.manager._endThenDestroy(connInfo.imap, username, `${this.strategy.name}connection`);

            } catch (error) {

                logger.error(`[ConnectionManager] disconnect${this.strategy.name}error disconnecting connection: ${username}`, error);

            }

        }



        this.pool.delete(username);

        logger.info(`[ConnectionManager] disconnected${this.strategy.name}connection: ${username}`);

    }



    getStatus(username) {

        if (!this.pool.has(username)) {

            return {

                connected: false,

                status: 'NOT_CONNECTED',

                supportsIdle: false,

                idleEnabled: false

            };

        }



        const connInfo = this.pool.get(username);

        return {

            connected: connInfo.status === 'CONNECTED',

            status: connInfo.status,

            retryCount: connInfo.retryCount,

            lastActivity: connInfo.lastActivity,

            supportsIdle: connInfo.supportsIdle || false,

            idleEnabled: connInfo.idleEnabled || false,

            boxInfo: connInfo.box ? {

                total: connInfo.box.messages.total,

                unread: connInfo.box.messages.new

            } : null

        };

    }

}



module.exports = { ConnectionPool };

