/**
 * File conversion utility methods
 * Provides Base64 encode/decode and other general utility functions
 * Uses Worker for background thread processing to avoid blocking main thread
 */

// File Converter Worker instance (lazy loaded)
let fileConverterWorker = null;
let taskIdCounter = 0;
const pendingTasks = new Map();

/**
 * Get or create File Converter Worker instance
 * @returns {Worker} File Converter Worker instance
 */
function getFileConverterWorker() {
  if (!fileConverterWorker) {
    const workerPath = new URL('../../../../services/file-converter.worker.js', import.meta.url).href;
    fileConverterWorker = new Worker(workerPath);

    fileConverterWorker.onmessage = (e) => {
      const { type, taskId, success, result, error, progress, loaded, total } = e.data;

      if (type === 'progress' && pendingTasks.has(taskId)) {
        const { onProgress } = pendingTasks.get(taskId);
        if (onProgress) {
          onProgress({ progress, loaded, total });
        }
        return;
      }

      if (type === 'batchProgress' && pendingTasks.has(taskId)) {
        const { onProgress } = pendingTasks.get(taskId);
        if (onProgress) {
          onProgress({ current: e.data.current, total: e.data.total, progress: e.data.progress });
        }
        return;
      }

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

    fileConverterWorker.onerror = (error) => {
      console.error('[File Converter Worker] Error:', error);
    };
  }

  return fileConverterWorker;
}

/**
 * Send task to File Converter Worker
 * @param {string} type - Task type
 * @param {Object} params - Task parameters
 * @param {Object} options - Options { onProgress: Function }
 * @returns {Promise<any>} Task result
 */
function sendConverterTask(type, params, options = {}) {
  return new Promise((resolve, reject) => {
    const taskId = ++taskIdCounter;
    pendingTasks.set(taskId, { resolve, reject, onProgress: options.onProgress });

    try {
      const worker = getFileConverterWorker();
      worker.postMessage({ type, taskId, params });
    } catch (error) {
      pendingTasks.delete(taskId);
      reject(error);
    }
  });
}

/**
 * Convert ArrayBuffer to Base64 string
 * @param {ArrayBuffer} arrayBuffer - ArrayBuffer data
 * @returns {Promise<string>} Base64 string
 */
export async function arrayBufferToBase64(arrayBuffer) {
  try {
    return await sendConverterTask('arrayBufferToBase64', { arrayBuffer });
  } catch (error) {
    console.warn('[arrayBufferToBase64] Worker conversion failed, use main-thread fallback:', error);
    // Fallback: process in main thread
    const uint8Array = new Uint8Array(arrayBuffer);
    let binary = '';
    const len = uint8Array.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(uint8Array[i]);
    }
    return btoa(binary);
  }
}

/**
 * Convert File object to Base64 string
 * @param {File} file - File object
 * @param {Object} options - Options { onProgress: Function }
 * @returns {Promise<string>} Base64 string
 */
export async function fileToBase64(file, options = {}) {
  try {
    return await sendConverterTask('fileToBase64', { file, options }, options);
  } catch (error) {
    console.warn('[fileToBase64] Worker conversion failed, use main-thread fallback:', error);
    // Fallback: process in main thread
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const arrayBuffer = e.target.result;
          const uint8Array = new Uint8Array(arrayBuffer);
          let binary = '';
          const len = uint8Array.byteLength;
          for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(uint8Array[i]);
          }
          resolve(btoa(binary));
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  }
}

/**
 * Process pasted file data
 * Specifically handles files pasted from clipboard
 * @param {File} file - File object
 * @returns {Promise<{base64: string, name: string, type: string, size: number}>} Processing result
 */
export async function processPastedFile(file) {
  try {
    const base64 = await fileToBase64(file);
    return {
      base64,
      name: file.name,
      type: file.type,
      size: file.size,
      success: true
    };
  } catch (error) {
    console.error('[processPastedFile] failed to process pasted file:', error);
    return {
      base64: null,
      name: file.name,
      type: file.type,
      size: file.size,
      success: false,
      error: error.message
    };
  }
}

/**
 * Convert Base64 to Uint8Array
 * @param {string} base64 - Base64 string
 * @returns {Promise<Uint8Array>} Uint8Array data
 */
export async function base64ToUint8Array(base64) {
  try {
    return await sendConverterTask('base64ToUint8Array', { base64 });
  } catch (error) {
    console.warn('[base64ToUint8Array] Worker conversion failed, use main-thread fallback:', error);
    // Fallback: process in main thread
    const binary = atob(base64);
    const length = binary.length;
    const uint8Array = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      uint8Array[i] = binary.charCodeAt(i);
    }
    return uint8Array;
  }
}

/**
 * Terminate File Converter Worker (for resource cleanup)
 */
export function terminateFileConverterWorker() {
  if (fileConverterWorker) {
    fileConverterWorker.terminate();
    fileConverterWorker = null;
    pendingTasks.clear();
  }
}
