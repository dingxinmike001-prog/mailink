/**

 * Email deduplication manager

 * Tracks processed emails to avoid parsing the same email repeatedly

 * 

 * Supports two caching strategies:

 * 1. Map (default): simple and fast, FIFO eviction

 * 2. LRU (optional): smart cache, evicts based on access frequency, 20-30% performance improvement

 */

const logger = require('../logger');

const EmailDedupLRU = require('./cache/email-dedup-lru');

const { Worker } = require('worker_threads');

const path = require('path');



class EmailDedupManager {

    constructor(options = {}) {

        // Cache strategy selection: 'map' or 'lru'

        this.cacheStrategy = options.cacheStrategy || 'map';

        this.useLRU = this.cacheStrategy === 'lru';

        

        // Initialize cache according to strategy

        if (this.useLRU) {

            this.processedEmails = new EmailDedupLRU(options.maxSize || 10000);

            logger.info('email deduplication manager uses LRU cache strategy');

        } else {

            this.processedEmails = new Map();  // key -> timestamp

            logger.info('email deduplication manager uses Map cache strategy');

        }

        

        this.ttl = options.ttl || 86400000; // Default 24-hour expiration

        this.maxSize = options.maxSize || 10000; // Maximum cache count

        this.cleanupInterval = null;

        

        // Dedicated signaling email cache (always uses LRU to optimize signaling processing)

        this.signalingEmails = new EmailDedupLRU(options.signalingMaxSize || 5000);

        this.signalingTtl = options.signalingTtl || 600000;  // Default 10 minutes

        

        // Search result cache

        this.searchResultCache = new Map();

        this.SEARCH_CACHE_TTL = 2000; // Search result cache TTL 2 seconds

        this.SEARCH_CACHE_MAX_AGE = 2000; // Maximum lifetime of search result cache

        

        // Initialize Worker

        this.worker = null;

        this.workerReady = false;

        this.taskId = 0;

        this.taskCallbacks = new Map();

        this.initWorker();

        

        this.startCleanupTask();

    }



    /**

     * Initialize Worker

     */

    initWorker() {

        try {

            const workerPath = path.join(__dirname, 'workers', 'email-dedup.worker.js');

            this.worker = new Worker(workerPath);

            

            this.worker.on('message', (message) => {

                if (message.type === 'INITIALIZED') {

                    this.workerReady = true;

                    logger.info('email deduplication Worker initialization completed');

                } else if (message.type === 'log') {

                    logger[message.level](message.message);

                } else if (message.id) {

                    // Process task result

                    const callback = this.taskCallbacks.get(message.id);

                    if (callback) {

                        this.taskCallbacks.delete(message.id);

                        if (message.success) {

                            callback(null, message.data);

                        } else {

                            callback(new Error(message.error));

                        }

                    }

                }

            });

            

            this.worker.on('error', (error) => {

                logger.error('email deduplication Worker error:', error);

                this.workerReady = false;

                // Try to restart Worker

                setTimeout(() => this.initWorker(), 1000);

            });

            

            this.worker.on('exit', (code) => {

                logger.warn(`email deduplication Worker exit, code: ${code}`);

                this.workerReady = false;

                // Try to restart Worker

                setTimeout(() => this.initWorker(), 1000);

            });

            

            logger.info('email deduplication Worker starting...');

        } catch (error) {

            logger.error('email deduplication Worker initialization failed:', error);

            // Fallback to synchronous processing

            this.workerReady = false;

        }

    }



    /**

     * Send a task to the Worker

     * @param {string} type - Task type

     * @param {Object} data - Task data

     * @returns {Promise} Task result

     */

    sendTask(type, data) {

        return new Promise((resolve, reject) => {

            if (!this.workerReady || !this.worker) {

                // Worker not ready, use synchronous processing

                logger.warn('email deduplication Worker not ready, using synchronous processing');

                try {

                    let result;

                    switch (type) {

                        case 'BATCH_IS_PROCESSED':

                            result = this.batchIsProcessedSync(data.emails);

                            break;

                        case 'BATCH_MARK_AS_PROCESSED':

                            result = { success: true, count: data.emails.length };

                            this.batchMarkAsProcessedSync(data.emails);

                            break;

                        default:

                            throw new Error(`Unknown task type: ${type}`);

                    }

                    resolve(result);

                } catch (error) {

                    reject(error);

                }

                return;

            }

            

            const id = ++this.taskId;

            this.taskCallbacks.set(id, (error, result) => {

                if (error) {

                    reject(error);

                } else {

                    resolve(result);

                }

            });

            

            this.worker.postMessage({ id, type, data });

        });

    }



