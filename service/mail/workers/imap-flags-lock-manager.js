/**
 * IMAP flag sync lock manager
 * Manages locks for IMAP flag sync operations to avoid concurrent conflicts
 */

class Lock {
    constructor() {
        this.locked = false;
        this.waitQueue = [];
    }

    acquire() {
        if (!this.locked) {
            this.locked = true;
            return {
                release: () => this.release()
            };
        }

        // If already locked, return a pending lock object
        return new Promise((resolve) => {
            this.waitQueue.push(resolve);
        });
    }

    release() {
        if (this.waitQueue.length > 0) {
            const next = this.waitQueue.shift();
            next({
                release: () => this.release()
            });
        } else {
            this.locked = false;
        }
    }

    isLocked() {
        return this.locked;
    }
}

class LockManager {
    constructor() {
        this.locks = new Map();
    }

    /**
     * Get or create a lock
     * @param {string} username - Username
     * @param {string} mailbox - Mailbox folder name
     * @returns {Lock} Lock object
     */
    getLock(username, mailbox = 'INBOX') {
        const key = `${username}:${mailbox}`;
        if (!this.locks.has(key)) {
            this.locks.set(key, new Lock());
        }
        return this.locks.get(key);
    }

    /**
     * Acquire lock (async method, used by imap-flags-sync.worker.js)
     * @param {string} username - Username
     * @param {string} mailbox - Mailbox folder name
     * @returns {Promise<Lock>} Lock object
     */
    async acquireLock(username, mailbox = 'INBOX') {
        const lock = this.getLock(username, mailbox);
        return {
            acquire: () => lock.acquire(),
            release: () => lock.release()
        };
    }

    /**
     * Get lock status
     * @param {string} username - Username
     * @param {string} mailbox - Mailbox folder name
     * @returns {Object} Lock status info
     */
    getLockStatus(username, mailbox = 'INBOX') {
        const key = `${username}:${mailbox}`;
        const lock = this.locks.get(key);
        if (!lock) {
            return {
                locked: false,
                waitingCount: 0
            };
        }
        return {
            locked: lock.isLocked(),
            waitingCount: lock.waitQueue.length
        };
    }

    /**
     * Get all active locks
     * @returns {Array} Active lock list
     */
    getActiveLocks() {
        const activeLocks = [];
        for (const [key, lock] of this.locks.entries()) {
            if (lock.isLocked() || lock.waitQueue.length > 0) {
                const [username, mailbox] = key.split(':');
                activeLocks.push({
                    username,
                    mailbox,
                    locked: lock.isLocked(),
                    waitingCount: lock.waitQueue.length
                });
            }
        }
        return activeLocks;
    }

    /**
     * Release all locks for a specific user
     * @param {string} username - Username
     */
    releaseAllLocks(username) {
        for (const [key, lock] of this.locks.entries()) {
            if (key.startsWith(`${username}:`)) {
                while (lock.waitQueue.length > 0) {
                    const resolve = lock.waitQueue.shift();
                    resolve({
                        release: () => {}
                    });
                }
                lock.locked = false;
            }
        }
    }

    /**
     * Clear all locks
     */
    clearAllLocks() {
        this.locks.clear();
    }
}

// Singleton pattern
let instance = null;

function getInstance() {
    if (!instance) {
        instance = new LockManager();
    }
    return instance;
}

module.exports = {
    LockManager,
    Lock,
    getInstance
};
