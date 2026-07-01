/**
 * Email queue manager
 * Manages the queue of email parsing tasks, supports priority handling and async Worker parsing
 */

const { Worker } = require('worker_threads');
const path = require('path');
const logger = require('../logger');
const EventEmitter = require('events');

/**
 * Email queue manager class
 * Implements two-level queues (critical/normal) and Worker pool management
 */
class EmailQueueManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Worker configuration
    this.workerPath = options.workerPath || path.join(__dirname, 'workers', 'email-processor.worker.js');
    this.poolSize = options.poolSize || Math.min(4, require('os').cpus().length);
    this.maxQueueSize = options.maxQueueSize || 1000; // Maximum queue length
    this.taskTimeout = options.taskTimeout || 30000; // Task timeout (30 seconds)
    
    // Two-level queues: critical (signaling emails) and normal (regular emails)
    this.taskQueue = {
      critical: [],
      normal: []
    };
    
    // Worker pool
    this.workerPool = [];
    this.busyWorkers = new Set();
    
    // Task management
    this.taskResults = new Map();
    this.taskCounter = 0;
    this.processingCount = 0;
    
    // Statistics
    this.stats = {
      totalTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      queuedTasks: 0,
      criticalTasks: 0,
      normalTasks: 0
    };
    
    // Running state
    this.isRunning = false;
    this.isShuttingDown = false;
    
    // Initialize Worker pool
    this._initWorkerPool();
  }
  
  /**
   * Initialize Worker pool
   */
  _initWorkerPool() {
    logger.info(`[EmailQueueManager] initializedWorkerpool, size: ${this.poolSize}`);
    
    for (let i = 0; i < this.poolSize; i++) {
      this._createWorker(i);
    }
    
    this.isRunning = true;
  }
  
  /**
   * Create a single Worker
   */
  _createWorker(index) {
    try {
      const worker = new Worker(this.workerPath, {
        workerData: { workerId: index }
      });
      
      worker.workerId = index;
      worker.isReady = true;
      
      worker.on('message', (message) => {
        this._handleWorkerMessage(worker, message);
      });
      
      worker.on('error', (error) => {
        logger.error(`[EmailQueueManager] Worker ${index} error:`, error);
        this._handleWorkerError(worker, error);
      });
      
      worker.on('exit', (code) => {
        logger.warn(`[EmailQueueManager] Worker ${index} exit, code: ${code}`);
        this._handleWorkerExit(worker, code);
      });
      
      this.workerPool.push(worker);
      logger.info(`[EmailQueueManager] Worker ${index} created`);
    } catch (error) {
      logger.error(`[EmailQueueManager] createWorker ${index} failed:`, error);
    }
  }
  
  /**
   * Process Worker messages
   */
  _handleWorkerMessage(worker, message) {
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
    
    const { taskId, success, data, error } = message;
    const taskResult = this.taskResults.get(taskId);
    
    if (taskResult) {
      const { resolve, reject, timeout, startTime } = taskResult;
      
      // Clear timeout timer
      if (timeout) clearTimeout(timeout);
      
      // Calculate processing time
      const duration = Date.now() - startTime;
      
      if (success) {
        resolve({ success: true, data, duration });
        this.stats.completedTasks++;
        this.emit('taskCompleted', { taskId, duration, workerId: worker.workerId });
      } else {
        const err = new Error(error || 'Worker processing failed');
        reject(err);
        this.stats.failedTasks++;
        this.emit('taskFailed', { taskId, error: err, workerId: worker.workerId });
      }
      
      this.taskResults.delete(taskId);
      this.processingCount--;
    }
    
    // Mark Worker as idle
    this.busyWorkers.delete(worker);
    
    // Process the next task
    this._processQueue();
  }
  
  /**
   * Process Worker errors
   */
  _handleWorkerError(worker, error) {
    // Find the task this Worker is processing and mark it as failed
    for (const [taskId, taskResult] of this.taskResults.entries()) {
      if (taskResult.worker === worker) {
        const { resolve, reject, timeout } = taskResult;
        if (timeout) clearTimeout(timeout);
        
        const err = new Error(`Worker error: ${error.message}`);
        reject(err);
        this.taskResults.delete(taskId);
        this.processingCount--;
        this.stats.failedTasks++;
      }
    }
    
    // Remove from Worker pool
    const index = this.workerPool.indexOf(worker);
    if (index > -1) {
      this.workerPool.splice(index, 1);
    }
    this.busyWorkers.delete(worker);
    
    // Recreate Worker
    if (!this.isShuttingDown) {
      setTimeout(() => this._createWorker(worker.workerId), 1000);
    }
  }
  
  /**
   * Process Worker exit
   */
  _handleWorkerExit(worker, code) {
    if (code !== 0) {
      this._handleWorkerError(worker, new Error(`Worker exited with code ${code}`));
    }
  }
  
  /**
   * Add a task to the queue
   * @param {Object} taskData - Task data
   * @param {Object} options - Options
   * @returns {Promise} - Promise after task completes
   */
  async addTask(taskData, options = {}) {
    if (this.isShuttingDown) {
      throw new Error('Queue manager is shutting down');
    }
    
    const taskId = `task-${Date.now()}-${++this.taskCounter}`;
    const priority = options.priority || 'normal';
    const timeout = options.timeout || this.taskTimeout;
    
    // Check whether the queue is full
    const totalQueueSize = this.taskQueue.critical.length + this.taskQueue.normal.length;
    if (totalQueueSize >= this.maxQueueSize) {
      throw new Error(`Queue is full (${totalQueueSize}/${this.maxQueueSize})`);
    }
    
    return new Promise((resolve, reject) => {
      const task = {
        id: taskId,
        data: taskData,
        priority,
        addedAt: Date.now()
      };
      
      // Set task timeout
      const timeoutId = setTimeout(() => {
        if (this.taskResults.has(taskId)) {
          this.taskResults.delete(taskId);
          this.processingCount--;
          this.stats.failedTasks++;
          reject(new Error(`Task ${taskId} timed out after ${timeout}ms`));
          
          // Try to cancel the task in the Worker
          const worker = this._findWorkerByTaskId(taskId);
          if (worker) {
            this._terminateWorker(worker);
          }
        }
      }, timeout);
      
      this.taskResults.set(taskId, {
        resolve,
        reject,
        timeout: timeoutId,
        startTime: Date.now()
      });
      
      // Add to the corresponding queue based on priority
      if (priority === 'critical') {
        this.taskQueue.critical.push(task);
        this.stats.criticalTasks++;
      } else {
        this.taskQueue.normal.push(task);
        this.stats.normalTasks++;
      }
      
      this.stats.totalTasks++;
      this.stats.queuedTasks++;
      
      logger.debug(`[EmailQueueManager] task ${taskId} added to queue (priority: ${priority})`);
      
      // Try to process immediately
      this._processQueue();
    });
  }
  
  /**
   * Process tasks in the queue
   */
  _processQueue() {
    if (!this.isRunning || this.isShuttingDown) return;
    
    // Get idle Worker
    const availableWorker = this._getAvailableWorker();
    if (!availableWorker) return;
    
    // Get next task (priority to critical queue)
    const task = this._getNextTask();
    if (!task) return;
    
    // Mark Worker as busy
    this.busyWorkers.add(availableWorker);
    this.processingCount++;
    this.stats.queuedTasks--;
    
    // Update Worker reference in task result
    const taskResult = this.taskResults.get(task.id);
    if (taskResult) {
      taskResult.worker = availableWorker;
    }
    
    // Send task to Worker
    try {
      availableWorker.postMessage({
        taskId: task.id,
        data: task.data
      });
      
      logger.debug(`[EmailQueueManager] task ${task.id} assigned to Worker ${availableWorker.workerId}`);
    } catch (error) {
      logger.error(`[EmailQueueManager] sending task toWorkerfailed:`, error);
      this._handleWorkerError(availableWorker, error);
    }
  }
  
  /**
   * Get idle Worker
   */
  _getAvailableWorker() {
    return this.workerPool.find(worker => !this.busyWorkers.has(worker) && worker.isReady);
  }
  
  /**
   * Get next task (by priority)
   */
  _getNextTask() {
    // Process critical queue first
    if (this.taskQueue.critical.length > 0) {
      return this.taskQueue.critical.shift();
    }
    
    // Then process normal queue
    if (this.taskQueue.normal.length > 0) {
      return this.taskQueue.normal.shift();
    }
    
    return null;
  }
  
  /**
   * Find Worker by task ID
   */
  _findWorkerByTaskId(taskId) {
    const taskResult = this.taskResults.get(taskId);
    return taskResult ? taskResult.worker : null;
  }
  
  /**
   * Terminate Worker and recreate it
   */
  _terminateWorker(worker) {
    try {
      worker.terminate();
    } catch (error) {
      logger.error(`[EmailQueueManager] terminateWorkerfailed:`, error);
    }
  }
  
  /**
   * Get queue status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      isShuttingDown: this.isShuttingDown,
      poolSize: this.workerPool.length,
      busyWorkers: this.busyWorkers.size,
      queueLength: {
        critical: this.taskQueue.critical.length,
        normal: this.taskQueue.normal.length,
        total: this.taskQueue.critical.length + this.taskQueue.normal.length
      },
      processingCount: this.processingCount,
      stats: { ...this.stats }
    };
  }
  
  /**
   * Graceful shutdown
   */
  async shutdown(timeout = 30000) {
    logger.info('[EmailQueueManager] started closing...');
    this.isShuttingDown = true;
    
    // Wait for tasks in queue to complete
    const startTime = Date.now();
    while (this.processingCount > 0 || this.taskQueue.critical.length > 0 || this.taskQueue.normal.length > 0) {
      if (Date.now() - startTime > timeout) {
        logger.warn('[EmailQueueManager] close timeout, force terminated');
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Terminate all Workers
    const terminatePromises = this.workerPool.map(worker => {
      return new Promise((resolve) => {
        const timeoutId = setTimeout(() => resolve(), 5000);
        worker.terminate().then(() => {
          clearTimeout(timeoutId);
          resolve();
        }).catch(() => {
          clearTimeout(timeoutId);
          resolve();
        });
      });
    });
    
    await Promise.all(terminatePromises);
    
    this.workerPool = [];
    this.busyWorkers.clear();
    this.isRunning = false;
    
    logger.info('[EmailQueueManager] closed');
  }
  
  /**
   * Clear queue
   */
  clearQueue() {
    const clearedCount = this.taskQueue.critical.length + this.taskQueue.normal.length;
    
    // Reject all pending tasks
    for (const task of [...this.taskQueue.critical, ...this.taskQueue.normal]) {
      const taskResult = this.taskResults.get(task.id);
      if (taskResult) {
        clearTimeout(taskResult.timeout);
        taskResult.reject(new Error('Task cancelled: queue cleared'));
        this.taskResults.delete(task.id);
      }
    }
    
    this.taskQueue.critical = [];
    this.taskQueue.normal = [];
    this.stats.queuedTasks = 0;
    
    logger.info(`[EmailQueueManager] queue cleared, cancelled ${clearedCount} tasks`);
    return clearedCount;
  }
}

// Singleton instance
let instance = null;

/**
 * Get queue manager instance
 */
function getQueueManager(options = {}) {
  if (!instance) {
    instance = new EmailQueueManager(options);
  }
  return instance;
}

/**
 * Reset queue manager instance
 */
function resetQueueManager() {
  if (instance) {
    instance.shutdown().catch(() => {});
    instance = null;
  }
}

module.exports = {
  EmailQueueManager,
  getQueueManager,
  resetQueueManager
};
