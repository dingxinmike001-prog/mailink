/**

 * IMAP flag sync manager

 * Manages Worker lifecycle, task queue, and async tasks

 * 

 * Features:

 * - Reuses a single Worker instance to avoid frequent creation/destruction overhead

 * - Supports task queue and priority handling

 * - Includes error handling and fallback mechanism

 * - Provides performance monitoring statistics

 */

const { Worker } = require('worker_threads');

const path = require('path');

const logger = require('../logger');



/**

 * IMAP flag sync manager

 */

class IMAPFlagsSyncManager {

    constructor() {

        this.worker = null;

        this.pendingTasks = new Map(); // taskId -> {resolve, reject, timeout, startTime}

        this.taskQueue = []; // Task queue for concurrency control

        this.isReady = false;

        this.isProcessing = false; // Whether the queue is being processed

        this.maxPendingTasks = 100; // Prevent memory leak

        this.maxConcurrentTasks = 1; // Maximum concurrent tasks (reduced to 1 to avoid server pressure)

        this.activeTasks = 0; // Current active task count

        this.taskIdCounter = 0; // Task ID counter



        // Performance statistics

        this.stats = {

            totalTasks: 0,

            successfulTasks: 0,

            failedTasks: 0,

            totalBatchSync: 0,

            totalFetch: 0,

            averageTaskTime: 0,

            taskTimes: [] // Used for average calculation, keep at most 100 entries

        };



        this.maxTaskTimeout = 60000; // Maximum task timeout



        // [Optimization] Retry configuration

        this.retryConfig = {

            maxRetries: 3, // Maximum retry count

            baseDelay: 1000, // Base delay (milliseconds)

            maxDelay: 10000, // Maximum delay (milliseconds)

            backoffMultiplier: 2 // Backoff multiplier

        };



        this.initWorker();

    }



    /**

     * [Optimization] Calculate retry delay (exponential backoff)

     * @private

     * @param {number} retryCount - Current retry count

     * @returns {number} Delay (milliseconds)

     */

    _calculateRetryDelay(retryCount) {

        const delay = this.retryConfig.baseDelay * Math.pow(this.retryConfig.backoffMultiplier, retryCount);

        return Math.min(delay, this.retryConfig.maxDelay);

    }



    /**

     * [Optimization] Send task with retry mechanism

     * @private

     * @param {Object} message - Task message

     * @param {number} retryCount - Current retry count

     * @returns {Promise<Object>} Task response

     */

    async _sendTaskWithRetry(message, retryCount = 0) {

        try {

            const response = await this._sendTask(message);

            

            // If task succeeds but returns failure and can retry

            if (!response.success && retryCount < this.retryConfig.maxRetries) {

                const delay = this._calculateRetryDelay(retryCount);

                logger.warn(`[IMAPFlagsSyncManager] task failed, ${delay}ms after No. ${retryCount + 1} retry...`);

                

                await new Promise(resolve => setTimeout(resolve, delay));

                return this._sendTaskWithRetry(message, retryCount + 1);

            }

            

            return response;

        } catch (error) {

            // If an exception occurs and can retry

            if (retryCount < this.retryConfig.maxRetries) {

                const delay = this._calculateRetryDelay(retryCount);

                logger.warn(`[IMAPFlagsSyncManager] task exception: ${error.message}, ${delay}ms after No. ${retryCount + 1} retry...`);

                

                await new Promise(resolve => setTimeout(resolve, delay));

                return this._sendTaskWithRetry(message, retryCount + 1);

            }

            

            // Retries exhausted, throw error

            logger.error(`[IMAPFlagsSyncManager] task retry ${this.retryConfig.maxRetries} times still failed: ${error.message}`);

            throw error;

        }

    }



    /**

     * Initialize Worker

     * @private

     */

