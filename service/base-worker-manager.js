/**
 * Worker manager base class
 * Extract common logic from three highly similar Worker managers (EmailParserManager, AttachmentDownloadManager, FileValidatorManager)
 * 
 * Common features:
 * - Worker lifecycle management (init, error handling, crash recovery)
 * - Task queue management (pendingTasks Map, timeout control, resource limits)
 * - Stats collection
 * - Periodic cleanup of overdue tasks
 * - Graceful shutdown
 * 
 * Subclasses only need to implement:
 * - getWorkerPath(): returns worker script path
 * - getManagerName(): returns manager name (used for logs)
 * - getDefaultStats(): returns initial stats object
 * - handleMessageResult(response, pendingTask): handles business result (stats update, etc.)
 * - Optional override: handleCustomMessage(response): handles special message types (progress, log, etc.)
 */

const { Worker } = require('worker_threads');
const path = require('path');
const logger = require('./logger');

class BaseWorkerManager {
  /**
   * @param {Object} options
   * @param {number} options.maxPendingTasks - max pending tasks (default 100)
   * @param {number} options.cleanupInterval - cleanup interval in milliseconds (default 60000)
   */
  constructor(options = {}) {
    this.worker = null;
    this.pendingTasks = new Map(); // taskId -> {resolve, reject, timeout, timestamp}
    this.isReady = false;
    this.maxPendingTasks = options.maxPendingTasks || 100;
    this.taskCounter = 0;
    this.stats = this.getDefaultStats();
    this.lastCleanupTime = Date.now();
    this.cleanupInterval = options.cleanupInterval || 60000;

    this.initWorker();
  }

  // ==================== Abstract methods subclasses must implement ====================

  /** Returns the relative/absolute path of the worker script */
  getWorkerPath() {
    throw new Error('getWorkerPath() must be implemented by subclass');
  }

  /** Returns the manager name, used as log prefix */
  getManagerName() {
    throw new Error('getManagerName() must be implemented by subclass');
  }

  /** Returns the initial stats object */
  getDefaultStats() {
    throw new Error('getDefaultStats() must be implemented by subclass');
  }

  /**
   * Handle business result message (success/failure)
   * Subclasses update custom stats here
   * @param {Object} response - response returned by worker
   * @param {Object} pendingTask - pending task object
   */
  handleMessageResult(response, pendingTask) {
    // Default implementation: basic counting
    const { success, data, error } = response;
    if (success) {
      pendingTask.resolve(data);
    } else {
      this.stats.totalFailed = (this.stats.totalFailed || 0) + 1;
      pendingTask.reject(new Error(error || 'Unknown error'));
    }
  }

  /**
   * Handle special message types (non-result messages)
   * Subclasses can override to handle log, progress, etc.
   * @param {Object} response - response returned by worker
   * @returns {boolean} whether the message was consumed (true means handleMessageResult is not called)
   */
  handleCustomMessage(response) {
    // Default: do not handle any special messages
    return false;
  }

  // ==================== Worker lifecycle ====================

  initWorker() {
    const name = this.getManagerName();
    try {
      this.worker = new Worker(this.getWorkerPath());

      this.worker.on('message', (response) => {
        this.handleWorkerMessage(response);
      });

      this.worker.on('error', (err) => {
        logger.error(`[${name}] Worker error:`, err);
        this.handleWorkerError(err);
      });

      this.worker.on('exit', (code) => {
        if (code !== 0) {
          logger.error(`[${name}] Worker exited with code ${code}`);
          this.handleWorkerCrash(code);
        }
      });

      this.isReady = true;
      logger.info(`[${name}] Worker initialized successfully`);
    } catch (err) {
      logger.error(`[${name}] Failed to initialize worker:`, err);
      this.isReady = false;
    }
  }

  handleWorkerMessage(response) {
    // Let subclass handle special messages first (log, progress, etc.)
    if (this.handleCustomMessage(response)) {
      return;
    }

    // Handle business result
    const { id } = response;
    const pendingTask = this.pendingTasks.get(id);

    if (pendingTask) {
      clearTimeout(pendingTask.timeout);
      this.pendingTasks.delete(id);

      // Record base success count (subclasses can update finer-grained stats in handleMessageResult)
      if (response.success) {
        const duration = Date.now() - pendingTask.timestamp;
        this._recordSuccessStats(duration);
      }

      this.handleMessageResult(response, pendingTask);
    }
  }

  /**
   * Record success stats (can be overridden by subclasses)
   */
  _recordSuccessStats(duration) {
    // default empty implementation，subclass can override
  }

  handleWorkerError(err) {
    const name = this.getManagerName();
    const failedCount = this.pendingTasks.size;
    for (const [id, task] of this.pendingTasks) {
      clearTimeout(task.timeout);
      task.reject(new Error(`Worker crashed: ${err.message}`));
    }
    this._recordFailureStats(failedCount);
    this.pendingTasks.clear();

    logger.info(`[${name}] Attempting to restart worker...`);
    setTimeout(() => this.initWorker(), 1000);
  }

  handleWorkerCrash(code) {
    const name = this.getManagerName();
    const failedCount = this.pendingTasks.size;
    for (const [id, task] of this.pendingTasks) {
      clearTimeout(task.timeout);
      task.reject(new Error(`Worker exited with code ${code}`));
    }
    this._recordFailureStats(failedCount);
    this.pendingTasks.clear();
    this.isReady = false;

    setTimeout(() => this.initWorker(), 1000);
  }

  /**
   * Record failure stats (can be overridden by subclasses)
   */
  _recordFailureStats(count) {
    this.stats.totalFailed = (this.stats.totalFailed || 0) + count;
  }

  // ==================== Cleanup logic ====================