    /**

     * Generate a unique identifier for an email

     * @param {number|string} uid - Email UID

     * @param {string} messageId - Email Message-ID header

     * @param {string} subject - Email subject

     * @returns {string} Unique identifier

     */

    generateKey(uid, messageId, subject, from = '') {

        if (messageId) {

            return `msgid:${messageId}`;

        }

        return `uid:${uid}:${from}:${subject}`;

    }



    /**

     * Check whether the email has been processed

     * @param {number|string} uid - Email UID

     * @param {string} messageId - Email Message-ID header

     * @param {string} subject - Email subject

     * @returns {boolean} Whether it has been processed

     */

    isProcessed(uid, messageId, subject, from = '') {

        const key = this.generateKey(uid, messageId, subject, from);

        

        let timestamp;

        if (this.useLRU) {

            timestamp = this.processedEmails.get(key);

        } else {

            timestamp = this.processedEmails.get(key);

        }

        

        if (!timestamp) return false;

        

        // Check if expired

        if (Date.now() - timestamp > this.ttl) {

            this.processedEmails.delete(key);

            return false;

        }

        

        return true;

    }



    /**

     * Mark email as processed

     * @param {number|string} uid - Email UID

     * @param {string} messageId - Email Message-ID header

     * @param {string} subject - Email subject

     */

    markAsProcessed(uid, messageId, subject, from = '') {

        const key = this.generateKey(uid, messageId, subject, from);



        if (this.processedEmails.size >= this.maxSize) {

            logger.warn('Email dedup cache full, clearing oldest entries');

            this.clearOldest(1000);

        }



        // Store timestamp for expiration checks

        this.processedEmails.set(key, Date.now());

    }



    /**

     * Get search cache key

     * @param {string} username - User email

     * @param {boolean} onlySignaling - Whether to fetch only signaling emails

     * @param {number} minutes - Number of minutes to fetch

     * @returns {string} Cache key

     */

    getSearchCacheKey(username, onlySignaling, minutes) {

        return `search:${username}:${onlySignaling}:${minutes}`;

    }



    /**

     * Check search result cache

     * @param {string} username - User email

     * @param {boolean} onlySignaling - Whether to fetch only signaling emails

     * @param {number} minutes - Number of minutes to fetch

     * @returns {Array|null} Cached UID array or null

     */

    getSearchResultCache(username, onlySignaling, minutes) {

        const cacheKey = this.getSearchCacheKey(username, onlySignaling, minutes);

        const cached = this.searchResultCache.get(cacheKey);

        

        if (cached) {

            const now = Date.now();

            const age = now - cached.timestamp;

            

            if (age < this.SEARCH_CACHE_TTL) {

                logger.debug(`Search cache hit (age: ${age}ms), returning ${cached.uids.length} UIDs`);

                return cached.uids;

            } else {

                logger.debug(`Search cache expired (age: ${age}ms), removing`);

                this.searchResultCache.delete(cacheKey);

            }

        }

        

        return null;

    }



    /**

     * Set search result cache

     * @param {string} username - User email

     * @param {boolean} onlySignaling - Whether to fetch only signaling emails

     * @param {number} minutes - Number of minutes to fetch

     * @param {Array} uids - Email UID array

     */

    setSearchResultCache(username, onlySignaling, minutes, uids) {

        const cacheKey = this.getSearchCacheKey(username, onlySignaling, minutes);

        

        if (this.searchResultCache.size >= 100) {

            logger.warn('Search cache full, clearing oldest entries');

            this.clearOldestSearchCache(30);

        }

        

        this.searchResultCache.set(cacheKey, {

            timestamp: Date.now(),

            uids: uids

        });

        

        logger.debug(`Search cache set: ${uids.length} UIDs for ${username}`);

    }



    /**

     * Batch mark emails as processed (sync version)

     * @param {Array} emails - Email array [{uid, messageId, subject, from}, ...]

     */

