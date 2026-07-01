/**
 * IMAP flag sync lock manager
 * Provides distributed locking to prevent concurrent conflicts
 */
const logger = require('../logger');

/**
 * Simple in-memory lock manager
 * Locks at user+mailbox granularity
 */
class IMAPFlagsLockManager {
    constructor() {
        this.locks = new Map(); // key -> {locked: boolean, queue: [], timeout}
        this.maxWaitTime = 30000; // Maximum wait time 30 seconds
        this.lockTimeout = 60000; // Lock expiration 60 seconds
    }

    /**
     * Generate lock key
     * @param {string} username - Email account
     * @param {string} mailbox - Mailbox folder (optional)
     * @returns {string} Lock key
     */
    _generateKey(username, mailbox = 'INBOX') {
        return `${username}:${mailbox}`;
    }

    /**
     * Try to acquire lock
     * @param {string} username - Email account
     * @param {string} mailbox - Mailbox folder
     * @param {number} timeout - Wait timeout (milliseconds)
     * @returns {Promise<{acquire: Function, release: Function}>} Lock object
     */
    async acquireLock(username, mailbox = 'INBOX', timeout = this.maxWaitTime) {
        const key = this._generateKey(username, mailbox);
        const startTime = Date.now();
        const lockId = `${Date.now()}-${Math.random()}`;

        return new Promise((resolve, reject) => {
            const tryAcquire = () => {
                const elapsedTime = Date.now() - startTime;
                
                if (elapsedTime > timeout) {
                    logger.warn(
                        `[IMAPFlagsLock] Failed to acquire lock for ${key} after ${timeout}ms`
                    );
                    reject(new Error(`Lock acquisition timeout for ${key}`));
                    return;
                }

                if (!this.locks.has(key)) {
                    // Create new lock
                    this.locks.set(key, {
                        locked: true,
                        queue: [],
                        timeout: setTimeout(() => {
                            logger.warn(`[IMAPFlagsLock] Lock expired for ${key}, auto-releasing`);
                            this._releaseLock(key);
                        }, this.lockTimeout),
                        lockId,
                        startTime: Date.now()
                    });

                    logger.debug(`[IMAPFlagsLock] Lock acquired for ${key} (lockId: ${lockId})`);

                    resolve({
                        acquire: () => lockId,
                        release: () => this._releaseLock(key, lockId)
                    });
                } else {
                    const lockEntry = this.locks.get(key);
                    if (!lockEntry.locked) {
                        // Lock released, try to acquire directly
                        lockEntry.locked = true;
                        lockEntry.lockId = lockId;
                        lockEntry.startTime = Date.now();

                        logger.debug(`[IMAPFlagsLock] Lock acquired for ${key} (lockId: ${lockId})`);

                        resolve({
                            acquire: () => lockId,
                            release: () => this._releaseLock(key, lockId)
                        });
                    } else {
                        // Lock occupied, join queue, retry after 100ms
                        logger.debug(
                            `[IMAPFlagsLock] Lock busy for ${key}, waiting... (elapsed: ${elapsedTime}ms)`
                        );
                        setTimeout(tryAcquire, 100);
                    }
                }
            };

            tryAcquire();
        });
    }

    /**
     * Release lock
     * @private
     * @param {string} key - Lock key
     * @param {string} lockId - Lock ID (optional, for verification)
     * @returns {boolean} Whether release succeeded
     */
    _releaseLock(key, lockId) {
        if (!this.locks.has(key)) {
            logger.warn(`[IMAPFlagsLock] Attempted to release non-existent lock: ${key}`);
            return false;
        }

        const lockEntry = this.locks.get(key);

        // Verify lockId matches (prevent accidental release)
        if (lockId && lockEntry.lockId !== lockId) {
            logger.warn(
                `[IMAPFlagsLock] Lock ID mismatch for ${key}. ` +
                `Expected: ${lockEntry.lockId}, Got: ${lockId}`
            );
            return false;
        }

        // Clean up timeout timer
        if (lockEntry.timeout) {
            clearTimeout(lockEntry.timeout);
        }

        // Delete lock
        this.locks.delete(key);
        logger.debug(`[IMAPFlagsLock] Lock released for ${key}`);

        return true;
    }

    /**
     * Check lock status
     * @param {string} username - Email account
     * @param {string} mailbox - Mailbox folder
     * @returns {Object} Lock status info
     */
    getLockStatus(username, mailbox = 'INBOX') {
        const key = this._generateKey(username, mailbox);
        const lockEntry = this.locks.get(key);

        if (!lockEntry) {
            return {
                locked: false,
                key
            };
        }

        const holdTime = Date.now() - lockEntry.startTime;
        return {
            locked: lockEntry.locked,
            key,
            holdTime,
            lockId: lockEntry.lockId
        };
    }

    /**
     * Clean expired locks (prevent memory leak)
     */
    cleanup() {
        let cleanedCount = 0;
        const now = Date.now();

        for (const [key, lockEntry] of this.locks.entries()) {
            if (lockEntry.locked && now - lockEntry.startTime > this.lockTimeout * 2) {
                logger.warn(`[IMAPFlagsLock] Cleaning up expired lock: ${key}`);
                this._releaseLock(key);
                cleanedCount++;
            }
        }

        if (cleanedCount > 0) {
            logger.info(`[IMAPFlagsLock] Cleaned up ${cleanedCount} expired locks`);
        }
    }

    /**
     * Get all active locks
     * @returns {Array} Lock list
     */
    getActiveLocks() {
        const activeLocks = [];

        for (const [key, lockEntry] of this.locks.entries()) {
            if (lockEntry.locked) {
                activeLocks.push({
                    key,
                    holdTime: Date.now() - lockEntry.startTime,
                    lockId: lockEntry.lockId
                });
            }
        }

        return activeLocks;
    }

    /**
     * Periodic cleanup (recommended to call at app startup)
     */
    startPeriodicCleanup(interval = 5 * 60 * 1000) {
        setInterval(() => {
            this.cleanup();
        }, interval);

        logger.info(
            `[IMAPFlagsLock] Started periodic cleanup every ${interval}ms`
        );
    }
}

// Singleton instance
let instance = null;

/**
 * Get lock manager singleton
 * @returns {IMAPFlagsLockManager} Lock manager instance
 */
function getInstance() {
    if (!instance) {
        instance = new IMAPFlagsLockManager();
        // Start periodic cleanup (every 5 minutes)
        instance.startPeriodicCleanup(5 * 60 * 1000);
    }
    return instance;
}

module.exports = {
    getInstance,
    IMAPFlagsLockManager
};
