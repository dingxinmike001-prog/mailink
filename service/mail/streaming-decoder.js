/**
 * Streaming Worker-based decoder manager

 * Use Worker threads to handle Base64/QP decoding to avoid main thread blocking
 * Supports multiple concurrent decoding tasks
 */

const { Transform } = require('stream');
const { Worker } = require('worker_threads');
const path = require('path');
const logger = require('../logger');

/**
 * Worker pool management
 */
class DecoderWorkerPool {
  constructor(poolSize = 4) {
    this.poolSize = poolSize;
    this.workers = [];
    this.available = [];
    this.waiting = [];
    this._initialized = false;
  }

  async initialize() {
    if (this._initialized) return;
    
    for (let i = 0; i < this.poolSize; i++) {
      // Worker files are located in service/workers/ directory
      const workerPath = path.join(__dirname, '..', 'workers', 'decoder-stream.worker.js');
      const worker = new Worker(workerPath);
      this.workers.push({ id: i, worker, inUse: false });
      this.available.push(i);
    }
    this._initialized = true;
    logger.info(`[DecoderPool] initialization completed, pool size=${this.poolSize}`);
  }

  /**
   * Get an available worker
   */
  async acquire() {
    if (!this._initialized) {
      await this.initialize();
    }

    return new Promise((resolve) => {
      if (this.available.length > 0) {
        const id = this.available.shift();
        this.workers[id].inUse = true;
        resolve(this.workers[id]);
      } else {
        this.waiting.push(resolve);
      }
    });
  }

  /**
   * Release worker back to pool
   */
  release(id) {
    this.workers[id].inUse = false;
    
    if (this.waiting.length > 0) {
      const resolve = this.waiting.shift();
      this.workers[id].inUse = true;
      resolve(this.workers[id]);
    } else {
      this.available.push(id);
    }
  }

  /**
   * Destroy all workers
   */
  async terminate() {
    for (const w of this.workers) {
      try {
        await w.worker.terminate();
      } catch (e) {
        logger.warn(`[DecoderPool] destroyworkerfailed: ${e.message}`);
      }
    }
    this.workers = [];
    this.available = [];
    this._initialized = false;
  }
}

// Global Worker pool
const globalPool = new DecoderWorkerPool(4);

/**
 * WorkerBasedDecoderStream
 * Use Worker threads to handle streaming decoding
 * 
 * Design features:
 * 1. Main thread only handles stream management and I/O
 * 2. Worker handles compute-intensive base64/QP decoding
 * 3. Adapts to backpressure control
 * 4. Automatic chunk batching (avoids Worker message queue backlog)
 */
class WorkerBasedDecoderStream extends Transform {
  constructor(encoding = 'BASE64', options = {}) {
    super(options);
    this.encoding = encoding;
    this.workerEntry = null;
    this.workerReady = false;
    this.buffer = [];
    this.flushScheduled = false;
    this.destroyed = false;

    // Backpressure: threshold for buffered chunks count
    this.bufferThreshold = options.bufferThreshold || 10;
    this.currentBufferSize = 0;

    this._initWorker();
  }

  async _initWorker() {
    try {
      await globalPool.initialize();
      this.workerEntry = await globalPool.acquire();

      // Initialize decoder in worker
      const initPromise = new Promise((resolve, reject) => {
        const handler = (msg) => {
          if (!this.workerEntry) return;
          if (msg.cmd === 'init') {
            this.workerEntry.worker.removeListener('message', handler);
            resolve();
          } else if (msg.cmd === 'error') {
            this.workerEntry.worker.removeListener('message', handler);
            reject(new Error(msg.message));
          }
        };
        this.workerEntry.worker.on('message', handler);
        this.workerEntry.worker.postMessage({ cmd: 'init', encoding: this.encoding });
      });

      await initPromise;
      if (!this.workerEntry || this.destroyed) return;
      this.workerReady = true;

      this._boundHandleWorkerMessage = this._handleWorkerMessage.bind(this);
      this._boundHandleWorkerError = this._handleWorkerError.bind(this);
      this.workerEntry.worker.on('message', this._boundHandleWorkerMessage);
      this.workerEntry.worker.on('error', this._boundHandleWorkerError);

      // Process chunks buffered during initialization
      if (this.buffer.length > 0) {
        logger.info(`[DecoderStream] processing buffered ${this.buffer.length} chunks`);
        for (const bufferedChunk of this.buffer) {
          if (bufferedChunk && bufferedChunk.length > 0) {
            this.currentBufferSize++;
            const input = bufferedChunk.toString('ascii');
            this.workerEntry.worker.postMessage({ cmd: 'decode', data: input });
          }
        }
        this.buffer = [];
      }
    } catch (error) {
      logger.error(`[DecoderStream] Workerinitialization failed: ${error.message}`);
      this.destroy(error);
    }
  }