    batchMarkAsProcessedSync(emails) {

        const now = Date.now();

        

        for (const email of emails) {

            const key = this.generateKey(

                email.uid,

                email.messageId,

                email.subject,

                email.from

            );

            this.processedEmails.set(key, now);

        }



        // Batch capacity check

        if (this.processedEmails.size >= this.maxSize) {

            this.clearOldest(Math.floor(this.maxSize * 0.2));

        }



        logger.debug(`Batch marked ${emails.length} emails as processed`);

    }



    /**

     * Batch mark emails as processed (using Worker)

     * @param {Array} emails - Email array [{uid, messageId, subject, from}, ...]

     * @returns {Promise} Processing result

     */

    async batchMarkAsProcessed(emails) {

        try {

            const result = await this.sendTask('BATCH_MARK_AS_PROCESSED', { emails });

            return result;

        } catch (error) {

            logger.error('batch mark emails failed:', error);

            // Fallback to synchronous processing

            this.batchMarkAsProcessedSync(emails);

            return { success: true, count: emails.length };

        }

    }



    /**

     * Batch check whether emails have been processed (sync version)

     * @param {Array} emails - Email array

     * @returns {Map} Mapping of key -> isProcessed

     */

    batchIsProcessedSync(emails) {

        const cutoffTime = Date.now() - this.ttl;

        const result = new Map();



        for (const email of emails) {

            const key = this.generateKey(

                email.uid,

                email.messageId,

                email.subject,

                email.from

            );

            

            const timestamp = this.processedEmails.get(key);

            const isProcessed = timestamp && timestamp > cutoffTime;

            result.set(key, isProcessed);

        }



        return result;

    }



    /**

     * Batch check whether emails have been processed (using Worker)

     * @param {Array} emails - Email array

     * @returns {Promise<Map>} Mapping of key -> isProcessed

     */

    async batchIsProcessed(emails) {

        try {

            const resultObj = await this.sendTask('BATCH_IS_PROCESSED', { emails });

            // Convert plain object back to Map

            const result = new Map();

            Object.entries(resultObj).forEach(([key, value]) => {

                result.set(key, value);

            });

            return result;

        } catch (error) {

            logger.error('batch check emails failed:', error);

            // Fallback to synchronous processing

            return this.batchIsProcessedSync(emails);

        }

    }



    /**

     * Quickly check whether a signaling email has been processed (check only, no mark)

     * @param {string} subject - Email subject

     * @param {string} from - Sender address

     * @returns {boolean} Whether it has been processed

     */

    isSignalingEmailProcessed(subject, from, messageId = null, uid = null) {

        if (!subject || !from) return false;



        const key = messageId

            ? `signal-msgid:${messageId}`

            : `signal-uid:${uid || 'unknown'}:${from}:${subject}`;



        const timestamp = this.signalingEmails.get(key);

        if (!timestamp) return false;



        // Check if expired

        if (Date.now() - timestamp > this.signalingTtl) {

            this.signalingEmails.delete(key);

            return false;

        }



        return true;

    }



    /**

     * Mark signaling email as processed

     * @param {string} subject - Email subject

     * @param {string} from - Sender address

     */

    markSignalingEmailProcessed(subject, from, messageId = null, uid = null) {

        if (!subject || !from) return;



        const key = messageId

            ? `signal-msgid:${messageId}`

            : `signal-uid:${uid || 'unknown'}:${from}:${subject}`;



        this.signalingEmails.set(key, Date.now());

    }



    /**

     * Remove the oldest N records (FIFO policy or LRU eviction)

     * @param {number} count - Number of records to clear

     * @returns {number} Actual number of cleared records

     */

    clearOldest(count = 1000) {

        if (this.useLRU) {

            // In LRU cache, evictLRU handles eviction automatically

            return this.processedEmails.evictLRU();

        }



        // Use FIFO policy in Map cache

        const toDelete = [];

        let removed = 0;

        

        for (const key of this.processedEmails.keys()) {

            if (removed >= count) break;

            toDelete.push(key);

            removed++;

        }

        

        toDelete.forEach(key => this.processedEmails.delete(key));

        logger.warn(`Cleared ${removed} oldest email dedup entries`);

        

        return removed;

    }



    /**

     * Remove the oldest N records from search cache

     * @param {number} count - Number of records to clear

     * @returns {number} Actual number of cleared records

     */

    clearOldestSearchCache(count = 30) {

        const sorted = Array.from(this.searchResultCache.entries())

            .sort((a, b) => a[1].timestamp - b[1].timestamp);

        

        let removed = 0;

        for (let i = 0; i < Math.min(count, sorted.length); i++) {

            this.searchResultCache.delete(sorted[i][0]);

            removed++;

        }

        

        logger.warn(`Cleared ${removed} oldest search cache entries`);

        return removed;

    }



