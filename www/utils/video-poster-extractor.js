/**
 * Video thumbnail extractor
 * Captures video frames with Canvas, no ffmpeg required
 * Supports Web Worker + OffscreenCanvas to avoid blocking the main thread
 */

/**
 * Worker task manager
 * Manages Worker instances and task queues
 */
class WorkerPool {
  constructor(workerUrl, poolSize = 1, logger = console) {
    this.workerUrl = workerUrl;
    this.poolSize = poolSize;
    this.logger = logger;
    this.workers = [];
    this.taskQueue = [];
    this.taskId = 0;
    this.pendingTasks = new Map();
    this.isTerminated = false;

    this._initWorkers();
  }

  _initWorkers() {
    for (let i = 0; i < this.poolSize; i++) {
      this._createWorker();
    }
  }

  _createWorker() {
    try {
      const worker = new Worker(this.workerUrl);

      worker.onmessage = (e) => {
        const { id, type, data, success, error, level, message } = e.data;

        if (type === 'log') {
          this.logger[level]?.(`[VideoPosterWorker] ${message}`);
          return;
        }

        const task = this.pendingTasks.get(id);
        if (task) {
          this.pendingTasks.delete(id);
          if (success) {
            task.resolve(data);
          } else {
            task.reject(new Error(error));
          }
          this._processQueue();
        }
      };

      worker.onerror = (error) => {
        this.logger.error?.('[VideoPosterWorker] Worker error:', error);
      };

      this.workers.push({
        instance: worker,
        busy: false
      });
    } catch (error) {
      this.logger.error?.('[VideoPosterWorker] Failed to create Worker:', error);
    }
  }

  _getAvailableWorker() {
    return this.workers.find(w => !w.busy);
  }

  _processQueue() {
    if (this.taskQueue.length === 0) return;

    const availableWorker = this._getAvailableWorker();
    if (!availableWorker) return;

    const task = this.taskQueue.shift();
    availableWorker.busy = true;

    this.pendingTasks.set(task.id, {
      resolve: (data) => {
        availableWorker.busy = false;
        task.resolve(data);
      },
      reject: (error) => {
        availableWorker.busy = false;
        task.reject(error);
      }
    });

    availableWorker.instance.postMessage({
      id: task.id,
      type: task.type,
      payload: task.payload
    }, task.transfer);
  }

  execute(type, payload, transfer = []) {
    if (this.isTerminated) {
      return Promise.reject(new Error('Worker pool terminated'));
    }

    return new Promise((resolve, reject) => {
      const id = ++this.taskId;
      this.taskQueue.push({
        id,
        type,
        payload,
        transfer,
        resolve,
        reject
      });
      this._processQueue();
    });
  }

  terminate() {
    this.isTerminated = true;
    this.workers.forEach(w => w.instance.terminate());
    this.workers = [];
    this.pendingTasks.clear();
    this.taskQueue = [];
  }
}

export class VideoPosterExtractor {
  constructor(logger = console) {
    this.logger = logger;
    this.workerPool = null;
    this._initWorker();
  }

  /**
   * Initialize Worker
   */
  _initWorker() {
    try {
      // Detect whether Worker and OffscreenCanvas are supported
      if (typeof Worker === 'undefined') {
        this.logger.warn?.('[VideoPosterExtractor] Browser does not support Web Worker, will process on main thread');
        return;
      }

      if (typeof OffscreenCanvas === 'undefined') {
        this.logger.warn?.('[VideoPosterExtractor] Browser does not support OffscreenCanvas, will process on main thread');
        return;
      }

      // Build the Worker URL
      const workerUrl = this._getWorkerUrl();
      this.workerPool = new WorkerPool(workerUrl, 1, this.logger);
      this.logger.info?.('[VideoPosterExtractor] Worker initialized successfully');
    } catch (error) {
      this.logger.warn?.('[VideoPosterExtractor] Worker initialization failed, will process on main thread:', error.message);
      this.workerPool = null;
    }
  }