  _transform(chunk, encoding, callback) {
    if (this.destroyed) {
      return callback(new Error('stream closed'));
    }

    if (!this.workerReady) {
      // Worker initializing, buffer chunk
      this.buffer.push(chunk);
      return callback();
    }

    // Skip empty chunk
    if (!chunk || chunk.length === 0) {
      return callback();
    }

    this.currentBufferSize++;

    // Send to Worker for processing
    if (!this.workerEntry) return callback();
    const input = chunk.toString('ascii');
    this.workerEntry.worker.postMessage({ cmd: 'decode', data: input });

    // Backpressure control: pause input if too many buffered chunks
    if (this.currentBufferSize > this.bufferThreshold) {
      // Do not callback immediately; continue after Worker processes enough chunks
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        setImmediate(() => {
          this.flushScheduled = false;
          callback();
        });
      }
    } else {
      callback();
    }
  }

  _flush(callback) {
    if (!this.workerReady || !this.workerEntry) {
      const waitAndFlush = () => {
        if (this.destroyed) return callback();
        if (this.workerReady && this.workerEntry) {
          this._doFlush(callback);
        } else {
          setTimeout(waitAndFlush, 10);
        }
      };
      waitAndFlush();
      return;
    }

    this._doFlush(callback);
  }

  _doFlush(callback) {
    // Mark whether flushed message has been received
    let flushedReceived = false;
    let pendingDecodedCount = 0;
    let flushTimeout = null;

    const flushPromise = new Promise((resolve) => {
      const flushHandler = (msg) => {
        if (msg.cmd === 'decoded') {
          // Count pending decoded messages
          pendingDecodedCount++;
          if (msg.data) {
            this.push(msg.data);
          }
          this.currentBufferSize--;
          pendingDecodedCount--;
          
          // If flushed received and all decoded messages processed, can resolve
          if (flushedReceived && pendingDecodedCount === 0) {
            if (flushTimeout) clearTimeout(flushTimeout);
            resolve();
          }
        } else if (msg.cmd === 'flushed') {
          flushedReceived = true;
          // Push flushed data
          if (msg.data) {
            this.push(msg.data);
          }
          
          // If all decoded messages processed, resolve immediately
          // Otherwise wait a short time for remaining decoded messages to arrive
          if (pendingDecodedCount === 0) {
            flushTimeout = setTimeout(() => {
              resolve();
            }, 50); // Allow 50ms for remaining decoded messages to arrive
          }
        } else if (msg.cmd === 'error') {
          logger.error(`[DecoderStream] Workererror: ${msg.message}`);
          if (flushTimeout) clearTimeout(flushTimeout);
          resolve(); // Resolve even on error to avoid getting stuck
        }
      };
      
      // Replace temporary handler function
      this.workerEntry.worker.removeListener('message', this._boundHandleWorkerMessage);
      this.workerEntry.worker.on('message', flushHandler);
      
      // Send flush command
      this.workerEntry.worker.postMessage({ cmd: 'flush' });
    });

    flushPromise
      .then(() => {
        // Clean up worker
        if (this.workerEntry) {
          this.workerEntry.worker.removeAllListeners('message');
          globalPool.release(this.workerEntry.id);
          this.workerEntry = null;
        }
        callback();
      })
      .catch(callback);
  }

  _handleWorkerMessage(msg) {
    if (this.destroyed || !this.workerEntry) return;

    if (msg.cmd === 'decoded' && msg.data) {
      this.push(msg.data);
      this.currentBufferSize--;
    } else if (msg.cmd === 'error') {
      logger.error(`[DecoderStream] Workererror: ${msg.message}`);
      this.destroy(new Error(`Workerdecode error: ${msg.message}`));
    }
  }

  _handleWorkerError(error) {
    if (!this.destroyed) {
      logger.error(`[DecoderStream] Workerexception: ${error.message}`);
      this.destroy(error);
    }
  }

  destroy(error) {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.workerEntry) {
      try {
        this.workerEntry.worker.postMessage({ cmd: 'end' });
        globalPool.release(this.workerEntry.id);
      } catch (e) {
        logger.warn(`[DecoderStream] cleanedworkerfailed: ${e.message}`);
      }
      this.workerEntry = null;
    }

    if (error) {
      super.destroy(error);
    } else {
      super.destroy();
    }
  }
}

/**
 * Create Worker-based decoding stream
 * @param {string} encoding - Encoding type: 'BASE64', 'QP', '7BIT'...
 * @param {object} options - Transform stream options
 * @returns {Transform} Decoding stream
 */
function createDecoderStream(encoding = 'BASE64', options = {}) {
  return new WorkerBasedDecoderStream(encoding, options);
}

/**
 * Clean up global Worker pool (called when app closes)
 */
async function cleanupDecoderPool() {
  try {
    await globalPool.terminate();
    logger.info('[DecoderPool] cleaned');
  } catch (e) {
    logger.error(`[DecoderPool] clean failed: ${e.message}`);
  }
}

module.exports = {
  createDecoderStream,
  cleanupDecoderPool,
  WorkerBasedDecoderStream
};
