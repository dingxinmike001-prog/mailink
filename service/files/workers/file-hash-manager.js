/**
 * File hash calculation Worker manager
 * Based on BaseWorkerManager for Worker thread management of file hash calculation
 */

const BaseWorkerManager = require('../../base-worker-manager');
const path = require('path');

class FileHashManager extends BaseWorkerManager {
  constructor(options = {}) {
    super(options);
  }

  getWorkerPath() {
    return path.join(__dirname, 'file-hash.worker.js');
  }

  getManagerName() {
    return 'FileHashManager';
  }

  getDefaultStats() {
    return {
      totalCalculated: 0,
      totalFailed: 0,
      totalTimeout: 0,
      avgDuration: 0
    };
  }

  /**
   * Calculate file SHA256 hash
   * @param {string} filePath - file path
   * @param {number} timeout - timeout in milliseconds, default 5 minutes
   * @returns {Promise<string>} - hexadecimal hash value
   */
  async calculateFileHash(filePath, timeout = 300000) {
    const taskId = this._generateTaskId('file-hash');
    
    return this.executeTask(
      taskId,
      {
        type: 'calculate-file-hash',
        id: taskId,
        filePath
      },
      timeout
    ).then(result => result.hash);
  }

  /**
   * Calculate data SHA256 hash
   * @param {Buffer|string} data - data
   * @param {number} timeout - timeout in milliseconds, default 30 seconds
   * @returns {Promise<string>} - hexadecimal hash value
   */
  async calculateDataHash(data, timeout = 30000) {
    const taskId = this._generateTaskId('data-hash');
    
    return this.executeTask(
      taskId,
      {
        type: 'calculate-data-hash',
        id: taskId,
        data
      },
      timeout
    ).then(result => result.hash);
  }

  handleMessageResult(response, pendingTask) {
    const { success, hash, error } = response;
    if (success) {
      pendingTask.resolve({ hash });
    } else {
      this.stats.totalFailed = (this.stats.totalFailed || 0) + 1;
      pendingTask.reject(new Error(error || 'Hash calculation failed'));
    }
  }

  _recordSuccessStats(duration) {
    this.stats.totalCalculated = (this.stats.totalCalculated || 0) + 1;
    // Update average duration
    const count = this.stats.totalCalculated;
    this.stats.avgDuration = ((this.stats.avgDuration * (count - 1)) + duration) / count;
  }

  _recordTimeoutFailure(taskId) {
    this.stats.totalTimeout = (this.stats.totalTimeout || 0) + 1;
    this.stats.totalFailed = (this.stats.totalFailed || 0) + 1;
  }

  _logCleanupStats(pendingCount) {
    // Reduce log output, only log when there are pending tasks
    if (pendingCount > 0) {
      super._logCleanupStats(pendingCount);
    }
  }
}

// Export singleton instance
let instance = null;

function getFileHashManager() {
  if (!instance) {
    instance = new FileHashManager();
  }
  return instance;
}

function resetFileHashManager() {
  if (instance) {
    instance.shutdown();
    instance = null;
  }
}

module.exports = {
  FileHashManager,
  getFileHashManager,
  resetFileHashManager
};