    initWorker() {

        try {

            logger.info('[IMAPFlagsSyncManager] Initializing IMAP Flags Sync Worker');



            this.worker = new Worker(

                path.join(__dirname, 'workers', 'imap-flags-sync.worker.js')

            );



            // Listen to Worker messages

            this.worker.on('message', (response) => {

                // Process log messages

                if (response.type === 'log') {

                    const { level, message } = response;

                    if (level === 'error') {

                        logger.error(message);

                    } else if (level === 'warn') {

                        logger.warn(message);

                    } else if (level === 'info') {

                        logger.info(message);

                    } else {

                        logger.debug(message);

                    }

                    return;

                }



                // Process task response

                this._handleTaskResponse(response);

            });



            // Error handling

            this.worker.on('error', (error) => {

                logger.error(`[IMAPFlagsSyncManager] Worker error: ${error.message}`);

                this._handleWorkerError(error);

            });



            // Worker exit handling

            this.worker.on('exit', (code) => {

                if (code !== 0) {

                    logger.error(

                        `[IMAPFlagsSyncManager] Worker exited with code ${code}`

                    );

                }

                this.isReady = false;

                logger.warn('[IMAPFlagsSyncManager] Worker stopped, will restart on next task');

            });



            this.isReady = true;

            logger.info('[IMAPFlagsSyncManager] IMAP Flags Sync Worker initialized');

        } catch (error) {

            logger.error(

                `[IMAPFlagsSyncManager] Failed to initialize worker: ${error.message}`

            );

            this.isReady = false;

        }

    }



    /**

     * Process Worker response

     * @private

     */

    _handleTaskResponse(response) {

        const { id } = response;



        if (!this.pendingTasks.has(id)) {

            logger.warn(

                `[IMAPFlagsSyncManager] Received response for unknown task: ${id}`

            );

            return;

        }



        const task = this.pendingTasks.get(id);

        const taskTime = Date.now() - task.startTime;



        // Clean up timeout timer

        if (task.timeout) {

            clearTimeout(task.timeout);

        }



        // Remove pending task

        this.pendingTasks.delete(id);

        this.activeTasks--;



        // Update statistics

        this._updateStats(taskTime, response.success);



        // Return result

        if (response.success) {

            this.stats.successfulTasks++;

            task.resolve(response);

        } else {

            this.stats.failedTasks++;

            task.reject(new Error(response.error || 'Task failed'));

        }



        // Process the next task in the queue

        this._processQueue();

    }



    /**

     * Process Worker error

     * @private

     */

    _handleWorkerError(error) {

        // Reject all pending tasks

        for (const [id, task] of this.pendingTasks.entries()) {

            if (task.timeout) {

                clearTimeout(task.timeout);

            }

            this.stats.failedTasks++;

            task.reject(error);

        }



        this.pendingTasks.clear();

        this.activeTasks = 0;

        this.taskQueue = [];



        // Try to restart Worker

        setTimeout(() => {

            if (!this.isReady) {

                logger.info('[IMAPFlagsSyncManager] Attempting to restart Worker');

                this.initWorker();

            }

        }, 1000);

    }



    /**

     * Update statistics

     * @private

     */

    _updateStats(taskTime, success) {

        this.stats.totalTasks++;



        // Keep last 100 task times for average calculation

        this.stats.taskTimes.push(taskTime);

        if (this.stats.taskTimes.length > 100) {

            this.stats.taskTimes.shift();

        }



        // Calculate average task time

        if (this.stats.taskTimes.length > 0) {

            const sum = this.stats.taskTimes.reduce((a, b) => a + b, 0);

            this.stats.averageTaskTime = Math.round(sum / this.stats.taskTimes.length);

        }

    }



    /**

     * Generate task ID

     * @private

     */

    _generateTaskId() {

        return `task-${++this.taskIdCounter}-${Date.now()}`;

    }



    /**

     * Process tasks in queue

     * @private

     */

    _processQueue() {

        if (this.isProcessing || !this.isReady) {

            return;

        }



        this.isProcessing = true;



        while (this.taskQueue.length > 0 && this.activeTasks < this.maxConcurrentTasks) {

            const queuedTask = this.taskQueue.shift();

            this._executeTask(queuedTask.message, queuedTask.resolve, queuedTask.reject);

        }



        this.isProcessing = false;

    }



