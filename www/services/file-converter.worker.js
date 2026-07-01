/**
 * File Converter Worker
 * Responsibility: Handle file conversion operations in a background thread
 * - ArrayBuffer to Base64
 * - Base64 to ArrayBuffer
 * - Uint8Array processing
 * - Large file chunking
 */

// Chunk size: 2MB to avoid excessive memory usage
const CHUNK_SIZE = 2 * 1024 * 1024;

/**
 * Convert Uint8Array to Base64 string
 * Use chunking to avoid stack overflow
 * @param {Uint8Array} uint8Array - Uint8Array data
 * @returns {string} Base64 string
 */
function uint8ArrayToBase64(uint8Array) {
  const length = uint8Array.byteLength;

  // Small file: process directly
  if (length <= CHUNK_SIZE) {
    let binary = '';
    const len = uint8Array.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(uint8Array[i]);
    }
    return btoa(binary);
  }

  // Large file: process in chunks
  const chunks = [];
  for (let offset = 0; offset < length; offset += CHUNK_SIZE) {
    const chunk = uint8Array.slice(offset, Math.min(offset + CHUNK_SIZE, length));
    let binary = '';
    const len = chunk.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(chunk[i]);
    }
    chunks.push(btoa(binary));

    // Send progress update after each chunk is processed
    if (offset % (CHUNK_SIZE * 5) === 0 || offset + CHUNK_SIZE >= length) {
      self.postMessage({
        type: 'progress',
        progress: Math.min(100, Math.round((offset / length) * 100)),
        processedBytes: offset,
        totalBytes: length
      });
    }
  }

  // Merge all Base64 chunks
  return chunks.join('');
}

/**
 * Convert ArrayBuffer to Base64 string
 * @param {ArrayBuffer} arrayBuffer - ArrayBuffer data
 * @returns {string} Base64 string
 */
function arrayBufferToBase64(arrayBuffer) {
  if (!arrayBuffer) return '';
  const uint8Array = new Uint8Array(arrayBuffer);
  return uint8ArrayToBase64(uint8Array);
}

/**
 * Convert Base64 string to Uint8Array
 * @param {string} base64 - Base64 string
 * @returns {Uint8Array} Uint8Array data
 */
function base64ToUint8Array(base64) {
  if (!base64) return new Uint8Array(0);

  try {
    const binary = atob(base64);
    const length = binary.length;
    const uint8Array = new Uint8Array(length);

    for (let i = 0; i < length; i++) {
      uint8Array[i] = binary.charCodeAt(i);
    }

    return uint8Array;
  } catch (error) {
    throw new Error(`Base64 decode failed: ${error.message}`);
  }
}

/**
 * Convert Base64 string to ArrayBuffer
 * @param {string} base64 - Base64 string
 * @returns {ArrayBuffer} ArrayBuffer data
 */
function base64ToArrayBuffer(base64) {
  const uint8Array = base64ToUint8Array(base64);
  return uint8Array.buffer;
}

/**
 * Convert File object to Base64
 * Read file content via FileReader
 * @param {File} file - File object
 * @param {Object} options - Options
 * @returns {Promise<string>} Base64 string
 */
async function fileToBase64(file, options = {}) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error('File is null or undefined'));
      return;
    }

    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const arrayBuffer = e.target.result;
        const base64 = arrayBufferToBase64(arrayBuffer);
        resolve(base64);
      } catch (error) {
        reject(error);
      }
    };

    reader.onerror = (error) => {
      reject(new Error(`File read failed: ${error.message || 'Unknown error'}`));
    };

    reader.onprogress = (e) => {
      if (e.lengthComputable) {
        self.postMessage({
          type: 'progress',
          progress: Math.round((e.loaded / e.total) * 100),
          loaded: e.loaded,
          total: e.total
        });
      }
    };

    reader.readAsArrayBuffer(file);
  });
}

/**
 * Convert Blob object to Base64
 * @param {Blob} blob - Blob object
 * @returns {Promise<string>} Base64 string
 */
