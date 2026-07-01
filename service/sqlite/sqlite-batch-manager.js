/**
 * SQLite batch operation manager
 * Manages Worker thread lifecycle, provides simple batch operation API
 */

const { Worker } = require('worker_threads');
const path = require('path');
const logger = require('../logger');

/**
 * Message ID counter (used for request-response pairing)
 */
let messageIdCounter = 0;

function getMessageId() {
  return ++messageIdCounter;
}

class SQLiteBatchManager {
  constructor() {
    this.workers = new Map();        // dbPath -> Worker mapping
    this.pendingRequests = new Map(); // messageId -> Promise resolve/reject
    this.buffers = new Map();        // dbPath -> buffer (used for accumulating batch operations)
    this.flushTimers = new Map();    // dbPath -> timer ID
    this.config = {
      batchSize: 1000,              // Maximum records per batch operation
      flushInterval: 500            // Milliseconds, max wait time for accumulating batch
    };
  }

  /**
   * Get or create Worker
   * @param {string} dbPath - Database file path
   * @returns {Worker} Worker instance
   */
  getOrCreateWorker(dbPath) {
    if (this.workers.has(dbPath)) {
      return this.workers.get(dbPath);
    }

    const workerPath = path.join(__dirname, 'sqlite-batch-worker.js');
    const worker = new Worker(workerPath);

    // Listen to Worker messages
    worker.on('message', (message) => {
      const { id, result, error, success, type } = message;
      const handler = this.pendingRequests.get(id);

      if (handler) {
        this.pendingRequests.delete(id);
        if (error) {
          handler.reject(new Error(error));
        } else {
          handler.resolve({ result, success, type });
        }
      }

      // Print statistics
      if (type === 'batchInsertEmails' && result) {
        logger.info(`[BatchManager] Batch insert completed: success=${result.insertedCount}, failed=${result.failedCount}`);
      } else if (type === 'batchUpdateReadStatus' && result) {
        logger.info(`[BatchManager] Batch update completed: updated=${result.updatedCount}, failed=${result.failedCount}`);
      }
    });

    worker.on('error', (error) => {
      logger.error(`[BatchManager] Worker error: ${error.message}`);
      this.workers.delete(dbPath);
    });

    worker.on('exit', (code) => {
      logger.info(`[BatchManager] Worker exited (code=${code})`);
      this.workers.delete(dbPath);
    });

    // Initialize Worker's database connection
    this.sendMessage(worker, { type: 'init', dbPath });

    this.workers.set(dbPath, worker);
    return worker;
  }

