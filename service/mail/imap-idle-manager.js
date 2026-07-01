const ImapLogger = require('./imap-logger');

const logger = require('../logger');

const { getInstance } = require('./email-parser-manager');



/**

 * IMAP IDLE management and email pull module

 * Responsible for IDLE mode management and email pull loop

 */

const ImapIdleManager = {



    _logImapProperties(username, imap) {

        const imapLogger = ImapLogger.getInstance(username);

        imapLogger.debug(`[ConnectionManager] imapall properties of object:`, Object.keys(imap));

        imapLogger.debug(`[ConnectionManager] imap._host:`, imap._host);

        imapLogger.debug(`[ConnectionManager] imap.state:`, imap.state);

        imapLogger.debug(`[ConnectionManager] server capability list (serverCapabilities):`, imap.serverCapabilities);

        imapLogger.debug(`[ConnectionManager] server capability list (_capabilities):`, imap._capabilities);

        imapLogger.debug(`[ConnectionManager] server capability list (capabilities):`, imap.capabilities);



        if (imap._capability) {

            imapLogger.debug(`[ConnectionManager] server capability list (_capability):`, imap._capability);

        }

    },



    _sendImapId(imap, username, callback) {

        const appInfo = {

            name: 'Thunderbird',

            version: '115.0',

            vendor: 'Mozilla',

            support_url: 'https://support.mozilla.org/'

        };

        const imapLogger = ImapLogger.getInstance(username);



        imap.id(appInfo, (err) => {

            if (err) {

                imapLogger.error(`[ConnectionManager] send IMAP ID failed`, err);

            } else {

                imapLogger.info(`[ConnectionManager] IMAP ID info sent`, appInfo);

            }

            callback();

        });

    },



    _detectIdleSupport(imap) {

        let hasIdleInCapabilities = false;

        let detectionMethod1 = false;

        let detectionMethod2 = false;

        let detectionMethod3 = false;

        let detectionMethod4 = false;



        detectionMethod1 = imap.serverSupports('IDLE');

        hasIdleInCapabilities = detectionMethod1;



        if (imap._caps && Array.isArray(imap._caps)) {

            detectionMethod2 = imap._caps.some(cap => cap && cap === 'IDLE');

            if (!hasIdleInCapabilities) {

                hasIdleInCapabilities = detectionMethod2;

            }

        }



        if (imap.serverCapabilities && Array.isArray(imap.serverCapabilities)) {

            detectionMethod3 = imap.serverCapabilities.some(cap => cap && cap.toUpperCase() === 'IDLE');

        }



        if (imap.capabilities && Array.isArray(imap.capabilities)) {

            detectionMethod4 = imap.capabilities.some(cap => cap && cap.toUpperCase() === 'IDLE');

        }



        return {

            method1: detectionMethod1,

            method2: detectionMethod2,

            method3: detectionMethod3,

            method4: detectionMethod4,

            hasIdleInCapabilities: this.idleEnabled && hasIdleInCapabilities

        };

    },



    _testIdleCommand(username, detectionResults, imap) {

        const connInfo = this.mainPool.pool.get(username);

        const imapLogger = ImapLogger.getInstance(username);

        if (!connInfo) {

            imapLogger.error(`[ConnectionManager] connection info does not exist`);

            return;

        }



        imapLogger.info(`[ConnectionManager] IDLEsupport detection result: APIsupport=${detectionResults.hasIdleInCapabilities}`);



        if (detectionResults.hasIdleInCapabilities) {

            imapLogger.info(`[ConnectionManager] ✓ server supports IDLE`);



            imapLogger.logIdleDetection({

                serverCapabilities: imap.serverCapabilities,

                _caps: imap._caps,

                capabilities: imap.capabilities,

                detectionMethod1: detectionResults.method1,

                detectionMethod2: detectionResults.method2,

                detectionMethod3: detectionResults.method3,

                detectionMethod4: detectionResults.method4,

                actualTest: true,

                hasIdle: true,

                mode: 'IDLEmode (node-imapauto management)',

                testResult: 'server declares supportIDLE'

            });



            connInfo.supportsIdle = true;

            this._startIdle(username);

        } else {

            imapLogger.info(`[ConnectionManager] ✗ server does not support IDLE`);



            imapLogger.logIdleDetection({

                serverCapabilities: imap.serverCapabilities,

                _caps: imap.capabilities,

                capabilities: imap.capabilities,

                detectionMethod1: detectionResults.method1,

                detectionMethod2: detectionResults.method2,

                detectionMethod3: detectionResults.method3,

                detectionMethod4: detectionResults.method4,

                actualTest: false,

                hasIdle: false,

                mode: 'heartbeat polling mode',

                error: 'server does not declare supportIDLE'

            });



            connInfo.supportsIdle = false;

            this.mainPool._startHeartbeat(username);

        }

    },



    _testDeleteIdleCommand(username, detectionResults, imap) {

        const connInfo = this.deletePool.pool.get(username);

        const imapLogger = ImapLogger.getInstance(username);

        if (!connInfo) {

            imapLogger.error(`[ConnectionManager] delete connection info does not exist`);

            return;

        }



        imapLogger.info(`[ConnectionManager] delete connectionIDLEsupport detection result: APIsupport=${detectionResults.hasIdleInCapabilities}`);



        if (detectionResults.hasIdleInCapabilities) {

            imapLogger.info(`[ConnectionManager] ✓ delete connection server supports IDLE`);



            connInfo.supportsIdle = true;

            this._startDeleteIdle(username);

        } else {

            imapLogger.info(`[ConnectionManager] ✗ delete connection server does not support IDLE`);



            connInfo.supportsIdle = false;

            this.deletePool._startHeartbeat(username);

        }

    },



    _testFetchBodyIdleCommand(username, detectionResults, imap) {

        const connInfo = this.fetchBodyPool.pool.get(username);

        const imapLogger = ImapLogger.getInstance(username);

        if (!connInfo) {

            imapLogger.error(`[ConnectionManager] body download connection info does not exist`);

            return;

        }



        imapLogger.info(`[ConnectionManager] body download connectionIDLEsupport detection result: APIsupport=${detectionResults.hasIdleInCapabilities}`);



        if (detectionResults.hasIdleInCapabilities) {

            imapLogger.info(`[ConnectionManager] ✓ body download connection server supports IDLE`);



            connInfo.supportsIdle = true;

            this._startFetchBodyIdle(username);

        } else {

            imapLogger.info(`[ConnectionManager] ✗ body download connection server does not support IDLE`);



            connInfo.supportsIdle = false;

            this.fetchBodyPool._startHeartbeat(username);

        }

    },



    _startIdle(username) {

        const connInfo = this.mainPool.pool.get(username);

        if (!connInfo || !connInfo.imap) {

            return;

        }



        this.mainPool._stopHeartbeat(username);



        try {

            if (connInfo.imap.listeners('mail').length === 0) {

                connInfo.imap.on('mail', (numNewMsgs) => {

                    const imapLogger = ImapLogger.getInstance(username);

                    imapLogger.info(`[ConnectionManager] received new mail notification: ${username}, count: ${numNewMsgs}`);

                    connInfo.lastActivity = Date.now();

                    ImapLogger.getInstance(username).logNewMail(numNewMsgs);



                    try {

                        if (global.mainWindow && global.mainWindow.webContents) {

                            const hasAttachments = numNewMsgs > 0;

                            global.mainWindow.webContents.send('imap-new-mail', {

                                username: username,

                                numNewMsgs: numNewMsgs,

                                hasAttachments: hasAttachments

                            });

                            imapLogger.info(`[ConnectionManager] notified renderer process of new mail: ${username}, count: ${numNewMsgs}, hasAttachments: ${hasAttachments}`);

                        }

                    } catch (error) {

                        imapLogger.error(`[ConnectionManager] failed to notify renderer process of new mail: ${username}`, error);

                    }

                });

            }



            if (connInfo.imap.listeners('update').length === 0) {

                connInfo.imap.on('update', (seqno, info) => {

                    const imapLogger = ImapLogger.getInstance(username);

                    imapLogger.info(`[ConnectionManager] mailbox updated: ${username}`);

                    connInfo.lastActivity = Date.now();

                });

            }



            connInfo.idleEnabled = true;

            const imapLogger = ImapLogger.getInstance(username);

            imapLogger.info(`[ConnectionManager] IDLE mode activated (by node-imap auto management): ${username}`);



            ImapLogger.getInstance(username).logIdleStart(true);



        } catch (error) {

            const imapLogger = ImapLogger.getInstance(username);

            imapLogger.error(`[ConnectionManager] start IDLE mode failed: ${username}`, error);

            connInfo.supportsIdle = false;

            connInfo.idleEnabled = false;



            ImapLogger.getInstance(username).logIdleStart(false, error.message);



            this.mainPool._startHeartbeat(username);

        }

    },



    _startDeleteIdle(username) {

        const connInfo = this.deletePool.pool.get(username);

        if (!connInfo || !connInfo.imap) {

            return;

        }



        this.deletePool._stopHeartbeat(username);



        try {

            if (connInfo.imap.listeners('update').length === 0) {

                connInfo.imap.on('update', (seqno, info) => {

                    const imapLogger = ImapLogger.getInstance(username);

                    imapLogger.info(`[ConnectionManager] delete connection mailbox updated: ${username}`);

                    connInfo.lastActivity = Date.now();

                });

            }



            connInfo.idleEnabled = true;

            const imapLogger = ImapLogger.getInstance(username);

            imapLogger.info(`[ConnectionManager] delete connection IDLE mode activated (by node-imap auto management): ${username}`);



        } catch (error) {

            const imapLogger = ImapLogger.getInstance(username);

            imapLogger.error(`[ConnectionManager] started delete connection IDLE mode failed: ${username}`, error);

            connInfo.supportsIdle = false;

            connInfo.idleEnabled = false;



            this.deletePool._startHeartbeat(username);

        }

    },



    _startFetchBodyIdle(username) {

        const connInfo = this.fetchBodyPool.pool.get(username);

        if (!connInfo || !connInfo.imap) {

            return;

        }



        this.fetchBodyPool._stopHeartbeat(username);



        try {

            if (connInfo.imap.listeners('update').length === 0) {

                connInfo.imap.on('update', (seqno, info) => {

                    const imapLogger = ImapLogger.getInstance(username);

                    imapLogger.info(`[ConnectionManager] body download connection mailbox updated: ${username}`);

                    connInfo.lastActivity = Date.now();

                });

            }



            connInfo.idleEnabled = true;

            const imapLogger = ImapLogger.getInstance(username);

            imapLogger.info(`[ConnectionManager] body download connection IDLE mode activated (by node-imap auto management): ${username}`);



        } catch (error) {

            const imapLogger = ImapLogger.getInstance(username);

            imapLogger.error(`[ConnectionManager] started body download connection IDLE mode failed: ${username}`, error);

            connInfo.supportsIdle = false;

            connInfo.idleEnabled = false;



            this.fetchBodyPool._startHeartbeat(username);

        }

    },



    _stopIdle(username) {

        const connInfo = this.mainPool.pool.get(username);

        if (connInfo && connInfo.imap) {

            try {

                connInfo.imap.removeAllListeners('mail');

                connInfo.imap.removeAllListeners('update');



                connInfo.idleEnabled = false;

                const imapLogger = ImapLogger.getInstance(username);

                imapLogger.info(`[ConnectionManager] IDLE mode stopped: ${username}`);

            } catch (error) {

                const imapLogger = ImapLogger.getInstance(username);

                imapLogger.error(`[ConnectionManager] stop IDLE error occurred: ${username}`, error);

            }

        }

    },



    _stopDeleteIdle(username) {

        const connInfo = this.deletePool.pool.get(username);

        if (connInfo && connInfo.imap) {

            try {

                connInfo.imap.removeAllListeners('update');



                connInfo.idleEnabled = false;

                const imapLogger = ImapLogger.getInstance(username);

                imapLogger.info(`[ConnectionManager] delete connection IDLE mode stopped: ${username}`);

            } catch (error) {

                const imapLogger = ImapLogger.getInstance(username);

                imapLogger.error(`[ConnectionManager] stopped delete connection IDLE error occurred: ${username}`, error);

            }

        }

    },



    _stopFetchBodyIdle(username) {

        const connInfo = this.fetchBodyPool.pool.get(username);

        if (connInfo && connInfo.imap) {

            try {

                connInfo.imap.removeAllListeners('update');



                connInfo.idleEnabled = false;

                const imapLogger = ImapLogger.getInstance(username);

                imapLogger.info(`[ConnectionManager] body download connection IDLE mode stopped: ${username}`);

            } catch (error) {

                const imapLogger = ImapLogger.getInstance(username);

                imapLogger.error(`[ConnectionManager] stopped body download connection IDLE error occurred: ${username}`, error);

            }

        }

    },



    _renewIdle(username) {

        // reserved method，for future extension

    },



    _startPollingHeartbeat(username) {

        const connInfo = this.pollingPool.pool.get(username);

        if (!connInfo) return;



        this.pollingPool._stopHeartbeat(username);



        const timer = setInterval(() => {

            const pollConnInfo = this.pollingPool.pool.get(username);

            if (!pollConnInfo || pollConnInfo.status !== 'CONNECTED') {

                this.pollingPool._stopHeartbeat(username);

                return;

            }



            if (pollConnInfo.imap && pollConnInfo.imap.__mailinkBusy) {

                return;

            }



            try {

                if (!pollConnInfo.imap || typeof pollConnInfo.imap.noop !== 'function') {

                    const imapLogger = ImapLogger.getInstance(username);

                    imapLogger.warn(`[ConnectionManager] polling connectionimapobject invalid, skipped heartbeat: ${username}`);

                    this.pollingPool._stopHeartbeat(username);

                    return;

                }



                pollConnInfo.imap.noop((err) => {

                    const imapLogger = ImapLogger.getInstance(username);

                    if (err) {

                        imapLogger.error(`[ConnectionManager] polling connection heartbeat failed: ${username}`, err);

                    } else {

                        imapLogger.info(`[ConnectionManager] polling connection heartbeat succeeded: ${username}`);

                        pollConnInfo.lastActivity = Date.now();

                    }

                });

            } catch (error) {

                const imapLogger = ImapLogger.getInstance(username);

                imapLogger.error(`[ConnectionManager] polling connection heartbeat exception: ${username}`, error);

            }

        }, this.heartbeatInterval);



        this.pollingPool.heartbeatTimers.set(username, timer);

        const imapLogger = ImapLogger.getInstance(username);

        imapLogger.info(`[ConnectionManager] polling connection heartbeat started: ${username}`);

    },



    _stopPollingHeartbeat(username) {

        this.pollingPool._stopHeartbeat(username);

    },



    _startFetchLoop(username) {

        if (this.fetchLoopTimers.has(username)) {

            const imapLogger = ImapLogger.getInstance(username);

            imapLogger.debug(`[ConnectionManager] pull loop already running: ${username}`);

            return;

        }



        if (!this.fetchLoopEnabled) {

            const imapLogger = ImapLogger.getInstance(username);

            imapLogger.info(`[ConnectionManager] pull loop disabled, skipped start: ${username}`);

            return;

        }



        const imapLogger = ImapLogger.getInstance(username);

        imapLogger.info(`[ConnectionManager] started pull loop: ${username}, timeout: ${this.fetchTimeout}ms, paused: ${this.fetchPauseInterval}ms`);



        this._fetchLoopIteration(username);

    },



    _stopFetchLoop(username) {

        if (this.fetchLoopTimers.has(username)) {

            clearTimeout(this.fetchLoopTimers.get(username));

            this.fetchLoopTimers.delete(username);

            const imapLogger = ImapLogger.getInstance(username);

            imapLogger.info(`[ConnectionManager] stopped pull loop: ${username}`);

        }



        if (this.fetchTimeoutTimers.has(username)) {

            clearTimeout(this.fetchTimeoutTimers.get(username));

            this.fetchTimeoutTimers.delete(username);

        }

    },



    _searchEmails(imap, criteria) {

        return new Promise((resolve, reject) => {

            imap.search(criteria, (err, results) => {

                if (err) {

                    reject(new Error(`Email search failed: ${err.message}`));

                } else {

                    resolve(results);

                }

            });

        });

    },



    _fetchEmails(imap, results, options) {

        return new Promise((resolve, reject) => {

            if (results.length === 0) {

                resolve([]);

                return;

            }



            results.sort((a, b) => a - b);



            const f = imap.fetch(results, options);



            const emailPromises = [];

            const uidArray = [...results];

            let messageIndex = 0;



            const fetchTimeout = setTimeout(() => {

                logger.warn('Email fetch timeout, resolving with completed emails');

                Promise.allSettled(emailPromises)

                    .then(results => {

                        const completedEmails = results

                            .filter(result => result.status === 'fulfilled' && result.value)

                            .map(result => result.value);

                        resolve(completedEmails);

                    })

                    .catch(() => {

                        resolve([]);

                    });

            }, this.fetchTimeout);



            f.on('message', (msg) => {

                const uid = uidArray[messageIndex];

                messageIndex++;



                const emailPromise = new Promise(async (resolveEmail) => {

                    const emailTimeout = setTimeout(() => {

                        logger.warn(`Email processing timeout for UID: ${uid}`);

                        resolveEmail(null);

                    }, 10000);



                    try {

                        let streamBuffer = Buffer.alloc(0);



                        msg.on('body', (stream) => {

                            stream.on('data', (chunk) => {

                                streamBuffer = Buffer.concat([streamBuffer, chunk]);

                            });



                            stream.on('end', async () => {

                                try {

                                    const emailParserManager = getInstance();

                                    const emailData = await emailParserManager.parseEmail(streamBuffer, uid, {

                                        timeout: 10000

                                    });



                                    clearTimeout(emailTimeout);

                                    resolveEmail(emailData);

                                } catch (parseErr) {

                                    logger.error(`Email parsing failed for UID ${uid}:`, parseErr);

                                    clearTimeout(emailTimeout);

                                    resolveEmail(null);

                                }

                            });

                        });



                        msg.once('attributes', () => {

                            // reserved handling

                        });



                        msg.once('end', () => {

                            // reserved handling

                        });

                    } catch (err) {

                        logger.error(`Error processing email UID ${uid}:`, err);

                        clearTimeout(emailTimeout);

                        resolveEmail(null);

                    }

                });



                emailPromises.push(emailPromise);

            });



            f.once('error', (err) => {

                clearTimeout(fetchTimeout);

                logger.error('Failed to fetch email data:', err);

                reject(new Error(`Failed to fetch email data: ${err.message}`));

            });



            f.once('end', () => {

                clearTimeout(fetchTimeout);

                logger.debug(`Fetch end event received, processing ${emailPromises.length} email promises`);



                Promise.all(emailPromises)

                    .then(emailResults => {

                        const validEmails = emailResults.filter(email => email !== null);

                        logger.debug(`Fetched ${validEmails.length} emails successfully`);

                        resolve(validEmails);

                    })

                    .catch(err => {

                        logger.error('Error in email processing promises:', err);

                        resolve([]);

                    });

            });

        });

    },



    async _fetchLoopIteration(username) {

        const connInfo = this.pollingPool.pool.get(username);

        const imapLogger = ImapLogger.getInstance(username);



        if (!connInfo || connInfo.status !== 'CONNECTED' || !connInfo.imap) {

            imapLogger.debug(`[ConnectionManager] connection unavailable, stopped pull loop: ${username}`);

            this._stopFetchLoop(username);

            return;

        }



        try {

            imapLogger.debug(`[ConnectionManager] started fetching emails: ${username}`);



            const timeoutPromise = new Promise((_, reject) => {

                const timeoutId = setTimeout(() => {

                    reject(new Error(`fetch timeout (${this.fetchTimeout}ms)`));

                }, this.fetchTimeout);

                this.fetchTimeoutTimers.set(username, timeoutId);

            });



            const fetchPromise = new Promise(async (resolve, reject) => {

                try {

                    const date = new Date();

                    date.setMinutes(date.getMinutes() - 2);



                    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

                    const day = date.getDate().toString().padStart(2, '0');

                    const month = months[date.getMonth()];

                    const year = date.getFullYear();

                    const dateString = `${day}-${month}-${year}`;



                    const searchCriteria = [

                        ['SINCE', dateString],

                        ['UNSEEN']

                    ];



                    const fetchOptions = {

                        bodies: '',

                        struct: true,

                        markSeen: false  // Regular emails are not automatically marked as read

                    };



                    const results = await this._searchEmails(connInfo.imap, searchCriteria);

                    imapLogger.debug(`[ConnectionManager] searched ${results.length} new emails: ${username}`);



                    if (results.length === 0) {

                        resolve({ success: true, message: 'No new emails', emailCount: 0 });

                        return;

                    }



                    const emails = await this._fetchEmails(connInfo.imap, results, fetchOptions);

                    imapLogger.info(`[ConnectionManager] successfully fetched ${emails.length} emails: ${username}`);



                    connInfo.lastActivity = Date.now();



                    resolve({

                        success: true,

                        message: `Fetched ${emails.length} emails successfully`,

                        emailCount: emails.length

                    });

                } catch (err) {

                    reject(new Error(`fetch process exception: ${err.message}`));

                }

            });



            const result = await Promise.race([fetchPromise, timeoutPromise]);

            imapLogger.debug(`[ConnectionManager] fetch succeeded: ${username}, result:`, result);



        } catch (error) {

            imapLogger.error(`[ConnectionManager] fetch failed: ${username}, error:`, error);



            if (connInfo) {

                connInfo.lastActivity = Date.now();

            }

        } finally {

            if (this.fetchTimeoutTimers.has(username)) {

                clearTimeout(this.fetchTimeoutTimers.get(username));

                this.fetchTimeoutTimers.delete(username);

            }



            const nextIterationTimer = setTimeout(() => {

                this._fetchLoopIteration(username);

            }, this.fetchPauseInterval);



            this.fetchLoopTimers.set(username, nextIterationTimer);

        }

    }

};



module.exports = { ImapIdleManager };

