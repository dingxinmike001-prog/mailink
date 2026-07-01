/**
 * JSON Processor Manager
 * manage JSON Processor Worker lifecycle and task scheduling
 */

const { Worker } = require('worker_threads');
const path = require('path');
const logger = require('../logger');

class JsonProcessorManager {
  constructor() {
    this.worker = null;
    this.pendingTasks = new Map();
    this.taskIdCounter = 0;
    this.isInitialized = false;
    this.initPromise = null;
  }

  /**
   * Initialize Worker
   */
  async init() {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._doInit();
    return this.initPromise;
  }

  async _doInit() {
    try {
      const workerPath = path.join(__dirname, 'json-processor.worker.js');
      this.worker = new Worker(workerPath);

      this.worker.on('message', (message) => {
        this._handleMessage(message);
      });

      this.worker.on('error', (error) => {
        logger.error('[JSON Processor Manager] Worker error:', error);
        this._rejectAllPending(error);
      });

      this.worker.on('exit', (code) => {
        if (code !== 0) {
          logger.error(`[JSON Processor Manager] Worker stopped with exit code ${code}`);
          this._rejectAllPending(new Error(`Worker exited with code ${code}`));
        }
        this.isInitialized = false;
        this.worker = null;
      });

      this.isInitialized = true;
      logger.info('[JSON Processor Manager] Worker initialized successfully');
    } catch (error) {
      logger.error('[JSON Processor Manager] Failed to initialize worker:', error);
      this.isInitialized = false;
      throw error;
    }
  }

  /**
   * Handle Worker messages
   */
  _handleMessage(message) {
    // Process log messages
    if (message.type === 'log') {
      const { level, message: logMessage } = message;
      if (level === 'error') {
        logger.error(logMessage);
      } else if (level === 'warn') {
        logger.warn(logMessage);
      } else {
        logger.info(logMessage);
      }
      return;
    }

    // Process task result
    const { taskId, success, result, error } = message;
    const task = this.pendingTasks.get(taskId);

    if (!task) {
      logger.warn(`[JSON Processor Manager] No pending task found for taskId: ${taskId}`);
      return;
    }

    this.pendingTasks.delete(taskId);

    if (success) {
      task.resolve(result);
    } else {
      task.reject(new Error(error?.message || 'Worker task failed'));
    }
  }

  /**
   * Reject all pending tasks
   */
  _rejectAllPending(error) {
    for (const [taskId, task] of this.pendingTasks) {
      task.reject(error);
    }
    this.pendingTasks.clear();
  }

  /**
   * Generate unique task ID
   */
  _generateTaskId() {
    return `json_${++this.taskIdCounter}_${Date.now()}`;
  }

  /**
   * Send task to Worker
   */
  async _sendTask(action, params, timeout = 30000) {
    await this.init();

    return new Promise((resolve, reject) => {
      const taskId = this._generateTaskId();

      // Set timeout
      const timeoutId = setTimeout(() => {
        this.pendingTasks.delete(taskId);
        reject(new Error(`JSON Processor task timeout: ${action}`));
      }, timeout);

      // Store task callback
      this.pendingTasks.set(taskId, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        }
      });

      // Send task to Worker
      this.worker.postMessage({
        taskId,
        action,
        params
      });
    });
  }

  /**
   * Asynchronously parse JSON string
   * @param {string} jsonString - JSON string
   * @param {Object} options - options
   * @param {any} options.defaultValue - default value when parsing fails
   * @returns {Promise<any>} parse result
   */
  async jsonParse(jsonString, options = {}) {
    return this._sendTask('jsonParse', { jsonString, options });
  }

  /**
   * Asynchronously serialize to JSON string
   * @param {any} data - data to serialize
   * @param {Object} options - options
   * @param {number} options.space - number of indentation spaces
   * @returns {Promise<string>} JSON string
   */
  async jsonStringify(data, options = {}) {
    return this._sendTask('jsonStringify', { data, options });
  }

  /**
   * Batch parse email dstr field
   * @param {Array} rows - email row data
   * @param {Object} options - options
   * @param {any} options.defaultValue - default value when parsing fails
   * @returns {Promise<Array>} parsed row data
   */
  async batchParseEmailDstr(rows, options = {}) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return rows;
    }
    return this._sendTask('batchParseEmailDstr', { rows, options });
  }

  /**
   * Batch serialize email data
   * @param {Array} emails - email data array
   * @param {Object} options - options
   * @returns {Promise<Array>} serialized email data
   */
  async batchStringifyEmailDstr(emails, options = {}) {
    if (!Array.isArray(emails) || emails.length === 0) {
      return emails;
    }
    return this._sendTask('batchStringifyEmailDstr', { emails, options });
  }

  /**
   * Close Worker
   */
  async terminate() {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
      this.isInitialized = false;
      this.initPromise = null;
      logger.info('[JSON Processor Manager] Worker terminated');
    }
  }
}

// Export singleton
module.exports = new JsonProcessorManager();
