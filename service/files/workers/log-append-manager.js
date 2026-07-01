const { Worker } = require('worker_threads');
const path = require('path');
const EventEmitter = require('events');
const logger = require('../../logger');

const LOG_APPEND_TRACE =
  process.env.MAILINK_LOG_APPEND_TRACE === '1' ||
  process.env.MAILINK_LOG_APPEND_TRACE === 'true' ||
  process.env.MAILINK_LOG_APPEND_TRACE === 'TRUE';

class LogAppendManager extends EventEmitter {
  constructor() {
    super();
    this.worker = null;
    this.pendingRequests = new Map();
    this.nextRequestId = 0;
    this.isReady = false;
    this.initWorker();
  }

  log(level, message) {
    if (LOG_APPEND_TRACE) {
      logger[level](`[LogAppendManager] ${message}`);
    }
  }

  initWorker() {
    this.log('info', 'Initializing LogAppendWorker...');

    this.worker = new Worker(path.join(__dirname, 'log-append.worker.js'), {
      stdout: true,
      stderr: true
    });

    this.worker.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) this.log('info', `[Worker stdout] ${msg}`);
    });

    this.worker.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) this.log('error', `[Worker stderr] ${msg}`);
    });

    this.worker.on('message', (response) => {
      const { id, success, error, data } = response;
      const pendingRequest = this.pendingRequests.get(id);

      if (pendingRequest) {
        const { resolve, reject } = pendingRequest;
        if (success) {
          resolve(data !== undefined ? data : true);
        } else {
          reject(new Error(error));
        }
        this.pendingRequests.delete(id);
      }
    });

    this.worker.on('error', (error) => {
      this.log('error', `Worker error: ${error.message}`);
      this.failAllPending(error);
      this.reinitWorker();
    });

    this.worker.on('exit', (code) => {
      if (code !== 0) {
        this.log('error', `Worker exited with code ${code}`);
        this.failAllPending(new Error(`Worker exited with code ${code}`));
        this.reinitWorker();
      }
    });

    this.isReady = true;
    this.log('info', 'LogAppendWorker initialized');
  }

  reinitWorker() {
    this.isReady = false;
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch (e) {
        // ignore
      }
      this.worker = null;
    }
    setTimeout(() => this.initWorker(), 1000);
  }

  failAllPending(error) {
    for (const [id, { reject }] of this.pendingRequests) {
      reject(error);
    }
    this.pendingRequests.clear();
  }

  sendRequest(type, payload, timeout = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.isReady || !this.worker) {
        reject(new Error('Worker not ready'));
        return;
      }

      const id = this.nextRequestId++;
      this.pendingRequests.set(id, { resolve, reject });

      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout after ${timeout}ms`));
      }, timeout);

      const originalResolve = resolve;
      resolve = (value) => {
        clearTimeout(timeoutId);
        originalResolve(value);
      };

      const originalReject = reject;
      reject = (error) => {
        clearTimeout(timeoutId);
        originalReject(error);
      };

      this.pendingRequests.set(id, { resolve, reject });

      this.worker.postMessage({
        id,
        type,
        ...payload
      });
    });
  }

  append(filePath, content, options = {}) {
    this.log('info', `append called: ${filePath}`);
    return this.sendRequest('append', {
      filePath,
      content,
      options
    });
  }

  flush(filePath) {
    this.log('info', `flush called: ${filePath}`);
    return this.sendRequest('flush', { filePath });
  }

  close(filePath) {
    this.log('info', `close called: ${filePath || 'all'}`);
    return this.sendRequest('close', { filePath });
  }

  closeAll() {
    this.log('info', 'closeAll called');
    return this.sendRequest('close', {});
  }

  getStatus() {
    return this.sendRequest('get-status', {});
  }

  terminate() {
    this.log('info', 'Terminating LogAppendWorker...');
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.isReady = false;
    this.pendingRequests.clear();
  }
}

const manager = new LogAppendManager();

process.on('exit', () => {
  manager.terminate();
});

process.on('SIGINT', () => {
  manager.terminate();
  process.exit(0);
});

process.on('SIGTERM', () => {
  manager.terminate();
  process.exit(0);
});

module.exports = manager;
