/**
 * Email parsing manager
 * Manages and reuses email parsing Worker instances, supports batch parsing and task queue
 * - Single global Worker instance to reduce thread overhead
 * - Supports concurrent task queue (up to 100)
 * - Automatic timeout control and error recovery
 * - Memory management and periodic cleanup
 */

const path = require('path');
const BaseWorkerManager = require('../base-worker-manager');

class EmailParserManager extends BaseWorkerManager {
  constructor() {
    super({ maxPendingTasks: 100, cleanupInterval: 60000 });
  }

  getWorkerPath() {
    return path.join(__dirname, 'workers/email-parser.worker.js');
  }

  getManagerName() {
    return 'EmailParserManager';
  }

  getDefaultStats() {
    return {
      totalParsed: 0,
      totalFailed: 0,
      totalTimeoutMs: 0,
      avgParseTimeMs: 0
    };
  }

  handleCustomMessage(response) {
    // Process log messages
    if (response.type === 'log') {
      const { level, message } = response;
      if (level === 'error') {
        logger.error(message);
      } else if (level === 'warn') {
        logger.warn(message);
      } else {
        logger.info(message);
      }
      return true;
    }
    return false;
  }

  _recordSuccessStats(duration) {
    this.stats.totalParsed++;
    this.stats.totalTimeoutMs += duration;
    this.stats.avgParseTimeMs = Math.round(this.stats.totalTimeoutMs / this.stats.totalParsed);
  }

  handleMessageResult(response, pendingTask) {
    const { success, data, error } = response;
    if (success) {
      pendingTask.resolve(data);
    } else {
      this.stats.totalFailed++;
      logger.warn(`[EmailParserManager] Parse failed for task ${response.id}: ${error}`);
      pendingTask.reject(new Error(error || 'Unknown parsing error'));
    }
  }

  _recordFailureStats(count) {
    this.stats.totalFailed += count;
  }

  _recordCleanupFailure() {
    this.stats.totalFailed++;
  }

  _recordTimeoutFailure(taskId) {
    this.stats.totalFailed++;
    logger.warn(`[EmailParserManager] Parse timeout for UID: ...`);
  }

  _createTimeoutError(taskId, timeout) {
    return new Error(`Email parse timeout (${timeout}ms) for UID: ...`);
  }

  _logCleanupStats(pendingCount) {
    logger.debug(
      `[EmailParserManager] Stats: pending=${pendingCount}, ` +
      `total=${this.stats.totalParsed}, failed=${this.stats.totalFailed}, ` +
      `avgTime=${this.stats.avgParseTimeMs}ms`
    );
  }

  _checkHighPending(pendingCount) {
    if (pendingCount > this.maxPendingTasks * 0.8) {
      logger.warn(
        `[EmailParserManager] High pending task count (${pendingCount}/${this.maxPendingTasks})`
      );
    }
  }

  async parseEmail(streamBuffer, uid, options = {}) {
    const taskId = this._generateTaskId('parse');
    const timeout = options.timeout || 15000;
    const onlySignaling = options.onlySignaling || false;

    return this.executeTask(taskId, {
      id: taskId,
      streamBuffer,
      uid,
      onlySignaling
    }, timeout);
  }

  /**
   * Batch parse emails
   * @param {Array<{streamBuffer, uid, options}>} tasks - List of parsing tasks
   * @returns {Promise<Array>} - Array of parsing results
   */
  async parseEmailBatch(tasks, options = {}) {
    const { batchExecute } = require('./batch-utils');
    return batchExecute(tasks, (task) => this.parseEmail(task.streamBuffer, task.uid, task.options), {
      concurrency: options.concurrency || 5,
      stopOnError: options.stopOnError || false,
      logLabel: 'EmailParserManager'
    });
  }
}

// Import logger (used for logging in subclasses)
const logger = require('../logger');

// Global singleton
let instance = null;

function getInstance() {
  if (!instance) {
    instance = new EmailParserManager();
  }
  return instance;
}

module.exports = {
  getInstance,
  EmailParserManager
};