  /**
   * Send message to Worker
   * @private
   */
  sendMessage(worker, message) {
    const id = getMessageId();
    message.id = id;

    return new Promise((resolve, reject) => {
      // 30-second timeout
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Worker response timeout: ${message.type}`));
      }, 30000);

      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });

      worker.postMessage(message);
    });
  }

  /**
   * Batch insert emails (supports buffering and automatic batching)
   * @param {string} dbPath - Database path
   * @param {Array} emails - Email array
   * @param {boolean} immediate - Whether to execute immediately (do not wait for buffering)
   */
  async batchInsertEmails(dbPath, emails, immediate = false) {
    const worker = this.getOrCreateWorker(dbPath);

    // If immediate, send directly
    if (immediate || emails.length >= this.config.batchSize) {
      const response = await this.sendMessage(worker, {
        type: 'batchInsertEmails',
        payload: emails
      });
      return response.result;
    }

    // Otherwise add to buffer and wait for batch accumulation
    if (!this.buffers.has(dbPath)) {
      this.buffers.set(dbPath, {
        insertEmails: [],
        updateStatus: [],
        upsertContact: []
      });
    }

    const buffer = this.buffers.get(dbPath);
    buffer.insertEmails.push(...emails);

    // If buffer is full, execute immediately
    if (buffer.insertEmails.length >= this.config.batchSize) {
      return this.flushBuffer(dbPath, 'insertEmails');
    }

    // Otherwise set a timer to wait for other operations to merge
    this.scheduleFlush(dbPath);

    // 🔧 Fix: return a result indicating it has been added to the buffer
    return {
      success: true,
      buffered: true,
      message: `Added ${emails.length} emails to buffer, will flush in ${this.config.flushInterval}ms or when buffer reaches ${this.config.batchSize}`
    };
  }

  /**
   * Batch update read status
   * @param {string} dbPath - database path
   * @param {Array} updates - update array [{message_id, is_read},...]
   * @param {boolean} immediate - whether to execute immediately
   */
  async batchUpdateReadStatus(dbPath, updates, immediate = false) {
    const worker = this.getOrCreateWorker(dbPath);

    if (immediate || updates.length >= this.config.batchSize) {
      const response = await this.sendMessage(worker, {
        type: 'batchUpdateReadStatus',
        payload: updates
      });
      return response.result;
    }

    if (!this.buffers.has(dbPath)) {
      this.buffers.set(dbPath, {
        insertEmails: [],
        updateStatus: [],
        upsertContact: []
      });
    }

    const buffer = this.buffers.get(dbPath);
    buffer.updateStatus.push(...updates);

    if (buffer.updateStatus.length >= this.config.batchSize) {
      return this.flushBuffer(dbPath, 'updateStatus');
    }

    this.scheduleFlush(dbPath);
  }

  /**
   * Batch insert or update contacts
   * @param {string} dbPath - database path
   * @param {Array} records - records array
   * @param {boolean} immediate - whether to execute immediately
   */
  async batchUpsertContact(dbPath, records, immediate = false) {
    const worker = this.getOrCreateWorker(dbPath);

    if (immediate || records.length >= this.config.batchSize) {
      const response = await this.sendMessage(worker, {
        type: 'batchUpsertContact',
        payload: records
      });
      return response.result;
    }

    if (!this.buffers.has(dbPath)) {
      this.buffers.set(dbPath, {
        insertEmails: [],
        updateStatus: [],
        upsertContact: []
      });
    }

    const buffer = this.buffers.get(dbPath);
    buffer.upsertContact.push(...records);

    if (buffer.upsertContact.length >= this.config.batchSize) {
      return this.flushBuffer(dbPath, 'upsertContact');
    }

    this.scheduleFlush(dbPath);
  }

  /**
   * Check whether email exists(based on message_id)
   * @param {string} dbPath - databasepath
   * @param {string} messageId - email message_id
   */
  async checkEmailExists(dbPath, messageId) {
    const worker = this.getOrCreateWorker(dbPath);
    const response = await this.sendMessage(worker, {
      type: 'checkEmailExists',
      payload: messageId
    });
    return response.result;
  }

  /**
   * Save a single email to the database
   * @param {string} dbPath - databasepath
   * @param {Object} email - emaildata
   */
  async saveSingleEmail(dbPath, email) {
    const worker = this.getOrCreateWorker(dbPath);
    const response = await this.sendMessage(worker, {
      type: 'saveSingleEmail',
      payload: email
    });
    return response.result;
  }

  /**
   * Auto-add contact(ifdoes not exist)
   * @param {string} dbPath - databasepath
   * @param {Object} contactData - contactdata {email, name, currentUserEmail}
   */
  async autoAddSingleContact(dbPath, contactData) {
    const worker = this.getOrCreateWorker(dbPath);
    const response = await this.sendMessage(worker, {
      type: 'autoAddSingleContact',
      payload: contactData
    });
    return response.result;
  }

  /**
   * Timer scheduling(prevent excessive waiting)
   * @private
   */
  scheduleFlush(dbPath) {
    // If a timer already exists, do not create a new one
    if (this.flushTimers.has(dbPath)) {
      return;
    }

    const timerId = setTimeout(() => {
      this.flushTimers.delete(dbPath);
      this.flushAllBuffers(dbPath).catch(err => {
        logger.error(`[BatchManager] Buffer flush failed: ${err.message}`);
      });
    }, this.config.flushInterval);

    this.flushTimers.set(dbPath, timerId);
  }

  /**
   * Flush a single buffer
   * @private
   */
  async flushBuffer(dbPath, operationType) {
    const buffer = this.buffers.get(dbPath);
    if (!buffer) return;

    const worker = this.getOrCreateWorker(dbPath);

    try {
      if (operationType === 'insertEmails' && buffer.insertEmails.length > 0) {
        const emails = buffer.insertEmails.splice(0);
        const response = await this.sendMessage(worker, {
          type: 'batchInsertEmails',
          payload: emails
        });
        return response.result;
      } else if (operationType === 'updateStatus' && buffer.updateStatus.length > 0) {
        const updates = buffer.updateStatus.splice(0);
        const response = await this.sendMessage(worker, {
          type: 'batchUpdateReadStatus',
          payload: updates
        });
        return response.result;
      } else if (operationType === 'upsertContact' && buffer.upsertContact.length > 0) {
        const records = buffer.upsertContact.splice(0);
        const response = await this.sendMessage(worker, {
          type: 'batchUpsertContact',
          payload: records
        });
        return response.result;
      }
    } catch (error) {
      logger.error(`[BatchManager] Buffer operation failed [${operationType}]: ${error.message}`);
      throw error;
    }
  }

  /**
   * Flush all buffers
   * @private
   */
  async flushAllBuffers(dbPath) {
    const buffer = this.buffers.get(dbPath);
    if (!buffer) return;

    const results = [];

    try {
      if (buffer.insertEmails.length > 0) {
        results.push(await this.flushBuffer(dbPath, 'insertEmails'));
      }
      if (buffer.updateStatus.length > 0) {
        results.push(await this.flushBuffer(dbPath, 'updateStatus'));
      }
      if (buffer.upsertContact.length > 0) {
        results.push(await this.flushBuffer(dbPath, 'upsertContact'));
      }
    } catch (error) {
      logger.error(`[BatchManager] Batch flush failed: ${error.message}`);
    }

    return results;
  }

  /**
   * Delete operation
   * @param {string} dbPath - database path
   * @param {string} table - table name
   * @param {string} whereClause - WHERE clause
   * @param {Array} params - parameters
   */
  async batchDelete(dbPath, table, whereClause, params = []) {
    // Flush the buffer first to ensure consistency
    await this.flushAllBuffers(dbPath);

    const worker = this.getOrCreateWorker(dbPath);
    const response = await this.sendMessage(worker, {
      type: 'batchDelete',
      payload: { table, whereClause, params }
    });
    return response.result;
  }

  /**
   * Get statistics
   * @param {string} dbPath - databasepath
   */
  async getStats(dbPath) {
    // Flush the buffer first to ensure statistics are accurate
    await this.flushAllBuffers(dbPath);

    const worker = this.getOrCreateWorker(dbPath);
    const response = await this.sendMessage(worker, {
      type: 'getStats'
    });
    return response.result;
  }

  /**
   * Database cleanup and optimization
   * @param {string} dbPath - databasepath
   */
  async vacuumAndOptimize(dbPath) {
    // Flush the buffer first to ensure data safety
    await this.flushAllBuffers(dbPath);

    const worker = this.getOrCreateWorker(dbPath);
    const response = await this.sendMessage(worker, {
      type: 'vacuumAndOptimize'
    });
    return response.result;
  }

  /**
   * Immediately flush all buffers for the specified database
   * @param {string} dbPath - databasepath
   */
  async flush(dbPath) {
    // Cancel timer
    const timerId = this.flushTimers.get(dbPath);
    if (timerId) {
      clearTimeout(timerId);
      this.flushTimers.delete(dbPath);
    }

    return this.flushAllBuffers(dbPath);
  }

  /**
   * Close the Worker for a specific database
   * @param {string} dbPath - databasepath
   */
  async closeWorker(dbPath) {
    // Flush the buffer first
    await this.flushAllBuffers(dbPath);

    // Cancel timer
    const timerId = this.flushTimers.get(dbPath);
    if (timerId) {
      clearTimeout(timerId);
      this.flushTimers.delete(dbPath);
    }

    const worker = this.workers.get(dbPath);
    if (worker) {
      await this.sendMessage(worker, { type: 'close' });
      worker.terminate();
      this.workers.delete(dbPath);
    }

    // Delete the buffer
    this.buffers.delete(dbPath);
  }

  /**
   * Close all Workers
   */
  async closeAllWorkers() {
    const promises = [];
    for (const dbPath of this.workers.keys()) {
      promises.push(this.closeWorker(dbPath));
    }
    await Promise.all(promises);
  }

  /**
   * Update config
   * @param {Object} config - config object
   */
  updateConfig(config) {
    Object.assign(this.config, config);
  }
}

// Create the global instance
let batchManagerInstance = null;

function getInstance() {
  if (!batchManagerInstance) {
    batchManagerInstance = new SQLiteBatchManager();
  }
  return batchManagerInstance;
}

module.exports = {
  getInstance,
  SQLiteBatchManager
};