  cleanup() {
    const now = Date.now();
    if (now - this.lastCleanupTime < this.cleanupInterval) {
      return;
    }

    this.lastCleanupTime = now;
    const pendingCount = this.pendingTasks.size;

    this._logCleanupStats(pendingCount);

    // Clean up overdue tasks (not completed within 30 seconds)
    const maxAge = 30000;
    let cleanedCount = 0;
    for (const [id, task] of this.pendingTasks) {
      if (now - task.timestamp > maxAge) {
        clearTimeout(task.timeout);
        task.reject(new Error('Task cleanup: exceeded maximum age'));
        this.pendingTasks.delete(id);
        this._recordCleanupFailure();
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      const name = this.getManagerName();
      logger.warn(`[${name}] Cleaned up ${cleanedCount} expired tasks`);
    }

    this._checkHighPending(pendingCount);
  }

  /** Log cleanup stats (subclasses can override) */
  _logCleanupStats(pendingCount) {
    const name = this.getManagerName();
    logger.debug(`[${name}] Stats: pending=${pendingCount}`);
  }

  /** Record cleanup failure stats (subclasses can override) */
  _recordCleanupFailure() {
    this.stats.totalFailed = (this.stats.totalFailed || 0) + 1;
  }

  /** Check high pending warning (subclasses can override) */
  _checkHighPending(pendingCount) {
    // default empty implementation，subclass can override as needed
  }

  // ==================== Task execution helper methods ====================

  /**
   * Core task execution method
   * @param {string} taskId - task ID
   * @param {Object} message - message sent to worker
   * @param {number} timeout - timeout in milliseconds
   * @param {Object} [extraTaskData] - extra task data (e.g. onProgress callback)
   * @returns {Promise}
   */
  executeTask(taskId, message, timeout, extraTaskData = {}) {
    this.cleanup();

    if (!this.isReady || !this.worker) {
      throw new Error(`${this.getManagerName()} worker is not ready`);
    }

    if (this.pendingTasks.size >= this.maxPendingTasks) {
      throw new Error(
        `Too many pending tasks (${this.pendingTasks.size}/${this.maxPendingTasks})`
      );
    }

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        if (this.pendingTasks.has(taskId)) {
          this.pendingTasks.delete(taskId);
          this._recordTimeoutFailure(taskId);
          reject(this._createTimeoutError(taskId, timeout));
        }
      }, timeout);

      this.pendingTasks.set(taskId, {
        resolve,
        reject,
        timeout: timeoutHandle,
        timestamp: Date.now(),
        ...extraTaskData
      });

      try {
        this.worker.postMessage(message);
      } catch (err) {
        clearTimeout(timeoutHandle);
        this.pendingTasks.delete(taskId);
        this._recordSendFailure();
        reject(new Error(`Failed to send task to worker: ${err.message}`));
      }
    });
  }

  /** Record timeout failure (subclasses can override) */
  _recordTimeoutFailure(taskId) {
    this.stats.totalFailed = (this.stats.totalFailed || 0) + 1;
  }

  /** Create timeout error (subclasses can override for more meaningful messages) */
  _createTimeoutError(taskId, timeout) {
    return new Error(`Task timeout (${timeout}ms) for ${taskId}`);
  }

  /** Record send failure (subclasses can override) */
  _recordSendFailure() {
    this.stats.totalFailed = (this.stats.totalFailed || 0) + 1;
  }

  // ==================== Stats and shutdown ====================

  /**
   * Get stats info
   * @returns {Object}
   */
  getStats() {
    return {
      ...this.stats,
      pendingTasks: this.pendingTasks.size,
      maxPendingTasks: this.maxPendingTasks,
      isReady: this.isReady
    };
  }

  /**
   * Graceful shutdown (wait for pending tasks to complete or force terminate after timeout)
   * @param {number} [waitTimeout=10000] - wait timeout in milliseconds
   */
  async shutdown(waitTimeout = 10000) {
    const name = this.getManagerName();
    logger.info(`[${name}] Shutting down...`);

    if (this.pendingTasks.size > 0) {
      logger.info(`[${name}] Waiting for ${this.pendingTasks.size} pending tasks...`);
      
      await this._waitForPendingTasks(waitTimeout);
    }

    if (this.worker) {
      this.worker.terminate();
    }
    this.isReady = false;
    logger.info(`[${name}] Shutdown complete`);
  }

  /**
   * Wait for pending tasks to complete
   * @param {number} waitTimeout - timeout
   */
  async _waitForPendingTasks(waitTimeout) {
    const name = this.getManagerName();
    
    return new Promise((resolve) => {
      const cleanupTimeout = setTimeout(() => {
        logger.warn(`[${name}] Cleanup timeout, force terminating tasks`);
        for (const [id, task] of this.pendingTasks) {
          clearTimeout(task.timeout);
          task.reject(new Error('Manager shutdown'));
        }
        this.pendingTasks.clear();
        resolve();
      }, waitTimeout);

      const tasks = Array.from(this.pendingTasks.values());
      if (tasks.length === 0) {
        clearTimeout(cleanupTimeout);
        resolve();
        return;
      }

      Promise.all(
        tasks.map(
          (task) => new Promise((taskResolve) => {
            const originalReject = task.reject;
            task.reject = (...args) => {
              clearTimeout(cleanupTimeout);
              originalReject(...args);
              taskResolve();
            };
            const originalResolve = task.resolve;
            task.resolve = (...args) => {
              clearTimeout(cleanupTimeout);
              originalResolve(...args);
              taskResolve();
            };
          })
        )
      ).then(() => {
        clearTimeout(cleanupTimeout);
        resolve();
      });
    });
  }

  /** Generate task ID */
  _generateTaskId(prefix = 'task') {
    return `${prefix}_${++this.taskCounter}`;
  }
}

module.exports = BaseWorkerManager;