  /**
   * Get the Worker URL
   * Supports Electron and standard browser environments
   */
  _getWorkerUrl() {
    // Use a relative path consistent with other Workers in the project
    // In Electron, the Worker file path is relative to the current HTML page
    return 'workers/video-poster.worker.js';
  }

  /**
   * Check whether Worker can be used
   */
  get _canUseWorker() {
    return this.workerPool !== null;
  }

  /**
   * Extract thumbnail from a video file
   * @param {File} file - video file
   * @param {Object} options - config options
   * @param {number} options.timeOffset - timestamp in seconds to extract frame, default 0.5
   * @param {number} options.maxWidth - maximum width, default 400
   * @param {number} options.quality - JPEG quality, default 0.8
   * @returns {Promise<{success: boolean, dataUrl?: string, blob?: Blob, error?: string}>}
   */
  async extractPoster(file, options = {}) {
    const {
      timeOffset = 0.5,
      maxWidth = 400,
      quality = 0.8
    } = options;

    return new Promise((resolve) => {
      // Create a hidden video element
      const video = document.createElement('video');
      video.style.display = 'none';
      video.muted = true;
      video.preload = 'metadata';
      video.crossOrigin = 'anonymous';

      // Create an object URL
      const objectUrl = URL.createObjectURL(file);
      video.src = objectUrl;

      const cleanup = () => {
        URL.revokeObjectURL(objectUrl);
        if (video.parentNode) {
          video.parentNode.removeChild(video);
        }
      };

      const onError = (error) => {
        cleanup();
        this.logger.error?.('[VideoPosterExtractor] Extraction failed:', error);
        resolve({ success: false, error: error.message || 'Unknown error' });
      };

      // Timeout handling
      const timeout = setTimeout(() => {
        onError(new Error('Poster extraction timed out'));
      }, 15000);

      // Metadata loaded
      video.onloadedmetadata = () => {
        // Set the timestamp (skip possible black screen at the start)
        const seekTime = Math.min(timeOffset, video.duration * 0.1);
        this.logger.info?.(`[VideoPosterExtractor] Video duration: ${video.duration}s, seek to: ${seekTime}s`);
        video.currentTime = seekTime;
      };

      // Seek completed
      video.onseeked = async () => {
        clearTimeout(timeout);

        try {
          // Check video dimensions
          if (video.videoWidth === 0 || video.videoHeight === 0) {
            cleanup();
            resolve({ success: false, error: 'Video dimensions are 0' });
            return;
          }

          // Use Worker processing (if available)
          if (this._canUseWorker) {
            await this._extractWithWorker(video, { maxWidth, quality }, cleanup, resolve);
          } else {
            await this._extractWithMainThread(video, { maxWidth, quality }, cleanup, resolve);
          }
        } catch (error) {
          cleanup();
          resolve({ success: false, error: error.message });
        }
      };

      video.onerror = (e) => {
        clearTimeout(timeout);
        onError(new Error('Video loading failed: ' + (e.message || 'Unknown error')));
      };

      // Add to DOM (required by some browsers)
      document.body.appendChild(video);
    });
  }

  /**
   * Extract thumbnail using Worker
   */
  async _extractWithWorker(video, options, cleanup, resolve) {
    const { maxWidth, quality } = options;

    try {
      // Create an ImageBitmap from the video frame
      const imageBitmap = await createImageBitmap(video);

      // Process using Worker
      const result = await this.workerPool.execute('processFrame', {
        imageBitmap,
        options: { maxWidth, quality }
      }, [imageBitmap]);

      cleanup();

      if (result.isBlack) {
        this.logger.warn?.('[VideoPosterExtractor] Black screen detected, trying next frame');
        // Try next frame
        const nextTime = Math.min(video.currentTime + 0.5, video.duration * 0.2);
        if (nextTime > video.currentTime) {
          video.currentTime = nextTime;
          return;
        }
      }

      this.logger.info?.(`[VideoPosterExtractor] Poster extracted successfully: ${result.width}x${result.height}, size=${result.size}`);
      resolve({
        success: true,
        dataUrl: result.dataUrl,
        blob: result.blob,
        width: result.width,
        height: result.height,
        size: result.size
      });
    } catch (error) {
      // Worker failed, fall back to main thread
      this.logger.warn?.('[VideoPosterExtractor] Worker processing failed, falling back to main thread:', error.message);
      await this._extractWithMainThread(video, options, cleanup, resolve);
    }
  }

