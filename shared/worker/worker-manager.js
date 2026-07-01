/**
 * Worker Manager - unified Worker management module
 * supports two Worker management modes:
 * 1. single Worker mode(suitable for IMAP)
 * 2. Worker pool mode(suitable for SMTP)
 */

const path = require('path');
const { Worker } = require('worker_threads');
const logger = require('../../service/logger');
const { withTimeout, TimeoutError } = require('../core/timeout/timeout');
const { SIGNALING_EMAIL_PREFIX } = require('../config/signaling-constants');

class WorkerManager {
  constructor(options) {
    this.workerPath = options.workerPath;
    this.mode = options.mode || 'single';
    this.poolSize = options.poolSize || Math.min(4, require('os').cpus().length);
    
    // Two-level queue: critical (WebRTC signaling) and normal (normal emails)
    this.taskQueue = { critical: [], normal: [] };
    this.taskCounter = 0;
    this.taskResults = new Map();
    this.isInitialized = false;
    
    this.worker = null;
    this.isReady = false;
    this.readyPromise = null;
    
    this.workerPool = [];
    
    this.init();
  }
  
  init() {
    if (this.isInitialized) return;
    
    if (this.mode === 'single') {
      this.initSingleWorker();
    } else {
      this.initWorkerPool();
    }
    
    this.isInitialized = true;
  }
  
  initSingleWorker() {
    this.isReady = false;
    this.worker = new Worker(this.workerPath, {
      stdout: true,
      stderr: true
    });

    // Capture worker stdout and stderr
    this.worker.stdout.on('data', (data) => {
      logger.info(`[Worker-${path.basename(this.workerPath)}] ${data.toString().trim()}`);
    });
    this.worker.stderr.on('data', (data) => {
      logger.error(`[Worker-${path.basename(this.workerPath)}] ${data.toString().trim()}`);
    });

    this.readyPromise = new Promise((resolve) => {
      let resolved = false;

      const markReady = () => {
        if (resolved) return;
        resolved = true;
        this.isReady = true;
        resolve();
        this.processQueue();
      };

      this.worker.once('online', markReady);

      this.worker.on('message', (response) => {
        if (response && response.success && typeof response.data === 'string' && response.data.endsWith('ready')) {
          markReady();
        }
      });
    });

    this.worker.on('message', this.handleSingleWorkerMessage.bind(this));
    this.worker.on('error', this.handleSingleWorkerError.bind(this));
    this.worker.on('exit', this.handleSingleWorkerExit.bind(this));
  }
  
  initWorkerPool() {
    for (let i = 0; i < this.poolSize; i++) {
      const worker = new Worker(this.workerPath, {
        stdout: true,
        stderr: true
      });

      // Capture worker stdout and stderr
      worker.stdout.on('data', (data) => {
        logger.info(`[Worker-${path.basename(this.workerPath)}-${i}] ${data.toString().trim()}`);
      });
      worker.stderr.on('data', (data) => {
        logger.error(`[Worker-${path.basename(this.workerPath)}-${i}] ${data.toString().trim()}`);
      });

      worker.on('message', this.handlePoolWorkerMessage.bind(this, worker));
      worker.on('error', this.handlePoolWorkerError.bind(this, worker));

      this.workerPool.push(worker);
    }
  }
  
  handleSingleWorkerMessage(response) {
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
      return;
    }

    if (response.success && typeof response.data === 'string' && response.data.endsWith('ready')) {
      return;
    }

    const { id, success, data, error } = response;
    const taskResult = this.taskResults.get(id);