async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    if (!blob) {
      reject(new Error('Blob is null or undefined'));
      return;
    }

    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const arrayBuffer = e.target.result;
        const base64 = arrayBufferToBase64(arrayBuffer);
        resolve(base64);
      } catch (error) {
        reject(error);
      }
    };

    reader.onerror = (error) => {
      reject(new Error(`Blob read failed: ${error.message || 'Unknown error'}`));
    };

    reader.readAsArrayBuffer(blob);
  });
}

/**
 * Convert Base64 to Blob
 * @param {string} base64 - Base64 string
 * @param {string} mimeType - MIME type
 * @returns {Blob} Blob object
 */
function base64ToBlob(base64, mimeType = 'application/octet-stream') {
  const uint8Array = base64ToUint8Array(base64);
  return new Blob([uint8Array], { type: mimeType });
}

/**
 * Batch process Base64 conversion for multiple files
 * @param {Array} files - File object array
 * @param {Object} options - Options
 * @returns {Promise<Array>} Conversion result array
 */
async function batchFilesToBase64(files, options = {}) {
  if (!Array.isArray(files)) {
    throw new Error('Files must be an array');
  }

  const results = [];
  const total = files.length;

  for (let i = 0; i < total; i++) {
    const file = files[i];
    try {
      const base64 = await fileToBase64(file, options);
      results.push({
        index: i,
        name: file.name,
        type: file.type,
        size: file.size,
        base64: base64,
        success: true
      });
    } catch (error) {
      results.push({
        index: i,
        name: file.name,
        type: file.type,
        size: file.size,
        success: false,
        error: error.message
      });
    }

    // Send batch progress
    self.postMessage({
      type: 'batchProgress',
      current: i + 1,
      total: total,
      progress: Math.round(((i + 1) / total) * 100)
    });
  }

  return results;
}

/**
 * Handle pasted file data
 * Specifically for files pasted from clipboard
 * @param {Object} fileData - File data object
 * @returns {Promise<Object>} Processing result
 */
async function processPastedFile(fileData) {
  if (!fileData || !fileData.data) {
    throw new Error('Invalid file data');
  }

  const { data, name, type, size } = fileData;

  // If already Base64, return directly
  if (typeof data === 'string') {
    return {
      base64: data,
      name,
      type,
      size,
      success: true
    };
  }

  // If ArrayBuffer, convert to Base64
  if (data instanceof ArrayBuffer) {
    const base64 = arrayBufferToBase64(data);
    return {
      base64,
      name,
      type,
      size,
      success: true
    };
  }

  throw new Error('Unsupported data type');
}

// Task queue management
const taskQueue = new Map();
let taskIdCounter = 0;

// Message processing
self.onmessage = async function(e) {
  const { type, taskId, params } = e.data;

  try {
    let result;

    switch (type) {
      case 'arrayBufferToBase64':
        result = arrayBufferToBase64(params.arrayBuffer);
        break;

      case 'base64ToArrayBuffer':
        result = base64ToArrayBuffer(params.base64);
        break;

      case 'uint8ArrayToBase64':
        result = uint8ArrayToBase64(new Uint8Array(params.uint8Array));
        break;

      case 'base64ToUint8Array':
        result = base64ToUint8Array(params.base64);
        break;

      case 'fileToBase64':
        result = await fileToBase64(params.file, params.options);
        break;

      case 'blobToBase64':
        result = await blobToBase64(params.blob);
        break;

      case 'base64ToBlob':
        result = base64ToBlob(params.base64, params.mimeType);
        break;

      case 'batchFilesToBase64':
        result = await batchFilesToBase64(params.files, params.options);
        break;

      case 'processPastedFile':
        result = await processPastedFile(params.fileData);
        break;

      default:
        throw new Error(`Unknown operation type: ${type}`);
    }

    // Return result
    self.postMessage({
      type: 'result',
      taskId: taskId,
      success: true,
      result: result
    });
  } catch (error) {
    // Return error
    self.postMessage({
      type: 'result',
      taskId: taskId,
      success: false,
      error: error.message
    });
  }
};

// Worker initialization log
console.log('[File Converter Worker] Initialized and ready');