    /**

     * Execute single task

     * @private

     */

    _executeTask(message, resolve, reject) {

        const taskId = this._generateTaskId();

        message.id = taskId;



        this.activeTasks++;



        const timeout = setTimeout(() => {

            this.pendingTasks.delete(taskId);

            this.activeTasks--;

            this.stats.failedTasks++;

            reject(new Error(`Task timeout (${this.maxTaskTimeout}ms): ${taskId}`));

            this._processQueue(); // Process the next task in the queue

        }, this.maxTaskTimeout);



        this.pendingTasks.set(taskId, {

            resolve,

            reject,

            timeout,

            startTime: Date.now()

        });



        try {

            this.worker.postMessage(message);

        } catch (error) {

            this.pendingTasks.delete(taskId);

            clearTimeout(timeout);

            this.activeTasks--;

            reject(error);

            this._processQueue(); // Process the next task in the queue

        }

    }



    /**

     * Send task to Worker (with queue control)

     * @private

     */

    _sendTask(message) {

        return new Promise((resolve, reject) => {

            if (!this.isReady) {

                reject(new Error('Worker is not ready'));

                return;

            }



            if (this.pendingTasks.size >= this.maxPendingTasks) {

                reject(

                    new Error(

                        `Too many pending tasks (${this.maxPendingTasks}), please retry later`

                    )

                );

                return;

            }



            // Add task to queue

            this.taskQueue.push({ message, resolve, reject });

            

            // Try to process queue

            this._processQueue();

        });

    }



    /**

     * [Optimization] Sync a single email's flag status to server (with retry mechanism)

     * @param {Object} config - IMAP config {username, password, host, port, tls}

     * @param {string|number} uid - Email UID

     * @param {string} action - Operation type ('addSeen' | 'delSeen')

     * @param {string} mailbox - Mailbox folder (default: 'INBOX')

     * @returns {Promise<boolean>} Whether sync succeeded

     */

    async syncSingleFlag(config, uid, action = 'addSeen', mailbox = 'INBOX') {

        if (!config || !config.username) {

            throw new Error('[IMAPFlagsSyncManager] Invalid config provided');

        }



        if (!uid) {

            throw new Error('[IMAPFlagsSyncManager] No UID provided');

        }



        if (!['addSeen', 'delSeen'].includes(action)) {

            throw new Error(`[IMAPFlagsSyncManager] Invalid action: ${action}`);

        }



        try {

            // [Optimization] use version with retry

            const response = await this._sendTaskWithRetry({

                type: 'syncSingleFlag',

                username: config.username,

                password: config.password,

                host: config.host,

                port: config.port,

                tls: config.tls,

                uid: String(uid),

                action,

                mailbox

            });



            return response.success;

        } catch (error) {

            logger.error(

                `[IMAPFlagsSyncManager] Failed to sync single flag after retries: ${error.message}`

            );

            throw error;

        }

    }



    /**

     * [Optimization] Batch sync email flag statuses to server (with retry mechanism)

     * @param {Object} config - IMAP config {username, password, host, port, tls}

     * @param {Array<string|number>} uids - Email UID array

     * @param {string} action - Operation type ('addSeen' | 'delSeen')

     * @param {string} mailbox - Mailbox folder (default: 'INBOX')

     * @returns {Promise<{success: boolean, syncedCount: number, failedCount: number}>}

     */

    async batchSyncFlags(

        config,

        uids,

        action = 'addSeen',

        mailbox = 'INBOX'

    ) {

        if (!config || !config.username) {

            throw new Error('[IMAPFlagsSyncManager] Invalid config provided');

        }



        if (!Array.isArray(uids) || uids.length === 0) {

            logger.debug('[IMAPFlagsSyncManager] No UIDs provided for batch sync');

            return { success: true, syncedCount: 0, failedCount: 0 };

        }



        if (!['addSeen', 'delSeen'].includes(action)) {

            throw new Error(`[IMAPFlagsSyncManager] Invalid action: ${action}`);

        }



        try {

            this.stats.totalBatchSync++;



            // [Optimization] use version with retry

            const response = await this._sendTaskWithRetry({

                type: 'syncBatchFlags',

                username: config.username,

                password: config.password,

                host: config.host,

                port: config.port,

                tls: config.tls,

                uids: uids.map(uid => String(uid)),

                action,

                mailbox

            });



            return {

                success: response.success,

                syncedCount: response.syncedCount || 0,

                failedCount: response.failedCount || 0

            };

        } catch (error) {

            logger.error(

                `[IMAPFlagsSyncManager] Failed to batch sync flags after retries: ${error.message}`

            );

            throw error;

        }

    }



