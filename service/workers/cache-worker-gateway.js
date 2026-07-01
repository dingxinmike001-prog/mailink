/**
 * Cache management Worker gateway
 * provides convenient interface to communicate with cache-manager.worker.js
 *
 * Usage example:
 * const gateway = new CacheWorkerGateway();
 * await gateway.initialize();
 * await gateway.set('processed-emails', 'email-1', Date.now());
 * const ts = await gateway.get('processed-emails', 'email-1');
 */

const { Worker } = require('worker_threads');
const path = require('path');

class CacheWorkerGateway {
    constructor(options = {}) {
        this.worker = null;
        this.messageId = 0;
        this.pendingMessages = new Map();
        this.timeout = options.timeout || 5000;
        this.workerPath = path.join(__dirname, 'cache-manager.worker.js');
        this.logger = options.logger || console;
    }

    /**
     * Initialize Worker
     */
    async initialize() {
        return new Promise((resolve, reject) => {
            try {
                this.worker = new Worker(this.workerPath);

                this.worker.on('message', (message) => {
                    this.handleMessage(message);
                });

                this.worker.on('error', (error) => {
                    this.logger.error('Worker error:', error);
                    reject(error);
                });

                this.worker.on('exit', (code) => {
                    if (code !== 0) {
                        this.logger.warn(`Worker exited with code ${code}`);
                    }
                });

                setTimeout(() => {
                    resolve();
                }, 100);
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Handle messages from Worker
     */
    handleMessage(message) {
        const { id, action, result, error } = message;
        
        if (this.pendingMessages.has(id)) {
            const { resolve, reject, timeout } = this.pendingMessages.get(id);
            clearTimeout(timeout);
            this.pendingMessages.delete(id);

            if (error) {
                reject(new Error(error));
            } else {
                resolve(result);
            }
        }
    }

    /**
     * Send message to Worker
     */
    async sendMessage(action, options = {}) {
        if (!this.worker) {
            throw new Error('Worker not initialized');
        }

        const id = ++this.messageId;
        const message = { id, action, ...options };

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingMessages.delete(id);
                reject(new Error(`Worker operation timeout: ${action}`));
            }, this.timeout);

            this.pendingMessages.set(id, { resolve, reject, timeout });
            this.worker.postMessage(message);
        });
    }

    // ===== Basic operations =====

    /**
     * Get cache value
     */
    async get(cacheName, key) {
        return this.sendMessage('get', { cacheName, key });
    }

    /**
     * Set cache value
     */
    async set(cacheName, key, value) {
        return this.sendMessage('set', { cacheName, key, value });
    }

    /**
     * Check whether cache exists
     */
    async has(cacheName, key) {
        return this.sendMessage('has', { cacheName, key });
    }

    /**
     * Delete cache
     */
    async delete(cacheName, key) {
        return this.sendMessage('delete', { cacheName, key });
    }

    /**
     * Get cache size
     */
    async size(cacheName) {
        return this.sendMessage('size', { cacheName });
    }

    // ===== Batch operations =====

    /**
     * Batch get
     */
    async getMultiple(cacheName, keys) {
        return this.sendMessage('getMultiple', { cacheName, keys });
    }

    /**
     * Batch set
     */
    async setMultiple(cacheName, entries) {
        return this.sendMessage('setMultiple', { cacheName, value: entries });
    }

    /**
     * Batch delete
     */
    async deleteMultiple(cacheName, keys) {
        return this.sendMessage('deleteMultiple', { cacheName, keys });
    }

    // ===== Management operations =====

    /**
     * clear cache
     */
    async clear(cacheName) {
        return this.sendMessage('clear', { cacheName });
    }

    /**
     * Clean up expired entries
     */
    async cleanup(cacheName, ttl = 300000) {
        return this.sendMessage('cleanup', { cacheName, ttl });
    }

    /**
     * LRU eviction
     */
    async evict(cacheName) {
        return this.sendMessage('evict', { cacheName });
    }

    /**
     * Get statistics
     */
    async getStats(cacheName) {
        return this.sendMessage('getStats', { cacheName });
    }

    /**
     * Reset statistics
     */
    async resetStats(cacheName) {
        return this.sendMessage('resetStats', { cacheName });
    }

    /**
     * Get statistics for all caches
     */
    async getAllStats() {
        return this.sendMessage('getCacheStats', {});
    }

    /**
     * List all caches
     */
    async listCaches() {
        return this.sendMessage('listCaches', {});
    }

    /**
     * Clear entire cache container
     */
    async clearCache(cacheName) {
        return this.sendMessage('clearCache', { cacheName });
    }

    /**
     * Close Worker
     */
    async terminate() {
        if (this.worker) {
            return new Promise((resolve) => {
                this.worker.terminate(() => {
                    this.worker = null;
                    resolve();
                });
            });
        }
    }

    /**
     * Get Worker status
     */
    getStatus() {
        return {
            initialized: !!this.worker,
            pendingRequests: this.pendingMessages.size,
            messageId: this.messageId
        };
    }
}

module.exports = CacheWorkerGateway;
