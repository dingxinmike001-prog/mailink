/**
 * File transfer sender utility methods
 * Provides hash calculation and other common utility functions
 */

// Hash Worker instance (lazy loaded)
let hashWorker = null;
let taskIdCounter = 0;
const pendingTasks = new Map();

/**
 * Get or create Hash Worker instance
 * @returns {Worker} Hash Worker instance
   */
function getHashWorker() {
  if (!hashWorker) {
    const workerPath = new URL('../../../../services/hash.worker.js', import.meta.url).href;
    hashWorker = new Worker(workerPath);

    hashWorker.onmessage = (e) => {
      const { type, taskId, success, result, error } = e.data;

      if (type === 'result' && pendingTasks.has(taskId)) {
        const { resolve, reject } = pendingTasks.get(taskId);
        pendingTasks.delete(taskId);

        if (success) {
          resolve(result);
        } else {
          reject(new Error(error));
        }
      }
    };

    hashWorker.onerror = (error) => {
      console.error('[Hash Worker] Error:', error);
    };
  }

  return hashWorker;
}

/**
 * Send task to Hash Worker
 * @param {string} type - Task type
 * @param {Object} params - Task parameters
 * @returns {Promise<any>} Task result
 */
function sendHashTask(type, params) {
  return new Promise((resolve, reject) => {
    const taskId = ++taskIdCounter;
    pendingTasks.set(taskId, { resolve, reject });

    try {
      const worker = getHashWorker();
      worker.postMessage({ type, taskId, params });
    } catch (error) {
      pendingTasks.delete(taskId);
      reject(error);
    }
  });
}

/**
 * Calculate file hash (MD5)
 * Small files (≤6MB): use full hash for accuracy
 * Large files (>6MB): use sampled hash (first and last 3MB) to balance performance and accuracy
 * @param {File} file - File to hash
 * @returns {Promise<string|null>} File hash, or null on failure
 */
export async function calculateFileHash(file) {
  try {
    // Use Hash Worker to calculate hash in background thread
    const hash = await sendHashTask('calculateFileHash', { file });
    return hash;
  } catch (error) {
    console.warn('[calculateFileHash] Worker calculation failed, use fallback solution:', error);
    // Fallback: return null and let caller handle
    return null;
  }
}

/**
 * Terminate Hash Worker (for resource cleanup)
 */
export function terminateHashWorker() {
  if (hashWorker) {
    hashWorker.terminate();
    hashWorker = null;
    pendingTasks.clear();
  }
}