    /**

     * [Optimization] Fetch email flag statuses from server (with retry mechanism)

     * @param {Object} config - IMAP config {username, password, host, port, tls}

     * @param {Array<string|number>} uids - Email UID array

     * @param {string} mailbox - Mailbox folder (default: 'INBOX')

     * @returns {Promise<Array>} Email flag status array [{uid, seen}, ...]

     */

    async fetchFlags(config, uids, mailbox = 'INBOX') {

        if (!config || !config.username) {

            throw new Error('[IMAPFlagsSyncManager] Invalid config provided');

        }



        if (!Array.isArray(uids) || uids.length === 0) {

            logger.debug('[IMAPFlagsSyncManager] No UIDs provided for fetch');

            return [];

        }



        try {

            this.stats.totalFetch++;



            // [Optimization] use version with retry

            const response = await this._sendTaskWithRetry({

                type: 'fetchFlags',

                username: config.username,

                password: config.password,

                host: config.host,

                port: config.port,

                tls: config.tls,

                uids: uids.map(uid => String(uid)),

                mailbox

            });



            return response.statuses || [];

        } catch (error) {

            logger.error(

                `[IMAPFlagsSyncManager] Failed to fetch flags after retries: ${error.message}`

            );

            throw error;

        }

    }



    /**

     * Get performance statistics

     * @returns {Object} Statistics data

     */

    getStats() {

        return {

            ...this.stats,

            pendingTasks: this.pendingTasks.size,

            isWorkerReady: this.isReady

        };

    }



    /**

     * Reset statistics

     */

    resetStats() {

        this.stats = {

            totalTasks: 0,

            successfulTasks: 0,

            failedTasks: 0,

            totalBatchSync: 0,

            totalFetch: 0,

            averageTaskTime: 0,

            taskTimes: []

        };

        logger.info('[IMAPFlagsSyncManager] Performance stats reset');

    }



    /**

     * Gracefully close Worker

     * @param {number} timeout - Close timeout (ms)

     * @returns {Promise<void>}

     */

    async shutdown(timeout = 10000) {

        return new Promise((resolve) => {

            if (!this.worker) {

                resolve();

                return;

            }



            logger.info('[IMAPFlagsSyncManager] Shutting down IMAP Flags Sync Worker');



            // Set forced close timeout

            const shutdownTimeout = setTimeout(() => {

                logger.warn(

                    '[IMAPFlagsSyncManager] Worker shutdown timeout, force terminating'

                );

                this.worker.terminate().then(resolve).catch(resolve);

            }, timeout);



            // Close when all tasks complete

            if (this.pendingTasks.size === 0) {

                clearTimeout(shutdownTimeout);

                this.worker.terminate().then(resolve).catch(resolve);

            } else {

                // Wait for tasks to complete

                const checkInterval = setInterval(() => {

                    if (this.pendingTasks.size === 0) {

                        clearInterval(checkInterval);

                        clearTimeout(shutdownTimeout);

                        this.worker.terminate().then(resolve).catch(resolve);

                    }

                }, 100);

            }

        });

    }

}



// Singleton instance

let instance = null;



/**

 * Get IMAP flag sync manager singleton

 * @returns {IMAPFlagsSyncManager} Manager instance

 */

function getInstance() {

    if (!instance) {

        instance = new IMAPFlagsSyncManager();

    }

    return instance;

}



module.exports = {

    getInstance,

    IMAPFlagsSyncManager

};

