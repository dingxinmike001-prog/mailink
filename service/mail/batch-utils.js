/**
 * Batch processing utility functions
 * Provide generic concurrent batch execution logic for Managers to reuse
 */

const logger = require('../logger');

/**
 * Execute tasks in concurrent batches
 * @param {Array} items - items to process
 * @param {Function} executor - single item executor (item) => Promise<any>
 * @param {Object} options - options
 * @param {number} [options.concurrency=5] - concurrency
 * @param {boolean} [options.stopOnError=false] - whether to stop on error
 * @param {string} [options.logLabel='Batch'] - log label
 * @returns {Promise<{results: Array, errors: Array}>}
 */
async function batchExecute(items, executor, options = {}) {
  const {
    concurrency = 5,
    stopOnError = false,
    logLabel = 'Batch'
  } = options;

  const results = new Array(items.length);
  const errors = new Array(items.length);

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchPromises = batch.map((item, idx) => {
      const taskIndex = i + idx;
      return executor(item)
        .then((result) => {
          results[taskIndex] = result;
          errors[taskIndex] = null;
        })
        .catch((err) => {
          errors[taskIndex] = err;
          if (stopOnError) throw err;
        });
    });

    try {
      await Promise.all(batchPromises);
    } catch (err) {
      logger.error(`[${logLabel}] Batch error: ${err.message}`);
      if (stopOnError) throw err;
    }
  }

  return { results, errors };
}

module.exports = { batchExecute };
