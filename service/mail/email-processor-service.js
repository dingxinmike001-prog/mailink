/**
 * Email processing service
 * Integrates queue manager and Worker to provide async email parsing and saving
 */

const { getQueueManager } = require('./email-queue-manager');
const logger = require('../logger');
const EventEmitter = require('events');

/**
 * Email processing service class
 * Encapsulates queue operations and provides a clean API
 */
class EmailProcessorService extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.queueManager = getQueueManager(options);
    this.isInitialized = false;
    
    // Listen to queue events
    this._setupEventListeners();
  }
  
  /**
   * Set event listeners
   */
  _setupEventListeners() {
    this.queueManager.on('taskCompleted', (data) => {
      this.emit('emailProcessed', data);
    });
    
    this.queueManager.on('taskFailed', (data) => {
      this.emit('emailFailed', data);
    });
  }
  
  /**
   * Initialize service
   */
  async initialize() {
    if (this.isInitialized) return;
    
    logger.info('[EmailProcessorService] initialized email processing service');
    this.isInitialized = true;
    this.emit('initialized');
  }
  
  /**
   * Generic method to submit queue tasks
   * @param {Object} task - Task definition { action, params }
   * @param {Object} taskOptions - Task options
   * @param {string} taskOptions.priority - Priority
   * @param {number} taskOptions.timeout - Timeout
   * @param {Object} hooks - Hook callbacks
   * @param {Function} [hooks.onSuccess] - Success callback (result) => void
   * @param {string} hooks.logLabel - Log label
   * @param {string} hooks.errorLabel - Error log label
   * @returns {Promise<Object>} - Task result data
   */
  async _submitTask(task, taskOptions, hooks = {}) {
    const { priority, timeout } = taskOptions;
    const { logLabel, errorLabel, onSuccess } = hooks;

    logger.debug(`[EmailProcessorService] ${logLabel}, priority=${priority}`);

    try {
      const result = await this.queueManager.addTask(task, { priority, timeout });
      if (onSuccess) onSuccess(result);
      return result.data;
    } catch (error) {
      logger.error(`[EmailProcessorService] ${errorLabel}:`, error);
      throw error;
    }
  }

  /**
   * Parse a single email (async)
   * @param {Buffer} streamBuffer - Email stream buffer
   * @param {number} uid - Email UID
   * @param {string} username - Username
   * @param {Object} options - Options
   * @returns {Promise<Object>} - Parsing result
   */
  async parseEmail(streamBuffer, uid, username, options = {}) {
    const priority = options.isSignaling ? 'critical' : 'normal';
    return this._submitTask(
      { action: 'parse', params: { streamBuffer, uid, username } },
      { priority, timeout: options.timeout || 30000 },
      {
        logLabel: `added email parse task UID=${uid}`,
        errorLabel: `email parse failed UID=${uid}`
      }
    );
  }

  /**
   * Parse and save email (async)
   * @param {Buffer} streamBuffer - Email stream buffer
   * @param {number} uid - Email UID
   * @param {string} username - Username
   * @param {Object} options - Options
   * @returns {Promise<Object>} - Save result
   */
  async parseAndSaveEmail(streamBuffer, uid, username, options = {}) {
    const isSignaling = options.isSignaling || false;
    const priority = isSignaling ? 'critical' : 'normal';
    return this._submitTask(
      { action: 'parseAndSave', params: { streamBuffer, uid, username } },
      { priority, timeout: options.timeout || 30000 },
      {
        logLabel: `added email parse-save task UID=${uid}`,
        errorLabel: `email parse-save failed UID=${uid}`,
        onSuccess: (result) => {
          this.emit('emailSaved', { uid, username, emailId: result.data.emailId, isSignaling });
        }
      }
    );
  }

  /**
   * Batch parse and save emails
   * @param {Array} emails - Email array [{streamBuffer, uid}, ...]
   * @param {string} username - Username
   * @param {Object} options - Options
   * @returns {Promise<Object>} - Batch processing result
   */
  async batchParseAndSave(emails, username, options = {}) {
    if (!emails || emails.length === 0) {
      return { success: true, total: 0, saved: 0 };
    }

    logger.info(`[EmailProcessorService] batch processing ${emails.length} emails`);

    return this._submitTask(
      { action: 'batchParseAndSave', params: { emails, username } },
      { priority: options.priority || 'normal', timeout: options.timeout || 120000 },
      {
        logLabel: 'batch parse-save task',
        errorLabel: 'batch processing failed',
        onSuccess: (result) => {
          this.emit('batchCompleted', {
            username,
            total: result.data.total,
            saved: result.data.saved,
            failed: result.data.failed
          });
        }
      }
    );
  }
  
  /**
   * Quickly queue an email (enqueue only, do not wait for result)
   * @param {Buffer} streamBuffer - Email stream buffer
   * @param {number} uid - Email UID
   * @param {string} username - Username
   * @param {boolean} isSignaling - Whether it is a signaling email
   */
  queueEmail(streamBuffer, uid, username, isSignaling = false) {
    const priority = isSignaling ? 'critical' : 'normal';
    
    // Use fire-and-forget mode, do not wait for result
    this.queueManager.addTask({
      action: 'parseAndSave',
      params: {
        streamBuffer,
        uid,
        username
      }
    }, {
      priority,
      timeout: 30000
    }).then((result) => {
      this.emit('emailSaved', {
        uid,
        username,
        emailId: result.data.emailId,
        isSignaling
      });
    }).catch((error) => {
      logger.error(`[EmailProcessorService] queue email processing failed UID=${uid}:`, error);
      this.emit('emailFailed', {
        uid,
        username,
        error
      });
    });
  }
  
  /**
   * Get service status
   */
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      queueStatus: this.queueManager.getStatus()
    };
  }
  
  /**
   * Clear queue
   */
  clearQueue() {
    return this.queueManager.clearQueue();
  }
  
  /**
   * Graceful shutdown
   */
  async shutdown(timeout = 30000) {
    logger.info('[EmailProcessorService] closed email processing service');
    await this.queueManager.shutdown(timeout);
    this.isInitialized = false;
    this.emit('shutdown');
  }
}

// Singleton instance
let instance = null;

/**
 * Get email processing service instance
 */
function getEmailProcessorService(options = {}) {
  if (!instance) {
    instance = new EmailProcessorService(options);
  }
  return instance;
}

/**
 * Reset email processing service instance
 */
function resetEmailProcessorService() {
  if (instance) {
    instance.shutdown().catch(() => {});
    instance = null;
  }
}

module.exports = {
  EmailProcessorService,
  getEmailProcessorService,
  resetEmailProcessorService
};
