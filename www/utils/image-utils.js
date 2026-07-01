/**
 * Image utility functions module
 * Provides common image format conversion and processing functions
 * Uses a Web Worker for background processing to avoid blocking the main thread
 * 
 * Note: thumbnail generation is non-critical; return the original image when the Worker fails
 * instead of reprocessing on the main thread to avoid large images blocking the UI
 */

/**
 * Image thumbnail Worker manager
 * Manages Worker instances and task queues
 */
class ImageThumbnailWorkerManager {
  constructor() {
    this.worker = null;
    this.pendingTasks = new Map();
    this.taskIdCounter = 0;
    this.isReady = false;
    this.readyPromise = null;
    this.initError = null;
  }

  async init() {
    if (this.worker) return this.readyPromise;

    this.readyPromise = new Promise((resolve, reject) => {
      try {
        // Check browser support
        if (typeof Worker === 'undefined') {
          throw new Error('browser not supported Web Worker');
        }
        if (typeof OffscreenCanvas === 'undefined') {
          throw new Error('browser not supported OffscreenCanvas');
        }

        const workerPath = new URL('../workers/image-thumbnail.worker.js', import.meta.url).href;
        this.worker = new Worker(workerPath, { type: 'module' });

        this.worker.onmessage = (event) => {
          const { type, id, data, success, error, level, message } = event.data;

          if (type === 'ready') {
            this.isReady = true;
            resolve();
            return;
          }

          if (type === 'log') {
            console[level]?.(`[ImageThumbnailWorker] ${message}`);
            return;
          }

          const pendingTask = this.pendingTasks.get(id);
          if (pendingTask) {
            this.pendingTasks.delete(id);
            if (success) {
              pendingTask.resolve(data);
            } else {
              pendingTask.reject(new Error(error || 'Worker processing failed'));
            }
          }
        };

        this.worker.onerror = (error) => {
          console.error('[ImageThumbnailWorker] Worker error:', error);
          this.initError = error;
          if (!this.isReady) {
            reject(error);
          }
        };
      } catch (error) {
        console.warn('[ImageThumbnailWorker] create Worker failed，Thumbnail will return original image:', error.message);
        this.initError = error;
        reject(error);
      }
    });

    return this.readyPromise;
  }

  async createThumbnail(imageData, options = {}) {
    // Try to initialize Worker
    if (!this.isReady && !this.initError) {
      try {
        await this.init();
      } catch (e) {
        // Worker initialization failed，return original image
      }
    }

    // Return the original image if the Worker is unavailable
    if (!this.isReady || this.initError) {
      console.warn('[ImageThumbnailWorker] Worker unavailable，return original image');
      return imageData;
    }

    const taskId = ++this.taskIdCounter;

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingTasks.delete(taskId);
        console.warn('[ImageThumbnailWorker] processing timeout，return original image');
        // Return the original image after timeout
        resolve(imageData);
      }, 5000);

      this.pendingTasks.set(taskId, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          console.warn('[ImageThumbnailWorker] processing failed，return original image:', error);
          // Return the original image on failure
          resolve(imageData);
        }
      });

      this.worker.postMessage({
        type: 'createThumbnail',
        id: taskId,
        payload: { imageData, options }
      });
    });
  }

  async svgToPng(svgString, options = {}) {
    // Try to initialize Worker
    if (!this.isReady && !this.initError) {
      try {
        await this.init();
      } catch (e) {
        // Worker initialization failed，return null
      }
    }

    // Return null if the Worker is unavailable (caller should handle this)
    if (!this.isReady || this.initError) {
      console.warn('[ImageThumbnailWorker] Worker unavailable，Unable to convert SVG');
      return null;
    }

    const taskId = ++this.taskIdCounter;

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingTasks.delete(taskId);
        console.warn('[ImageThumbnailWorker] SVG Conversion timed out');
        // Return null after timeout
        resolve(null);
      }, 5000);

      this.pendingTasks.set(taskId, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          console.warn('[ImageThumbnailWorker] SVG conversion failed:', error);
          // Return null on failure
          resolve(null);
        }
      });

      this.worker.postMessage({
        type: 'svgToPng',
        id: taskId,
        payload: { svgString, options }
      });
    });
  }

  terminate() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.isReady = false;
      this.initError = null;
      this.pendingTasks.clear();
    }
  }
}

