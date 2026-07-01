/**
 * Email attachment download queue manager
 * Controls concurrent download count to prevent IMAP connection exhaustion
 */

class DownloadQueue {
  constructor(maxConcurrent = 3) {
    this.maxConcurrent = maxConcurrent;
    this.queue = [];            // Pending task queue
    this.running = new Set();   // IDs of running tasks
    this.completed = new Map(); // Completed task results
    this.failed = new Map();    // Failed task errors
  }

  /**
   * Add a task to the queue
   * @param {string} taskId - Unique task ID
   * @param {Function} taskFn - Async task function that returns a Promise
   * @param {object} options - Task options
   *   - priority: Priority (1-10, default 5)
   *   - timeout: Timeout (milliseconds, default 600000)
   *   - retries: Number of retries on failure (default 1)
   * @returns {Promise} - Promise that resolves or rejects when the task finishes
   */
  enqueue(taskId, taskFn, options = {}) {
    const {
      priority = 5,
      timeout = 600000,
      retries = 1
    } = options;

    return new Promise((resolve, reject) => {
      const task = {
        id: taskId,
        fn: taskFn,
        priority,
        timeout,
        retries,
        attempts: 0,
        resolve,
        reject,
        createdAt: Date.now()
      };

      this.queue.push(task);
      // Sort by priority (highest first)
      this.queue.sort((a, b) => b.priority - a.priority);
      
      this._processQueue();
    });
  }

  /**
   * Process the next task in the queue
   */
  async _processQueue() {
    if (this.running.size >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const task = this.queue.shift();
    this.running.add(task.id);

    try {
      // Use Promise.race for timeout control
      const result = await Promise.race([
        task.fn(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Task timeout')), task.timeout)
        )
      ]);

      task.resolve(result);
      this.completed.set(task.id, result);
    } catch (error) {
      task.attempts++;

      if (task.attempts < task.retries) {
        // Re-add to queue with lower priority
        task.priority = Math.max(1, task.priority - 1);
        this.queue.unshift(task);
      } else {
        // Retries exhausted, mark as failed
        task.reject(error);
        this.failed.set(task.id, error);
      }
    } finally {
      this.running.delete(task.id);
      // Continue processing the next task
      this._processQueue();
    }
  }

  /**
   * Get queue status
   */
  getStatus() {
    return {
      running: this.running.size,
      queued: this.queue.length,
      completed: this.completed.size,
      failed: this.failed.size,
      maxConcurrent: this.maxConcurrent
    };
  }

  /**
   * Cancel the specified task
   */
  cancel(taskId) {
    const index = this.queue.findIndex(t => t.id === taskId);
    if (index > -1) {
      const task = this.queue[index];
      this.queue.splice(index, 1);
      task.reject(new Error('Task cancelled'));
      return true;
    }
    return false;
  }

  /**
   * Clear the queue
   */
  clear() {
    for (const task of this.queue) {
      task.reject(new Error('Queue cleared'));
    }
    this.queue = [];
  }

  /**
   * Get task results
   */
  getResult(taskId) {
    if (this.completed.has(taskId)) {
      return { status: 'completed', result: this.completed.get(taskId) };
    }
    if (this.failed.has(taskId)) {
      return { status: 'failed', error: this.failed.get(taskId) };
    }
    if (this.running.has(taskId)) {
      return { status: 'running' };
    }
    const queuedTask = this.queue.find(t => t.id === taskId);
    if (queuedTask) {
      return { status: 'queued', position: this.queue.indexOf(queuedTask) };
    }
    return { status: 'not-found' };
  }
}

// Global download queue instance
const globalDownloadQueue = new DownloadQueue(3);

module.exports = {
  DownloadQueue,
  globalDownloadQueue
};
