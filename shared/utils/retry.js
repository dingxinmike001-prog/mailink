/**
 * Retry utility functions
 * uniformly handle async operations needing retry
 */

/**
 * Delay function
 * @param {number} ms - Delay in milliseconds
 * @returns {Promise<void>}
 */
export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Function executor with retry mechanism
 * @param {Function} fn - function to execute
 * @param {Object} options - configuration options
 * @param {number} options.maxAttempts - maximum attempts (default 3)
 * @param {number} options.delay - retry delay in milliseconds (default 1000)
 * @param {Function} options.onRetry - callback function on retry (attempt, error) => void
 * @param {Function} options.shouldRetry - function to decide retry (error) => boolean
 * @returns {Promise<any>} function execution result
 * @throws {Error} throws the last error when all attempts fail
 */
export async function withRetry(fn, options = {}) {
    const {
        maxAttempts = 3,
        delay = 1000,
        onRetry,
        shouldRetry
    } = options;

    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            // If this is not the last attempt
            if (attempt < maxAttempts) {
                // Check whether a retry should be performed
                if (shouldRetry && !shouldRetry(error)) {
                    throw error;
                }

                // Execute retry callback
                if (onRetry) {
                    onRetry(attempt, error);
                }

                // Retry after waiting
                await sleep(delay);
            }
        }
    }

    throw lastError;
}
