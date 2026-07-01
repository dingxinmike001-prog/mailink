/**
 * Attachment download manager
 * Manages attachment download Worker instances
 * - Single global Worker instance
 * - Supports task queue (up to 100 concurrent tasks)
 * - Auto timeout control and error recovery
 */

const path = require('path');
const BaseWorkerManager = require('../base-worker-manager');

class AttachmentDownloadManager extends BaseWorkerManager {
  constructor() {
    super({ maxPendingTasks: 100, cleanupInterval: 60000 });
  }

  getWorkerPath() {
    return path.join(__dirname, 'workers/attachment-download.worker.js');
  }

  getManagerName() {
    return 'AttachmentDownloadManager';
  }

  getDefaultStats() {
    return {
      totalSaved: 0,
      totalFailed: 0,
      totalBytesSaved: 0,
      totalTimeMs: 0
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

    // Handle batch progress
    if (response.type === 'batch-progress') {
      const { id, processed, total, successCount, failCount } = response;
      const pendingTask = this.pendingTasks.get(id);
      if (pendingTask && pendingTask.onProgress) {
        try {
          pendingTask.onProgress({
            processed,
            total,
            percentage: Math.round((processed / total) * 100),
            successCount,
            failCount
          });
        } catch (e) {
          logger.error('[AttachmentDownloadManager] onProgress callback error:', e);
        }
      }
      return true;
    }

    // Handle Ping/Pong
    if (response.type === 'pong') {
      return true;
    }

    return false;
  }

  handleMessageResult(response, pendingTask) {
    const { success, data, error } = response;

    if (success) {
      if (data.results) {
        // Batch save results
        const summary = data.summary || {};
        this.stats.totalSaved += summary.succeeded || 0;
        this.stats.totalFailed += summary.failed || 0;
        this.stats.totalBytesSaved += summary.totalBytes || 0;
        this.stats.totalTimeMs += summary.duration || 0;
      } else {
        // Single save result
        this.stats.totalSaved++;
        this.stats.totalBytesSaved += data.size || 0;
        this.stats.totalTimeMs += data.duration || 0;
      }
      pendingTask.resolve(data);
    } else {
      this.stats.totalFailed++;
      logger.warn(`[AttachmentDownloadManager] Save failed for task ${response.id}: ${error}`);
      pendingTask.reject(new Error(error || 'Unknown error'));
    }
  }

  _recordFailureStats(count) {
    this.stats.totalFailed += count;
  }

  _recordCleanupFailure() {
    this.stats.totalFailed++;
  }

  _logCleanupStats(pendingCount) {
    logger.debug(
      `[AttachmentDownloadManager] Stats: pending=${pendingCount}, ` +
      `total=${this.stats.totalSaved}, failed=${this.stats.totalFailed}, ` +
      `bytes=${this.stats.totalBytesSaved}`
    );
  }

  getStats() {
    return {
      ...super.getStats(),
      avgBytesPerTask: this.stats.totalSaved > 0 
        ? Math.round(this.stats.totalBytesSaved / this.stats.totalSaved) 
        : 0
    };
  }

  async saveAttachment(filePath, content, options = {}) {
    const taskId = this._generateTaskId('save');
    const timeout = options.timeout || 15000;

    return this.executeTask(taskId, {
      id: taskId,
      type: 'save-attachment',
      filePath,
      content,
      options
    }, timeout);
  }

  /**
   * Batch save attachments (processed once in Worker)
   * 3-5x faster than saving one by one
   */
  async saveBatchAttachmentsDirectly(attachments, options = {}) {
    const taskId = this._generateTaskId('batch');
    const timeout = options.timeout || (30000 + attachments.length * 1000); // Base 30s + 1s per file
    const onProgress = options.onProgress || (() => {});

    return this.executeTask(taskId, {
      id: taskId,
      type: 'save-batch-attachments',
      attachments,
      options: { ...options, timeout: undefined }
    }, timeout, { onProgress });
  }

  /**
   * Batch save attachments (sequential one by one)
   */
  async saveAttachmentBatch(attachments, options = {}) {
    const { batchExecute } = require('./batch-utils');
    return batchExecute(attachments, (att) => this.saveAttachment(att.filePath, att.content, att.options), {
      concurrency: options.concurrency || 5,
      stopOnError: options.stopOnError || false,
      logLabel: 'AttachmentDownloadManager'
    });
  }
}

// Import logger (used for logging in subclasses)
const logger = require('../logger');

// Global singleton
let instance = null;

function getInstance() {
  if (!instance) {
    instance = new AttachmentDownloadManager();
  }
  return instance;
}

module.exports = {
  getInstance,
  AttachmentDownloadManager
};
