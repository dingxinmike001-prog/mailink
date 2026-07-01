/**
 * File validation manager
 * Manages file validation Worker instances
 * 
 * Features:
 * - Single file validation
 * - Batch validation (supports 100+ concurrent)
 * - Stream validation (large files)
 * - Auto timeout and error recovery
 * - Performance stats and monitoring
 */

const path = require('path');
const BaseWorkerManager = require('../base-worker-manager');

const VALIDATION_MODES = {
  LIGHT: 'light',
  NORMAL: 'normal',
  STRICT: 'strict',
  BATCH: 'batch'
};

class FileValidatorManager extends BaseWorkerManager {
  constructor() {
    super({ maxPendingTasks: 200, cleanupInterval: 60000 });
  }

  getWorkerPath() {
    return path.join(__dirname, 'file-validator.worker.js');
  }

  getManagerName() {
    return 'FileValidatorManager';
  }

  getDefaultStats() {
    return {
      totalValidated: 0,
      totalBlocked: 0,
      totalAllowed: 0,
      totalTimeMs: 0,
      avgTimePerFile: 0
    };
  }

  handleCustomMessage(response) {
    // Process progress report
    if (response.type === 'progress') {
      const { id, data } = response;
      const pendingTask = this.pendingTasks.get(id);
      if (pendingTask && pendingTask.onProgress) {
        try {
          pendingTask.onProgress(data);
        } catch (e) {
          logger.error('[FileValidatorManager] onProgress callback error:', e);
        }
      }
      return true;
    }
    return false;
  }

  handleMessageResult(response, pendingTask) {
    const { success, data, error } = response;

    if (success) {
      if (data.results) {
        // Batch verification results
        this.stats.totalValidated += data.summary.total;
        this.stats.totalAllowed += data.summary.passed;
        this.stats.totalBlocked += data.summary.failed;
        this.stats.totalTimeMs += data.summary.duration;
      } else {
        // Single file verification result
        this.stats.totalValidated++;
        if (data.isSafe) {
          this.stats.totalAllowed++;
        } else {
          this.stats.totalBlocked++;
        }
        this.stats.totalTimeMs += data.duration || 0;
      }

      this.stats.avgTimePerFile = 
        this.stats.totalValidated > 0 
          ? this.stats.totalTimeMs / this.stats.totalValidated 
          : 0;

      pendingTask.resolve(data);
    } else {
      this.stats.totalValidated++;
      this.stats.totalBlocked++;
      logger.warn(`[FileValidatorManager] Validation failed for task ${response.id}: ${error}`);
      pendingTask.reject(new Error(error || 'Unknown validation error'));
    }
  }

  _recordFailureStats(count) {
    this.stats.totalValidated += count;
    this.stats.totalBlocked += count;
  }

  _recordCleanupFailure() {
    this.stats.totalValidated++;
    this.stats.totalBlocked++;
  }

  _logCleanupStats(pendingCount) {
    logger.debug(
      `[FileValidatorManager] Stats: validated=${this.stats.totalValidated}, ` +
      `blocked=${this.stats.totalBlocked}, allowed=${this.stats.totalAllowed}, ` +
      `pending=${pendingCount}, avg=${this.stats.avgTimePerFile.toFixed(2)}ms`
    );
  }

  getStats() {
    return {
      ...super.getStats(),
      blockRate: this.stats.totalValidated > 0 
        ? (this.stats.totalBlocked / this.stats.totalValidated).toFixed(4)
        : 0
    };
  }

  /**
   * Reset stats info
   */
  resetStats() {
    this.stats = this.getDefaultStats();
  }

  /**
   * Validate single file
   * @param {string} filePath - file path
   * @param {Object} fileInfo - { name, type, size }
   * @param {string} mode - validation mode (light/normal/strict)
   * @param {Object} options - { timeout }
   * @returns {Promise<Object>}
   */
  validateFile(filePath, fileInfo = {}, mode = VALIDATION_MODES.NORMAL, options = {}) {
    const id = this.taskCounter++;
    const timeout = options.timeout || 30000; // 30-second timeout

    return this.executeTask(id, {
      id,
      type: 'validate-file',
      payload: { filePath, fileInfo, mode }
    }, timeout);
  }

  /**
   * Validate files in batch
   * @param {Array} files - [{ filePath, fileInfo }, ...]
   * @param {string} mode - validation mode
   * @param {Object} options - { timeout, onProgress }
   * @returns {Promise<Object>}
   */
  validateBatch(files, mode = VALIDATION_MODES.NORMAL, options = {}) {
    const id = this.taskCounter++;
    const timeout = options.timeout || 120000; // 2-minute timeout
    const onProgress = options.onProgress; // Progress callback

    return this.executeTask(id, {
      id,
      type: 'validate-batch',
      payload: { files, mode }
    }, timeout, { onProgress });
  }

  /**
   * Stream validate large file
   * @param {string} filePath - file path
   * @param {Object} fileInfo - { name, type, size }
   * @param {string} mode - validation mode
   * @param {Object} options - { timeout, chunkSize }
   * @returns {Promise<Object>}
   */
  validateStream(filePath, fileInfo = {}, mode = VALIDATION_MODES.NORMAL, options = {}) {
    const id = this.taskCounter++;
    const timeout = options.timeout || 60000; // 60-second timeout

    return this.executeTask(id, {
      id,
      type: 'validate-stream',
      payload: { filePath, fileInfo, mode, chunkSize: options.chunkSize || 64 * 1024 }
    }, timeout);
  }
}

// Import logger (used for logging in subclasses)
const logger = require('../logger');

// Singleton instance
let instance = null;

/**
 * Get or create Manager singleton
 */
function getInstance() {
  if (!instance) {
    instance = new FileValidatorManager();
  }
  return instance;
}

module.exports = {
  getInstance,
  FileValidatorManager,
  VALIDATION_MODES
};