// Global Worker manager instance
const thumbnailWorkerManager = new ImageThumbnailWorkerManager();

/**
 * Convert SVG to PNG DataURL
 * @param {string} svgString - SVG string
 * @param {Object} options - config options
 * @param {number} options.width - output width, default 16
 * @param {number} options.height - output height, default 16
 * @param {string} options.fit - fit mode, default 'cover' (cover|contain|fill)
 * @returns {Promise<string|null>} - PNG DataURL or null
 */
export async function svgToPngDataUrl(svgString, options = {}) {
  try {
    return await thumbnailWorkerManager.svgToPng(svgString, options);
  } catch (error) {
    console.warn('[svgToPngDataUrl] Worker conversion failed:', error);
    return null;
  }
}

/**
 * Check whether a string is in SVG format
 * @param {string} str - string to check
 * @returns {boolean} whether it is SVG
 */
export function isSvgString(str) {
  if (!str || typeof str !== 'string') return false;
  return str.trim().startsWith('<svg');
}

/**
 * Convert an SVG string to data URL format
 * @param {string} svgString - SVG string
 * @returns {string} data URL
 */
export function svgToDataUrl(svgString) {
  if (!svgString) return '';
  const svgData = encodeURIComponent(svgString);
  return `data:image/svg+xml;charset=utf-8,${svgData}`;
}

/**
 * Get the file extension for the given MIME type
 * @param {string} mimeType - MIME type
 * @returns {string} file extension
 */
export function getFileExtensionFromMimeType(mimeType) {
  const mimeToExt = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg'
  };
  return mimeToExt[mimeType] || 'png';
}

/**
 * Parse a Data URL to get the MIME type
 * @param {string} dataUrl - Data URL
 * @returns {string|null} MIME type
 */
export function getMimeTypeFromDataUrl(dataUrl) {
  const match = dataUrl?.match(/data:([^;]+);/);
  return match ? match[1] : null;
}

/**
 * Extract base64 data from a Data URL
 * @param {string} dataUrl - Data URL
 * @returns {string|null} base64 data
 */
export function getBase64FromDataUrl(dataUrl) {
  const parts = dataUrl?.split(',');
  return parts?.length > 1 ? parts[1] : null;
}

/**
 * Calculate the size of base64 data in bytes
 * @param {string} base64String - base64 string
 * @returns {number} number of bytes
 */
export function getBase64Size(base64String) {
  if (!base64String) return 0;
  const base64Length = base64String.length;
  return Math.ceil(base64Length * 0.75);
}

/**
 * Preload an image
 * @param {string} src - image source URL
 * @returns {Promise<HTMLImageElement>} image element
 */
export function preloadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * Create a thumbnail of the image (using Worker)
 * @param {string} imageSrc - image source URL
 * @param {Object} options - config options
 * @param {number} options.maxWidth - maximum width
 * @param {number} options.maxHeight - maximum height
 * @param {string} options.type - output format, default 'image/png'
 * @param {number} options.quality - image quality 0-1
 * @returns {Promise<string>} thumbnail Data URL
 */
export async function createThumbnail(imageSrc, options = {}) {
  try {
    return await thumbnailWorkerManager.createThumbnail(imageSrc, options);
  } catch (error) {
    console.warn('[createThumbnail] Worker Creation failed，Using main thread fallback:', error);
    // Fallback is handled in the Worker manager
    throw error;
  }
}

/**
 * Destroy the thumbnail Worker and release resources
 */
export function terminateThumbnailWorker() {
  thumbnailWorkerManager.terminate();
}

// Provide compatibility for CommonJS environment
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    svgToPngDataUrl,
    isSvgString,
    svgToDataUrl,
    getFileExtensionFromMimeType,
    getMimeTypeFromDataUrl,
    getBase64FromDataUrl,
    getBase64Size,
    preloadImage,
    createThumbnail,
    terminateThumbnailWorker
  };
}
