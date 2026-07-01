const { Worker } = require('worker_threads');
const path = require('path');
const EventEmitter = require('events');

const BATCH_SIZE = 10;
const BATCH_INTERVAL = 30;

class FileWriterManager extends EventEmitter {
  constructor() {
    super();
    this.worker = null;
    this.pendingRequests = new Map();
    this.nextRequestId = 0;
    this.isReady = false;
    this.batchQueue = [];
    this.batchTimer = null;
    this.initWorker();
  }

  /**
   * Initialize Worker thread
   */
  initWorker() {
    // Create Worker instance
    this.worker = new Worker(path.join(__dirname, 'file-writer.worker.js'));

    // Listen to Worker messages
    this.worker.on('message', (response) => {
      if (response && response.type === 'telemetry') {
        this.emit('telemetry', response);
        return;
      }
      const { id, success, error } = response;
      const pendingRequest = this.pendingRequests.get(id);

      if (pendingRequest) {
        const { resolve, reject } = pendingRequest;
        if (success) {
          resolve(true);
        } else {
          reject(new Error(error));
        }
        this.pendingRequests.delete(id);
      }
    });

    // Listen to Worker errors
    this.worker.on('error', (error) => {
      console.error('File Writer Worker Error:', error);
      // Reject all pending requests
      for (const [id, { reject }] of this.pendingRequests) {
        reject(error);
      }
      this.pendingRequests.clear();
      // Reinitialize Worker
      this.initWorker();
    });

    // Listen to Worker exit
    this.worker.on('exit', (code) => {
      if (code !== 0) {
        console.error(`File Writer Worker exited with code ${code}`);
        // Reject all pending requests
        for (const [id, { reject }] of this.pendingRequests) {
          reject(new Error(`Worker exited with code ${code}`));
        }
        this.pendingRequests.clear();
        // Reinitialize Worker
        this.initWorker();
      }
    });

    this.isReady = true;
  }

  /**
   * Send file write request to Worker
   * @param {string} filePath - file path
   * @param {string} content - file content
   * @param {boolean} append - whether append mode
   * @param {boolean} flush - [NEW] whether to flush to disk immediately
   * @returns {Promise<boolean>} - Promise representing write result
   */
  writeFile(filePath, content, positionOrAppend = 0, appendFlag, flushFlag) {
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId++;

      const append = typeof appendFlag === 'boolean'
        ? appendFlag
        : (typeof positionOrAppend === 'boolean' ? positionOrAppend : false);

      const position = typeof positionOrAppend === 'number' ? positionOrAppend : 0;
      
      // [NEW] Support flush parameter
      const flush = typeof flushFlag === 'boolean' ? flushFlag : false;

      // Store pending requests
      this.pendingRequests.set(id, { resolve, reject });

      // Send message to Worker
      this.worker.postMessage({
        type: 'write-file',
        id,
        filePath,
        content,
        position,
        append,
        flush
      });
    });
  }

  /**
   * Close file write stream
   * @param {string} filePath - file path
   * @returns {Promise<boolean>}
   */
  closeFile(filePath) {
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId++;
      this.pendingRequests.set(id, { resolve, reject });

      this.worker.postMessage({
        type: 'close-file',
        id,
        filePath
      });
    });
  }

  /**
   * Close Worker thread
   */
  close() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.isReady = false;
    }
  }

  /**
   * Batch write files
   * @param {Array<{filePath: string, content: Buffer, position: number}>} files
   * @returns {Promise<Array<{success: boolean, error?: string}>>}
   */
  batchWrite(files) {
    return new Promise((resolve, reject) => {
      if (!files || files.length === 0) {
        resolve([]);
        return;
      }

      const id = this.nextRequestId++;
      const results = new Array(files.length);
      let completed = 0;

      files.forEach((file, index) => {
        const fileId = `${id}_${index}`;
        
        const handleResult = (success, error) => {
          results[index] = { success, error };
          completed++;
          
          if (completed === files.length) {
            resolve(results);
          }
        };

        this.pendingRequests.set(fileId, {
          resolve: handleResult,
          reject: (err) => handleResult(false, err.message)
        });
      });

      this.worker.postMessage({
        type: 'batch-write',
        id,
        files: files.map(f => ({
          filePath: f.filePath,
          content: f.content,
          position: f.position
        }))
      });
    });
  }

  /**
   * Add file to batch queue
   * @param {Object} file - {filePath, content, position}
   * @returns {Promise}
   */
  addToBatch(file) {
    return new Promise((resolve, reject) => {
      this.batchQueue.push({ ...file, resolve, reject });
      
      if (this.batchQueue.length >= BATCH_SIZE) {
        this.processBatchQueue();
      } else if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => {
          this.processBatchQueue();
        }, BATCH_INTERVAL);
      }
    });
  }

  /**
   * Process batch queue
   */
  async processBatchQueue() {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    if (this.batchQueue.length === 0) return;

    const batch = this.batchQueue.splice(0, BATCH_SIZE);
    
    try {
      const files = batch.map(f => ({
        filePath: f.filePath,
        content: f.content,
        position: f.position
      }));

      const results = await this.batchWrite(files);

      batch.forEach((item, index) => {
        const result = results[index];
        if (result && result.success) {
          item.resolve(true);
        } else if (item.reject) {
          item.reject(new Error(result?.error || 'Batch write failed'));
        }
      });
    } catch (error) {
      batch.forEach(item => {
        if (item.reject) {
          item.reject(error);
        }
      });
    }
  }
}

// Create singleton instance
const fileWriterManager = new FileWriterManager();

module.exports = fileWriterManager;