    if (taskResult) {
      const { resolve, reject, timer } = taskResult;
      if (timer) clearTimeout(timer);

      if (success) {
        resolve(data);
      } else {
        reject(new Error(error));
      }
      this.taskResults.delete(id);
      this.processQueue();
    }
  }
  
  handleSingleWorkerError(error) {
    logger.error('Worker error:', error);
    this.failAllPendingTasks(error);
    this.isReady = false;
    this.initSingleWorker();
  }
  
  handleSingleWorkerExit(code) {
    logger.error(`Worker exited with code ${code}`);
    this.failAllPendingTasks(new Error(`Worker exited with code ${code}`));
    this.isReady = false;
    this.initSingleWorker();
  }

  failAllPendingTasks(error) {
    for (const [taskId, taskResult] of this.taskResults.entries()) {
      try {
        if (taskResult?.timer) clearTimeout(taskResult.timer);
        taskResult?.reject?.(error);
      } finally {
        this.taskResults.delete(taskId);
      }
    }
  }
  
  handlePoolWorkerMessage(worker, message) {
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

    const taskId = message.id || message.taskId;
    const { success, data, result, error } = message;
    const taskResult = this.taskResults.get(taskId);

    if (taskResult) {
      const { resolve, reject, timer } = taskResult;
      if (timer) clearTimeout(timer);

      if (success) {
        resolve(data || result);
      } else {
        let err;
        if (typeof error === 'string') {
          err = new Error(error);
        } else if (error && typeof error === 'object' && error.message) {
          err = new Error(error.message);
          err.code = error.code;
        } else {
          err = new Error('Worker task failed with unknown error');
        }
        reject(err);
      }
      this.taskResults.delete(taskId);
    }
    
    this.workerPool.push(worker);
    this.processQueue();
  }
  
  handlePoolWorkerError(worker, error) {
    logger.error('Pool worker error:', error);
    
    const index = this.workerPool.indexOf(worker);
    if (index > -1) {
      this.workerPool.splice(index, 1);
    }
    
    const newWorker = new Worker(this.workerPath);
    newWorker.on('message', this.handlePoolWorkerMessage.bind(this, newWorker));
    newWorker.on('error', this.handlePoolWorkerError.bind(this, newWorker));
    this.workerPool.push(newWorker);
  }
  
  processQueue() {
    if (this.mode === 'single') {
      this.processSingleWorkerQueue();
    } else {
      this.processPoolWorkerQueue();
    }
  }
  
  processSingleWorkerQueue() {
    if (!this.isReady) {
      return;
    }
    
    // Priority processing: handle critical queue (WebRTC signaling) first, then normal queue
    let task = null;
    if (this.taskQueue.critical.length > 0) {
      task = this.taskQueue.critical.shift();
    } else if (this.taskQueue.normal.length > 0) {
      task = this.taskQueue.normal.shift();
    }
    
    if (task) {
      this.worker.postMessage(task);
    }
  }
  
  processPoolWorkerQueue() {
    // Prioritize critical queue (WebRTC signaling emails) to ensure signaling is not blocked by normal emails
    while (this.taskQueue.critical.length > 0 && this.workerPool.length > 0) {
      const task = this.taskQueue.critical.shift();
      const worker = this.workerPool.pop();
      worker.postMessage(task);
    }
    // Then process the normal queue (normal emails)
    while (this.taskQueue.normal.length > 0 && this.workerPool.length > 0) {
      const task = this.taskQueue.normal.shift();
      const worker = this.workerPool.pop();
      worker.postMessage(task);
    }
  }
  
  sendTask(taskData, timeout = 25000) {
    const taskId = `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const task = {
      id: taskId,
      ...taskData
    };

    const executeTask = () => {
      return new Promise((resolve, reject) => {
        this.taskResults.set(taskId, { resolve, reject });

        if (this.mode === 'single') {
          if (this.isReady) {
            this.worker.postMessage(task);
          } else {
            // Check if it is a WebRTC signaling email (priority handling)
            const isCritical = taskData.emailData?.subject?.startsWith(SIGNALING_EMAIL_PREFIX);
            if (isCritical) {
              this.taskQueue.critical.push(task);
            } else {
              this.taskQueue.normal.push(task);
            }
            this.readyPromise.then(() => {
            });
          }
        } else {
          if (this.workerPool.length > 0) {
            const worker = this.workerPool.pop();
            worker.postMessage(task);
          } else {
            // Check if it is a WebRTC signaling email (priority handling)
            const isCritical = taskData.emailData?.subject?.startsWith(SIGNALING_EMAIL_PREFIX);
            if (isCritical) {
              this.taskQueue.critical.push(task);
            } else {
              this.taskQueue.normal.push(task);
            }
          }
        }
      });
    };

    return withTimeout(executeTask(), timeout, {
      timeoutMessage: `Worker task timed out after ${timeout}ms`,
      onTimeout: () => {
        if (this.taskResults.has(taskId)) {
          this.taskResults.delete(taskId);
          
          if (this.mode === 'single') {
            logger.error('Worker task timed out, restarting worker...');
            if (this.worker) {
              this.worker.terminate();
            }
            this.isReady = false;
            this.initSingleWorker();
          }
        }
      }
    });
  }
  
  getStatus() {
    if (this.mode === 'single') {
      return {
        mode: 'single',
        isReady: this.isReady,
        queueLength: this.taskQueue.length
      };
    } else {
      return {
        mode: 'pool',
        poolSize: this.workerPool.length,
        queueLength: this.taskQueue.length
      };
    }
  }
}

module.exports = WorkerManager;