    /**

     * Remove the oldest signaling email cache entries

     * @param {number} count - Number of records to clear

     * @returns {number} Actual number of cleared records

     * 

     * Note: LRU cache handles eviction automatically; this method has been replaced by LRU evictLRU

     */

    clearOldestSignalingEmails(count = 500) {

        if (this.signalingEmails.evictLRU) {

            return this.signalingEmails.evictLRU();

        }

        

        // Fallback (shouldn't reach here since signalingEmails is always LRU)

        return 0;

    }



    /**

     * Clean up expired entries

     * @param {number} maxAge - Maximum retention time (milliseconds)

     */

    cleanup(maxAge = null) {

        const ageLimit = maxAge || this.ttl;

        let removedCount = 0;



        // Clean main email deduplication cache

        if (this.useLRU) {

            removedCount = this.processedEmails.cleanup(ageLimit);

        } else {

            const cutoffTime = Date.now() - ageLimit;

            for (const [key, timestamp] of this.processedEmails.entries()) {

                if (timestamp < cutoffTime) {

                    this.processedEmails.delete(key);

                    removedCount++;

                }

            }

            if (removedCount > 0) {

                logger.debug(`Cleaned up ${removedCount} expired email dedup entries`);

            }

        }



        // Clean signaling email cache

        const signalingRemoved = this.signalingEmails.cleanup(this.signalingTtl);



        // Clean search cache

        const now = Date.now();

        let searchRemoved = 0;

        for (const [key, value] of this.searchResultCache.entries()) {

            if (now - value.timestamp > this.SEARCH_CACHE_MAX_AGE * 2) {

                this.searchResultCache.delete(key);

                searchRemoved++;

            }

        }



        return removedCount;

    }



    /**

     * Clear all caches

     */

    clear() {

        const size = this.processedEmails.size();

        const signalingSize = this.signalingEmails.size();

        const searchSize = this.searchResultCache.size;

        

        this.processedEmails.clear();

        this.signalingEmails.clear();

        this.searchResultCache.clear();

        

        logger.info(

            `Cleared ${size} email dedup entries, ` +

            `${signalingSize} signaling email entries, ` +

            `and ${searchSize} search cache entries`

        );

    }



    /**

     * Get cache size

     * @returns {number} Number of cached emails

     */

    size() {

        if (this.useLRU) {

            return this.processedEmails.size();

        }

        return this.processedEmails.size;

    }



    /**

     * Start periodic cleanup task

     */

    startCleanupTask() {

        if (this.cleanupInterval) {

            clearInterval(this.cleanupInterval);

        }



        this.cleanupInterval = setInterval(() => {

            this.cleanup();

        }, 60000); // Clean expired entries every minute



        this.cleanupInterval.unref();

    }



    /**

     * Stop cleanup task

     */

    stopCleanupTask() {

        if (this.cleanupInterval) {

            clearInterval(this.cleanupInterval);

            this.cleanupInterval = null;

        }

        

        // Stop Worker

        if (this.worker) {

            try {

                this.worker.terminate();

                logger.info('email deduplication Worker terminated');

            } catch (error) {

                logger.error('terminate email deduplication Worker failed:', error);

            }

            this.worker = null;

            this.workerReady = false;

        }

    }



    /**

     * Get cache statistics

     * @returns {Object} Statistics

     */

    getStats() {

        const result = {

            strategy: this.cacheStrategy,

            processedEmails: this.processedEmails.getStats ? 

                this.processedEmails.getStats() : 

                {

                    size: this.processedEmails.size,

                    maxSize: this.maxSize,

                    ttl: this.ttl

                },

            signalingEmails: this.signalingEmails.getStats(),

            searchCache: {

                size: this.searchResultCache.size,

                ttl: this.SEARCH_CACHE_TTL

            }

        };

        return result;

    }

}



// Singleton instance

let instance = null;



/**

 * Get deduplication manager singleton

 * @param {Object} options - Initialization options

 * @returns {EmailDedupManager} Deduplication manager instance

 */

const getInstance = (options = {}) => {

    if (!instance) {

        instance = new EmailDedupManager(options);

    }

    return instance;

};



module.exports = {

    EmailDedupManager,

    getInstance

};

