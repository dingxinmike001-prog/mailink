const { Worker } = require('worker_threads');
const path = require('path');
const EventEmitter = require('events');

const logger = require('../../logger');

class FileCopyManager extends EventEmitter {
  constructor() {
    super();
    this.worker = null;
    this.pendingRequests = new Map();
    this.nextRequestId = 0;
    this.isReady = false;
    this.progressCallbacks = new Map();
    this.initWorker();
  }

  /**
   * Initialize Worker thread
   */
  initWorker() {
    try {
      // Create Worker instance
      this.worker = new Worker(path.join(__dirname, 'file-copy.worker.js'));

      // Listen to Worker messages
      this.worker.on('message', (response) => {
        // Process progress report
        if (response.type === 'progress') {
          const { id, progress, bytesCopied, totalSize } = response;
          const progressCallback = this.progressCallbacks.get(id);
          if (progressCallback) {
            progressCallback({ progress, bytesCopied, totalSize });
          }
          this.emit('progress', { id, progress, bytesCopied, totalSize });
          return;
        }

        // Handle copy result
        const { id, success, error, filePath, fileSize, fileName } = response;
        const pendingRequest = this.pendingRequests.get(id);

        if (pendingRequest) {
          const { resolve, reject } = pendingRequest;
          if (success) {
            resolve({ success: true, filePath, fileSize, fileName });
          } else {
            reject(new Error(error));
          }
          this.pendingRequests.delete(id);
          this.progressCallbacks.delete(id);
        }
      });

      // Listen to Worker errors
      this.worker.on('error', (error) => {
        logger.error('[FileCopyManager] Worker Error:', error);
        // Reject all pending requests
        for (const [id, { reject }] of this.pendingRequests) {
          reject(error);
        }
        this.pendingRequests.clear();
        this.progressCallbacks.clear();
        // Reinitialize Worker
        this.initWorker();
      });

      // Listen to Worker exit
      this.worker.on('exit', (code) => {
        if (code !== 0) {
          logger.error(`[FileCopyManager] Worker exited with code ${code}`);
          // Reject all pending requests
          for (const [id, { reject }] of this.pendingRequests) {
            reject(new Error(`Worker exited with code ${code}`));
          }
          this.pendingRequests.clear();
          this.progressCallbacks.clear();
          // Reinitialize Worker
          this.initWorker();
        }
      });

      this.isReady = true;
      logger.info('[FileCopyManager] Worker initialization successful');
    } catch (err) {
      logger.error('[FileCopyManager] Worker initialization failed:', err);
      throw err;
    }
  }

  /**
   * Copy file to specified directory
   * @param {string} sourcePath - source file path
   * @param {string} targetPath - target file path
   * @param {Object} options - copy options
   * @param {Function} onProgress - progress callback
   * @returns {Promise<{success: boolean, filePath: string, fileSize: number, fileName: string}>}
   */
  copyFile(sourcePath, targetPath, options = {}, onProgress = null) {
    return new Promise((resolve, reject) => {
      if (!this.isReady || !this.worker) {
        reject(new Error('FileCopyManager not initialized'));
        return;
      }

      const id = this.nextRequestId++;

      // Store pending requests
      this.pendingRequests.set(id, { resolve, reject });

      // Store progress callback
      if (onProgress && typeof onProgress === 'function') {
        this.progressCallbacks.set(id, onProgress);
      }

      // Send message to Worker
      this.worker.postMessage({
        type: 'copy-file',
        id,
        sourcePath,
        targetPath,
        options
      });

      logger.info(`[FileCopyManager] Sending copy request: ${sourcePath} -> ${targetPath}, ID: ${id}`);
    });
  }

  /**
   * Copy file and preserve metadata
   * @param {string} sourcePath - source file path
   * @param {string} targetPath - target file path
   * @param {Object} options - copy options
   * @param {Function} onProgress - progress callback
   * @returns {Promise<{success: boolean, filePath: string, fileSize: number, fileName: string}>}
   */
  copyFileWithMetadata(sourcePath, targetPath, options = {}, onProgress = null) {
    return new Promise((resolve, reject) => {
      if (!this.isReady || !this.worker) {
        reject(new Error('FileCopyManager not initialized'));
        return;
      }

      const id = this.nextRequestId++;

      // Store pending requests
      this.pendingRequests.set(id, { resolve, reject });

      // Store progress callback
      if (onProgress && typeof onProgress === 'function') {
        this.progressCallbacks.set(id, onProgress);
      }

      // Send message to Worker
      this.worker.postMessage({
        type: 'copy-file-with-metadata',
        id,
        sourcePath,
        targetPath,
        options
      });

      logger.info(`[FileCopyManager] Sending copy request (with metadata): ${sourcePath} -> ${targetPath}, ID: ${id}`);
    });
  }

  /**
   * Copy file to sends directory (specifically for sending files)
   * @param {string} sourcePath - source file path
   * @param {string} sendsDir - sends directory path
   * @param {string} transferId - transfer ID
   * @param {Function} onProgress - progress callback
   * @returns {Promise<{success: boolean, filePath: string, fileName: string}>}
   */
  async copyFileToSends(sourcePath, sendsDir, transferId, onProgress = null) {
    try {
      const path = require('path');
      const fs = require('fs');

      // Check source file
      if (!fs.existsSync(sourcePath)) {
        throw new Error(`Source file does not exist: ${sourcePath}`);
      }

      // Ensure sends directory exists
      if (!fs.existsSync(sendsDir)) {
        fs.mkdirSync(sendsDir, { recursive: true });
      }

      // Generate target file name
      const fileName = path.basename(sourcePath);
      let targetFileName;

      if (transferId) {
        targetFileName = `${transferId}-${fileName}`;
      } else {
        const timestamp = Date.now();
        const randomStr = Math.random().toString(36).substr(2, 9);
        targetFileName = `file-${timestamp}-${randomStr}-${fileName}`;
      }

      const targetPath = path.join(sendsDir, targetFileName);

      // Use Worker thread to copy file
      const result = await this.copyFile(sourcePath, targetPath, {}, onProgress);

      return {
        success: true,
        filePath: result.filePath,
        fileName: targetFileName,
        fileSize: result.fileSize
      };
    } catch (err) {
      logger.error(`[FileCopyManager] Failed to copy file to sends directory: ${sourcePath}`, err);
      throw err;
    }
  }

  /**
   * Close Worker thread
   */
  close() {
    if (this.worker) {
      // Reject all pending requests
      for (const [id, { reject }] of this.pendingRequests) {
        reject(new Error('FileCopyManager is closed'));
      }
      this.pendingRequests.clear();
      this.progressCallbacks.clear();

      this.worker.terminate();
      this.worker = null;
      this.isReady = false;
      logger.info('[FileCopyManager] Worker closed');
    }
  }

  /**
   * Get current pending request count
   * @returns {number}
   */
  getPendingCount() {
    return this.pendingRequests.size;
  }

  /**
   * Check if ready
   * @returns {boolean}
   */
  isWorkerReady() {
    return this.isReady && this.worker !== null;
  }
}

// Create singleton instance
const fileCopyManager = new FileCopyManager();

module.exports = fileCopyManager;
