/**
 * Email cache management Worker
 * Handle all cache operations, offload CPU-intensive cache eviction and management to an independent thread
 *
 * Phase 3: Worker migration optimization
 * main thread fully freed, expected performance improvement 20-30%(relative to LRU)
 *
 * Usage example:
 * const worker = new Worker('./cache-manager.worker.js');
 * worker.postMessage({action: 'set', key: 'email-1', value: timestamp});
 * worker.onmessage = (e) => console.log(e.data);
 */

const { parentPort } = require('worker_threads');

// Inline definition of the LRU cache class (avoids cross-thread import issues)
class EmailDedupLRU {
    constructor(maxSize = 10000) {
        this.maxSize = maxSize;
        this.cache = new Map();
        this.stats = { hits: 0, misses: 0, evictions: 0 };
    }

    get(key) {
        const entry = this.cache.get(key);
        if (!entry) {
            this.stats.misses++;
            return null;
        }
        entry.timestamp = Date.now();
        entry.accessCount++;
        this.stats.hits++;
        return entry.value;
    }

    set(key, value) {
        if (this.cache.has(key)) {
            const entry = this.cache.get(key);
            entry.value = value;
            entry.timestamp = Date.now();
            entry.accessCount++;
        } else {
            if (this.cache.size >= this.maxSize) {
                this.evictLRU();
            }
            this.cache.set(key, {
                value,
                timestamp: Date.now(),
                accessCount: 1
            });
        }
    }

    has(key) {
        return this.cache.has(key);
    }

    delete(key) {
        return this.cache.delete(key);
    }

    clear() {
        this.cache.clear();
    }

    size() {
        return this.cache.size;
    }

    evictLRU() {
        if (this.cache.size === 0) return 0;
        const evictCount = Math.max(1, Math.floor(this.maxSize * 0.1));
        const now = Date.now();
        let evicted = 0;

        const scores = Array.from(this.cache.entries()).map(([key, entry]) => {
            const recencyScore = (now - entry.timestamp) / 1000;
            const accessScore = entry.accessCount;
            const priority = accessScore + recencyScore;
            return { key, priority };
        });

        scores.sort((a, b) => a.priority - b.priority);

        for (let i = 0; i < evictCount && i < scores.length; i++) {
            this.cache.delete(scores[i].key);
            evicted++;
        }

        this.stats.evictions += evicted;
        return evicted;
    }

    cleanup(ttl) {
        const cutoffTime = Date.now() - ttl;
        let removed = 0;
        for (const [key, entry] of this.cache.entries()) {
            if (entry.timestamp < cutoffTime) {
                this.cache.delete(key);
                removed++;
            }
        }
        return removed;
    }

    getStats() {
        const entries = Array.from(this.cache.values());
        const totalAccess = entries.reduce((sum, e) => sum + e.accessCount, 0);
        const now = Date.now();
        const avgAge = entries.length > 0
            ? entries.reduce((sum, e) => sum + (now - e.timestamp), 0) / entries.length
            : 0;

        const hitRate = this.stats.hits + this.stats.misses > 0
            ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(2)
            : 0;

        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            utilizationRate: ((this.cache.size / this.maxSize) * 100).toFixed(2) + '%',
            totalAccess,
            averageAccess: (totalAccess / entries.length || 0).toFixed(2),
            averageAge: Math.round(avgAge),
            hits: this.stats.hits,
            misses: this.stats.misses,
            hitRate: hitRate + '%',
            evictions: this.stats.evictions
        };
    }
}

// Initialize cache container
const caches = new Map();

/**
 * Get or create cache instance
 * @param {string} cacheName - cache name
 * @param {number} maxSize - max size
 * @returns {EmailDedupLRU}
 */
function getOrCreateCache(cacheName, maxSize = 10000) {
    if (!caches.has(cacheName)) {
        caches.set(cacheName, new EmailDedupLRU(maxSize));
    }
    return caches.get(cacheName);
}

/**
 * Handle messages from the main thread
 */
parentPort.on('message', (message) => {
    const { id, action, cacheName, key, value, keys, ttl, maxSize } = message;

    try {
        let result;
        const cache = getOrCreateCache(cacheName, maxSize);

        switch (action) {
            // Basic operations
            case 'get':
                result = cache.get(key);
                break;

            case 'set':
                cache.set(key, value);
                result = { success: true };
                break;

            case 'has':
                result = cache.has(key);
                break;

            case 'delete':
                result = cache.delete(key);
                break;

            case 'size':
                result = cache.size();
                break;

            // Batch operations
            case 'getMultiple':
                result = {};
                for (const k of keys) {
                    const val = cache.get(k);
                    if (val !== null) {
                        result[k] = val;
                    }
                }
                break;

            case 'setMultiple':
                const now = Date.now();
                for (const [k, v] of Object.entries(value)) {
                    if (cache.size() >= cache.maxSize) {
                        cache.evictLRU();
                    }
                    cache.set(k, v);
                }
                result = { success: true, count: Object.keys(value).length };
                break;

            case 'deleteMultiple':
                result = 0;
                for (const k of keys) {
                    if (cache.delete(k)) {
                        result++;
                    }
                }
                break;

            // Management operations
            case 'clear':
                cache.clear();
                result = { success: true };
                break;

            case 'cleanup':
                result = cache.cleanup(ttl || 300000);
                break;

            case 'evict':
                result = cache.evictLRU();
                break;

            case 'getStats':
                result = cache.getStats();
                break;

            case 'resetStats':
                cache.stats = { hits: 0, misses: 0, evictions: 0 };
                result = { success: true };
                break;

            // Cache management
            case 'listCaches':
                result = Array.from(caches.keys());
                break;

            case 'getCacheStats':
                result = {};
                for (const [name, c] of caches.entries()) {
                    result[name] = c.getStats();
                }
                break;

            case 'clearCache':
                if (caches.has(cacheName)) {
                    caches.delete(cacheName);
                }
                result = { success: true };
                break;

            default:
                result = { error: `Unknown action: ${action}` };
        }

        // Send response
        parentPort.postMessage({
            id,
            action,
            result,
            error: null
        });
    } catch (error) {
        // Send error response
        parentPort.postMessage({
            id,
            action,
            result: null,
            error: error.message
        });
    }
});

// Graceful shutdown
process.on('SIGTERM', () => {
    caches.clear();
    process.exit(0);
});
