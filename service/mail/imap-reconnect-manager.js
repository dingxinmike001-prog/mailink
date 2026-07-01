const ImapLogger = require('./imap-logger');

const logger = require('../logger');



/**

 * IMAP connection reconnection management module

 * Responsible for reconnection logic for various connections

 */

const ImapReconnectManager = {



    _scheduleReconnect(username, config) {

        const connInfo = this.mainPool.pool.get(username);

        if (!connInfo) return;

        const imapLogger = ImapLogger.getInstance(username);



        // Prevent duplicate reconnections: check if a reconnection is already in progress

        if (connInfo.reconnectScheduled) {

            imapLogger.debug(`[ConnectionManager] reconnect already planned, skip duplicate request: ${username}`);

            return;

        }

        connInfo.reconnectScheduled = true;



        if (connInfo.retryCount >= this.maxRetries) {

            imapLogger.error(`[ConnectionManager] too many reconnect failures (${connInfo.retryCount}times), enter backoff mode: ${username}`);



            imapLogger.info(`[ConnectionManager] will in ${Math.round(this.backoffDuration/1000/60)} minutes then retry reconnect: ${username}`);



            setTimeout(() => {

                connInfo.reconnectScheduled = false;

                connInfo.retryCount = 0;

                connInfo.status = 'RECONNECTING';

                imapLogger.info(`[ConnectionManager] backoff period ended, trying to reconnect: ${username}`);

                this.mainPool._createConnection(config);

            }, this.backoffDuration);



            return;

        }



        connInfo.retryCount++;

        connInfo.status = 'RECONNECTING';



        const baseDelay = Math.min(

            this.baseRetryDelay * Math.pow(this.backoffMultiplier, connInfo.retryCount - 1),

            this.maxRetryDelay

        );



        const jitter = baseDelay * this.jitterRange * (Math.random() * 2 - 1);

        const delay = Math.max(baseDelay + jitter, 1000);



        imapLogger.info(`[ConnectionManager] ${connInfo.retryCount}/${this.maxRetries} - will in ${Math.round(delay)}ms then reconnect: ${username}, ` +

            `last activity time: ${new Date(connInfo.lastActivity).toISOString()}`);



        setTimeout(() => {

            connInfo.reconnectScheduled = false;

            imapLogger.info(`[ConnectionManager] started reconnecting (No. ${connInfo.retryCount} attempt): ${username}`);

            this.mainPool._createConnection(config);

        }, delay);

    },



    _scheduleDeleteReconnect(username, config) {

        const connInfo = this.deletePool.pool.get(username);

        if (!connInfo) return;

        const imapLogger = ImapLogger.getInstance(username);



        // Prevent duplicate reconnections: check if a reconnection is already in progress

        if (connInfo.reconnectScheduled) {

            imapLogger.debug(`[ConnectionManager] delete connection reconnect already planned, skip duplicate request: ${username}`);

            return;

        }

        connInfo.reconnectScheduled = true;



        if (connInfo.retryCount >= this.maxRetries) {

            imapLogger.error(`[ConnectionManager] delete connection too many reconnect failures (${connInfo.retryCount}times), enter backoff mode: ${username}`);



            imapLogger.info(`[ConnectionManager] delete connection will in ${Math.round(this.backoffDuration/1000/60)} minutes then retry reconnect: ${username}`);



            setTimeout(() => {

                connInfo.reconnectScheduled = false;

                connInfo.retryCount = 0;

                connInfo.status = 'RECONNECTING';

                imapLogger.info(`[ConnectionManager] delete connection backoff period ended, trying to reconnect: ${username}`);

                this.deletePool._createConnection(config);

            }, this.backoffDuration);



            return;

        }



        connInfo.retryCount++;

        connInfo.status = 'RECONNECTING';



        const baseDelay = Math.min(

            this.baseRetryDelay * Math.pow(this.backoffMultiplier, connInfo.retryCount - 1),

            this.maxRetryDelay

        );



        const jitter = baseDelay * this.jitterRange * (Math.random() * 2 - 1);

        const delay = Math.max(baseDelay + jitter, 1000);



        imapLogger.info(`[ConnectionManager] delete connection ${connInfo.retryCount}/${this.maxRetries} - will in ${Math.round(delay)}ms then reconnect: ${username}`);



        setTimeout(() => {

            connInfo.reconnectScheduled = false;

            imapLogger.info(`[ConnectionManager] started reconnecting delete connection (No. ${connInfo.retryCount} attempt): ${username}`);

            this.deletePool._createConnection(config);

        }, delay);

    },



    _scheduleIdleReconnect(username, config) {

        const connInfo = this.idlePool.pool.get(username);

        if (!connInfo) return;

        const imapLogger = ImapLogger.getInstance(username);



        // Prevent duplicate reconnections: check if a reconnection is already in progress

        if (connInfo.reconnectScheduled) {

            imapLogger.debug(`[ConnectionManager] IDLEconnection reconnect already planned, skip duplicate request: ${username}`);

            return;

        }

        connInfo.reconnectScheduled = true;



        if (connInfo.retryCount >= this.maxRetries) {

            connInfo.reconnectScheduled = false;

            imapLogger.error(`[ConnectionManager] IDLEconnection too many reconnect failures, gave up reconnecting`);

            this.idlePool.disconnect(username);

            return;

        }



        connInfo.retryCount++;

        connInfo.status = 'RECONNECTING';



        const baseDelay = Math.min(

            this.baseRetryDelay * Math.pow(2, connInfo.retryCount - 1),

            this.maxRetryDelay

        );

        const jitter = Math.random() * baseDelay * 0.9 + baseDelay * 0.1;

        const delay = Math.min(baseDelay + jitter, this.maxRetryDelay);



        imapLogger.info(`[ConnectionManager] IDLEconnection will in ${Math.round(delay)}ms then reconnect (attempt ${connInfo.retryCount}/${this.maxRetries})`);



        setTimeout(() => {

            connInfo.reconnectScheduled = false;

            imapLogger.info(`[ConnectionManager] started reconnectingIDLEconnection`);

            this.idlePool._createConnection(config);

        }, delay);

    },



    _schedulePollingReconnect(username, config) {

        let connInfo = this.pollingPool.pool.get(username);

        if (!connInfo) return;

        const imapLogger = ImapLogger.getInstance(username);



        // Prevent duplicate reconnections: check if a reconnection is already in progress

        if (connInfo.reconnectScheduled) {

            imapLogger.debug(`[ConnectionManager] polling connection reconnect already planned, skip duplicate request: ${username}`);

            return;

        }

        connInfo.reconnectScheduled = true;



        if (connInfo.retryCount >= this.maxRetries) {

            imapLogger.error(`[ConnectionManager] polling connection too many reconnect failures (${connInfo.retryCount}times), enter backoff mode: ${username}`);



            imapLogger.info(`[ConnectionManager] polling connection will in ${Math.round(this.backoffDuration/1000/60)} minutes then retry reconnect: ${username}`);



            setTimeout(() => {

                connInfo.reconnectScheduled = false;

                connInfo.retryCount = 0;

                connInfo.status = 'RECONNECTING';

                imapLogger.info(`[ConnectionManager] polling connection backoff period ended, trying to reconnect: ${username}`);

                const newConnPromise = this.pollingPool._createConnection(config);

                connInfo.connectPromise = newConnPromise;



                newConnPromise.then((result) => {

                    const updatedConnInfo = this.pollingPool.pool.get(username);

                    if (updatedConnInfo) {

                        updatedConnInfo.status = 'CONNECTED';

                        updatedConnInfo.lastActivity = Date.now();

                        imapLogger.info(`[ConnectionManager] polling connection reconnect succeeded after backoff`);

                    }

                }).catch((error) => {

                    const updatedConnInfo = this.pollingPool.pool.get(username);

                    if (updatedConnInfo) {

                        updatedConnInfo.status = 'ERROR';

                        updatedConnInfo.lastActivity = Date.now();

                        imapLogger.error(`[ConnectionManager] polling connection reconnect failed after backoff`, error);

                    }

                });

            }, this.backoffDuration);



            return;

        }



        connInfo.retryCount++;

        connInfo.status = 'RECONNECTING';



        const baseDelay = Math.min(

            this.baseRetryDelay * Math.pow(this.backoffMultiplier, connInfo.retryCount - 1),

            this.maxRetryDelay

        );



        const jitter = baseDelay * this.jitterRange * (Math.random() * 2 - 1);

        const delay = Math.max(baseDelay + jitter, 1000);



        imapLogger.info(`[ConnectionManager] polling connection ${connInfo.retryCount}/${this.maxRetries} - will in ${Math.round(delay)}ms then reconnect: ${username}`);



        setTimeout(() => {

            connInfo.reconnectScheduled = false;

            imapLogger.info(`[ConnectionManager] started reconnecting polling connection (No. ${connInfo.retryCount} attempt): ${username}`);

            const newConnPromise = this.pollingPool._createConnection(config);

            connInfo.connectPromise = newConnPromise;



            newConnPromise.then((result) => {

                const updatedConnInfo = this.pollingPool.pool.get(username);

                if (updatedConnInfo) {

                    updatedConnInfo.status = 'CONNECTED';

                    updatedConnInfo.lastActivity = Date.now();

                    imapLogger.info(`[ConnectionManager] polling connection reconnect succeeded`);

                }

            }).catch((error) => {

                const updatedConnInfo = this.pollingPool.pool.get(username);

                if (updatedConnInfo) {

                    updatedConnInfo.status = 'ERROR';

                    updatedConnInfo.lastActivity = Date.now();

                    imapLogger.error(`[ConnectionManager] polling connection reconnect failed`, error);

                }

            });

        }, delay);

    },



    _scheduleNormalEmailReconnect(username, config) {

        let connInfo = this.normalEmailPool.pool.get(username);

        if (!connInfo) return;

        const imapLogger = ImapLogger.getInstance(username);



        // Prevent duplicate reconnections: check if a reconnection is already in progress

        if (connInfo.reconnectScheduled) {

            imapLogger.debug(`[ConnectionManager] regular mail connection reconnect already planned, skip duplicate request: ${username}`);

            return;

        }

        connInfo.reconnectScheduled = true;



        if (connInfo.retryCount >= this.maxRetries) {

            imapLogger.error(`[ConnectionManager] regular mail connection too many reconnect failures (${connInfo.retryCount}times), enter backoff mode: ${username}`);



            imapLogger.info(`[ConnectionManager] regular mail connection will in ${Math.round(this.backoffDuration/1000/60)} minutes then retry reconnect: ${username}`);



            setTimeout(() => {

                connInfo.reconnectScheduled = false;

                connInfo.retryCount = 0;

                connInfo.status = 'RECONNECTING';

                imapLogger.info(`[ConnectionManager] regular mail connection backoff period ended, trying to reconnect: ${username}`);

                const newConnPromise = this.normalEmailPool._createConnection(config);

                connInfo.connectPromise = newConnPromise;



                newConnPromise.then((result) => {

                    const updatedConnInfo = this.normalEmailPool.pool.get(username);

                    if (updatedConnInfo) {

                        updatedConnInfo.status = 'CONNECTED';

                        updatedConnInfo.lastActivity = Date.now();

                        imapLogger.info(`[ConnectionManager] regular mail connection reconnect succeeded after backoff`);

                    }

                }).catch((error) => {

                    const updatedConnInfo = this.normalEmailPool.pool.get(username);

                    if (updatedConnInfo) {

                        updatedConnInfo.status = 'ERROR';

                        updatedConnInfo.lastActivity = Date.now();

                        imapLogger.error(`[ConnectionManager] regular mail connection reconnect failed after backoff`, error);

                    }

                });

            }, this.backoffDuration);



            return;

        }



        connInfo.retryCount++;

        connInfo.status = 'RECONNECTING';



        const baseDelay = Math.min(

            this.baseRetryDelay * Math.pow(this.backoffMultiplier, connInfo.retryCount - 1),

            this.maxRetryDelay

        );



        const jitter = baseDelay * this.jitterRange * (Math.random() * 2 - 1);

        const delay = Math.max(baseDelay + jitter, 1000);



        imapLogger.info(`[ConnectionManager] regular mail connection ${connInfo.retryCount}/${this.maxRetries} - will in ${Math.round(delay)}ms then reconnect: ${username}`);



        setTimeout(() => {

            connInfo.reconnectScheduled = false;

            imapLogger.info(`[ConnectionManager] started reconnecting regular mail connection (No. ${connInfo.retryCount} attempt): ${username}`);

            const newConnPromise = this.normalEmailPool._createConnection(config);

            connInfo.connectPromise = newConnPromise;



            newConnPromise.then((result) => {

                const updatedConnInfo = this.normalEmailPool.pool.get(username);

                if (updatedConnInfo) {

                    updatedConnInfo.status = 'CONNECTED';

                    updatedConnInfo.lastActivity = Date.now();

                    imapLogger.info(`[ConnectionManager] regular mail connection reconnect succeeded`);

                }

            }).catch((error) => {

                const updatedConnInfo = this.normalEmailPool.pool.get(username);

                if (updatedConnInfo) {

                    updatedConnInfo.status = 'ERROR';

                    updatedConnInfo.lastActivity = Date.now();

                    imapLogger.error(`[ConnectionManager] regular mail connection reconnect failed`, error);

                }

            });

        }, delay);

    },



    _endThenDestroy(imap, username, label) {

        if (!imap) return;



        let done = false;

        const finish = () => {

            if (done) return;

            done = true;

            clearTimeout(timer);

        };



        const timer = setTimeout(() => {

            if (done) return;

            done = true;

            try {

                imap.destroy();

                const imapLogger = ImapLogger.getInstance(username);

                imapLogger.debug(`[ConnectionManager] ${label} endtimeout, connection force destroyed: ${username}`);

            } catch (error) {

                const imapLogger = ImapLogger.getInstance(username);

                imapLogger.error(`[ConnectionManager] ${label} force destroy connection failed: ${username}`, error);

            }

        }, 5000);



        try {

            imap.once('end', finish);

            imap.once('close', finish);

            imap.end();

        } catch (error) {

            finish();

            try {

                imap.destroy();

                const imapLogger = ImapLogger.getInstance(username);

                imapLogger.debug(`[ConnectionManager] ${label} endcall exception, connection force destroyed: ${username}`);

            } catch (destroyErr) {

                const imapLogger = ImapLogger.getInstance(username);

                imapLogger.error(`[ConnectionManager] ${label} force destroy connection failed: ${username}`, destroyErr);

            }

        }

    }

};



module.exports = { ImapReconnectManager };