  /**
   * Extract thumbnail on the main thread (fallback)
   */
  async _extractWithMainThread(video, options, cleanup, resolve) {
    const { maxWidth, quality } = options;

    // Create Canvas
    const canvas = document.createElement('canvas');

    // Calculate dimensions (maintain aspect ratio)
    let width = video.videoWidth;
    let height = video.videoHeight;

    if (width > maxWidth) {
      const ratio = maxWidth / width;
      width = maxWidth;
      height = Math.round(height * ratio);
    }

    canvas.width = width;
    canvas.height = height;

    // Draw the frame
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, width, height);

    // Check if it is a black screen
    const imageData = ctx.getImageData(0, 0, Math.min(width, 100), Math.min(height, 100));
    const data = imageData.data;
    let isBlack = true;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (r > 15 || g > 15 || b > 15) {
        isBlack = false;
        break;
      }
    }

    if (isBlack) {
      this.logger.warn?.('[VideoPosterExtractor] Black screen detected, trying next frame');
      // Try next frame
      const nextTime = Math.min(video.currentTime + 0.5, video.duration * 0.2);
      if (nextTime > video.currentTime) {
        video.currentTime = nextTime;
        return;
      }
    }

    // Export as Blob
    canvas.toBlob((blob) => {
      cleanup();

      if (blob) {
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        this.logger.info?.(`[VideoPosterExtractor] Poster extracted successfully: ${width}x${height}, size=${blob.size}`);
        resolve({
          success: true,
          dataUrl,
          blob,
          width,
          height,
          size: blob.size
        });
      } else {
        resolve({ success: false, error: 'Canvas export failed' });
      }
    }, 'image/jpeg', quality);
  }

  /**
   * Extract thumbnail from a video file path (Electron environment)
   * @param {string} filePath - video file path
   * @param {Object} options - config options
   * @returns {Promise<{success: boolean, dataUrl?: string, blob?: Blob, error?: string}>}
   */
  async extractPosterFromPath(filePath, options = {}) {
    // Convert the file path to a file:// URL
    const fileUrl = `file:///${filePath.replace(/\\/g, '/')}`;

    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.style.display = 'none';
      video.muted = true;
      video.preload = 'metadata';

      const cleanup = () => {
        if (video.parentNode) {
          video.parentNode.removeChild(video);
        }
      };

      const timeout = setTimeout(() => {
        cleanup();
        resolve({ success: false, error: 'Poster extraction timed out' });
      }, 15000);

      video.onloadedmetadata = () => {
        const seekTime = Math.min(options.timeOffset || 0.5, video.duration * 0.1);
        video.currentTime = seekTime;
      };

      video.onseeked = async () => {
        clearTimeout(timeout);

        try {
          if (video.videoWidth === 0 || video.videoHeight === 0) {
            cleanup();
            resolve({ success: false, error: 'Video dimensions are 0' });
            return;
          }

          const maxWidth = options.maxWidth || 400;
          const quality = options.quality || 0.8;

          // Use Worker processing (if available)
          if (this._canUseWorker) {
            await this._extractWithWorker(video, { maxWidth, quality }, cleanup, resolve);
          } else {
            await this._extractWithMainThread(video, { maxWidth, quality }, cleanup, resolve);
          }
        } catch (error) {
          cleanup();
          resolve({ success: false, error: error.message });
        }
      };

      video.onerror = () => {
        clearTimeout(timeout);
        cleanup();
        resolve({ success: false, error: 'Video loading failed' });
      };

      video.src = fileUrl;
      document.body.appendChild(video);
    });
  }

  /**
   * Destroy the extractor and release resources
   */
  destroy() {
    if (this.workerPool) {
      this.workerPool.terminate();
      this.workerPool = null;
    }
  }
}
