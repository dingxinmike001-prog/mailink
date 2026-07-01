/**
 * Rate limiter module
 * provides request rate control, debounce, throttle, etc.
 */

/**
 * Rate limiter class
 * used to control operation execution frequency
 */
class RateLimiter {
    /**
     * Create rate limiter instance
     * @param {Object} options - configuration options
     * @param {number} options.intervalMs - minimum interval in milliseconds
     * @param {boolean} options.autoWait - whether to auto-wait, default true
     * @param {Function} options.onLimit - callback when limit triggered
     * @param {Function} options.logger - logger function
     */
    constructor(options = {}) {
        this.intervalMs = options.intervalMs || 3000;
        this.autoWait = options.autoWait !== false;
        this.onLimit = options.onLimit || null;
        this.logger = options.logger || null;

        // Store the last execution time for each key
        this.lastExecutionTimes = new Map();
    }

    /**
     * Check whether operation can execute
     * @param {string} key - operation identifier
     * @returns {{canExecute: boolean, waitTime: number, timeSinceLast: number}} check result
     */
    checkLimit(key) {
        const now = Date.now();
        const lastTime = this.lastExecutionTimes.get(key) || 0;
        const timeSinceLast = now - lastTime;
        const waitTime = Math.max(0, this.intervalMs - timeSinceLast);
        const canExecute = waitTime === 0;

        return {
            canExecute,
            waitTime,
            timeSinceLast
        };
    }

    /**
     * Execute rate limit check, wait if needed
     * @param {string} key - operation identifier
     * @returns {Promise<{executed: boolean, waitTime: number}>} execution result
     */
    async throttle(key) {
        const check = this.checkLimit(key);

        if (!check.canExecute) {
            if (this.logger) {
                this.logger(`[RateLimiter] Rate limit: ${key}, need to wait ${check.waitTime}ms`);
            }

            if (this.onLimit) {
                this.onLimit(key, check.waitTime);
            }

            if (this.autoWait) {
                // Update the last execution time ahead (current time + wait time)
                this.lastExecutionTimes.set(key, Date.now() + check.waitTime);
                await this.sleep(check.waitTime);
                return { executed: true, waitTime: check.waitTime };
            } else {
                return { executed: false, waitTime: check.waitTime };
            }
        }

        // Execute immediately and update the timestamp
        this.lastExecutionTimes.set(key, Date.now());
        return { executed: true, waitTime: 0 };
    }

    /**
     * Reset limit for specified key
     * @param {string} key - operation identifier
     */
    reset(key) {
        this.lastExecutionTimes.delete(key);
    }

    /**
     * Reset all limits
     */
    resetAll() {
        this.lastExecutionTimes.clear();
    }

    /**
     * Get status of specified key
     * @param {string} key - operation identifier
     * @returns {Object|null} status info
     */
    getStatus(key) {
        const lastTime = this.lastExecutionTimes.get(key);
        if (!lastTime) return null;

        const now = Date.now();
        const timeSinceLast = now - lastTime;
        const waitTime = Math.max(0, this.intervalMs - timeSinceLast);

        return {
            lastExecutionTime: lastTime,
            timeSinceLast,
            canExecute: waitTime === 0,
            waitTime
        };
    }

    /**
     * Get status of all keys
     * @returns {Map} all statuses
     */
    getAllStatus() {
        const status = new Map();
        for (const key of this.lastExecutionTimes.keys()) {
            status.set(key, this.getStatus(key));
        }
        return status;
    }

    /**
     * Sleep for specified time
     * @param {number} ms - milliseconds
     * @returns {Promise<void>}
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

/**
 * Debounce function
 * @param {Function} func - function to execute
 * @param {number} wait - wait time in milliseconds
 * @param {boolean} immediate - whether to execute immediately
 * @returns {Function} debounced function
 */
function debounce(func, wait = 300, immediate = false) {
    let timeout;

    return function executedFunction(...args) {
        const context = this;

        const later = function() {
            timeout = null;
            if (!immediate) func.apply(context, args);
        };

        const callNow = immediate && !timeout;

        clearTimeout(timeout);
        timeout = setTimeout(later, wait);

        if (callNow) func.apply(context, args);
    };
}

/**
 * Throttle function
 * @param {Function} func - function to execute
 * @param {number} limit - limit time in milliseconds
 * @returns {Function} throttled function
 */
function throttle(func, limit = 300) {
    let inThrottle;

    return function executedFunction(...args) {
        const context = this;

        if (!inThrottle) {
            func.apply(context, args);
            inThrottle = true;
            setTimeout(() => {
                inThrottle = false;
            }, limit);
        }
    };
}

/**
 * Async operation with retry
 * @param {Function} operation - async operation function
 * @param {Object} options - configuration options
 * @param {number} options.maxRetries - maximum retry count, default 3
 * @param {number} options.baseDelay - base delay in milliseconds, default 1000
 * @param {Function} options.onRetry - callback on retry
 * @returns {Promise<any>} operation result
 */
async function withRetry(operation, options = {}) {
    const {
        maxRetries = 3,
        baseDelay = 1000,
        onRetry = null
    } = options;

    let lastError;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;

            if (attempt > maxRetries) {
                throw lastError;
            }

            const delay = baseDelay * Math.pow(2, attempt - 1);

            if (onRetry) {
                onRetry(error, attempt, delay);
            }

            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    throw lastError;
}

/**
 * Create rate-limited function wrapper
 * @param {Function} fn - original function
 * @param {Object} options - rate limit options
 * @returns {Function} wrapped function
 */
function createRateLimitedFunction(fn, options = {}) {
    const limiter = new RateLimiter(options);

    return async function rateLimitedFunction(...args) {
        const key = options.key || 'default';
        const result = await limiter.throttle(key);

        if (!result.executed) {
            throw new Error(`Rate limit exceeded for key: ${key}, wait ${result.waitTime}ms`);
        }

        return fn.apply(this, args);
    };
}

/**
 * Batch operation rate controller
 * used to control batch operation pace
 */
class BatchRateController {
    /**
     * @param {Object} options - config options
     * @param {number} options.batchSize - batch size
     * @param {number} options.intervalMs - batch interval
     * @param {number} options.itemDelayMs - per-item processing delay
     */
    constructor(options = {}) {
        this.batchSize = options.batchSize || 10;
        this.intervalMs = options.intervalMs || 1000;
        this.itemDelayMs = options.itemDelayMs || 0;
    }

    /**
     * Execute batch operation
     * @param {Array} items - items to process
     * @param {Function} processor - processor function
     * @returns {Promise<Array>} handleresult
     */
    async execute(items, processor) {
        const results = [];

        for (let i = 0; i < items.length; i++) {
            const item = items[i];

            // Process the current item
            try {
                const result = await processor(item, i);
                results.push({ success: true, result, index: i });
            } catch (error) {
                results.push({ success: false, error, index: i });
            }

            // Batch interval check
            if ((i + 1) % this.batchSize === 0 && i < items.length - 1) {
                await new Promise(resolve => setTimeout(resolve, this.intervalMs));
            }

            // Per-item delay
            if (this.itemDelayMs > 0 && i < items.length - 1) {
                await new Promise(resolve => setTimeout(resolve, this.itemDelayMs));
            }
        }

        return results;
    }
}

module.exports = {
    RateLimiter,
    debounce,
    throttle,
    withRetry,
    createRateLimitedFunction,
    BatchRateController
};