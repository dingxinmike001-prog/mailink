/**
 * Video cover extraction Worker
 * Uses OffscreenCanvas in a Worker thread to process images, avoiding blocking the main thread
 */

// Worker internal state
const logger = {
  info: (msg) => self.postMessage({ type: 'log', level: 'info', message: msg }),
  warn: (msg) => self.postMessage({ type: 'log', level: 'warn', message: msg }),
  error: (msg) => self.postMessage({ type: 'log', level: 'error', message: msg })
};

/**
 * Check whether image data is a black screen
 * @param {ImageData} imageData
 * @returns {boolean}
 */
function isBlackFrame(imageData) {
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r > 15 || g > 15 || b > 15) {
      return false;
    }
  }
  return true;
}

/**
 * Convert ImageBitmap to JPEG Blob
 * @param {ImageBitmap} bitmap
 * @param {number} width
 * @param {number} height
 * @param {number} quality
 * @returns {Promise<{blob: Blob, dataUrl: string}>}
 */
async function convertToJpeg(bitmap, width, height, quality) {
  // Create OffscreenCanvas
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Draw the image
  ctx.drawImage(bitmap, 0, 0, width, height);

  // Check if it is a black screen
  const imageData = ctx.getImageData(0, 0, Math.min(width, 100), Math.min(height, 100));
  const isBlack = isBlackFrame(imageData);

  // Convert to Blob
  const blob = await canvas.convertToBlob({
    type: 'image/jpeg',
    quality: quality
  });

  // Convert to Data URL (implemented via FileReader in the Worker)
  const dataUrl = await blobToDataUrl(blob);

  return { blob, dataUrl, isBlack };
}

/**
 * Convert Blob to Data URL
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Calculate scaled dimensions
 * @param {number} videoWidth
 * @param {number} videoHeight
 * @param {number} maxWidth
 * @returns {{width: number, height: number}}
 */
function calculateDimensions(videoWidth, videoHeight, maxWidth) {
  let width = videoWidth;
  let height = videoHeight;

  if (width > maxWidth) {
    const ratio = maxWidth / width;
    width = maxWidth;
    height = Math.round(height * ratio);
  }

  return { width, height };
}

// Process message
self.onmessage = async (e) => {
  const { id, type, payload } = e.data;

  if (type === 'extract') {
    const { videoFrame, videoWidth, videoHeight, options } = payload;
    const { maxWidth = 400, quality = 0.8 } = options;

    try {
      // Calculate dimensions
      const { width, height } = calculateDimensions(videoWidth, videoHeight, maxWidth);

      // Create scaled ImageBitmap
      const bitmap = await createImageBitmap(videoFrame, {
        resizeWidth: width,
        resizeHeight: height,
        resizeQuality: 'high'
      });

      // Convert to JPEG
      const { blob, dataUrl, isBlack } = await convertToJpeg(bitmap, width, height, quality);

      // Release resources
      bitmap.close();

      // Send result
      self.postMessage({
        id,
        type: 'result',
        success: true,
        data: {
          blob,
          dataUrl,
          width,
          height,
          size: blob.size,
          isBlack
        }
      });
    } catch (error) {
      self.postMessage({
        id,
        type: 'result',
        success: false,
        error: error.message || 'Worker processing failed'
      });
    }
  } else if (type === 'processFrame') {
    // Process already captured video frame data
    const { imageBitmap, options } = payload;
    const { maxWidth = 400, quality = 0.8 } = options;

    try {
      // Get original dimensions
      const videoWidth = imageBitmap.width;
      const videoHeight = imageBitmap.height;

      // Calculate dimensions
      const { width, height } = calculateDimensions(videoWidth, videoHeight, maxWidth);

      // Create scaled ImageBitmap
      const bitmap = await createImageBitmap(imageBitmap, {
        resizeWidth: width,
        resizeHeight: height,
        resizeQuality: 'high'
      });

      // Release the original bitmap
      imageBitmap.close();

      // Convert to JPEG
      const { blob, dataUrl, isBlack } = await convertToJpeg(bitmap, width, height, quality);

      // Release resources
      bitmap.close();

      // Send result
      self.postMessage({
        id,
        type: 'result',
        success: true,
        data: {
          blob,
          dataUrl,
          width,
          height,
          size: blob.size,
          isBlack
        }
      });
    } catch (error) {
      self.postMessage({
        id,
        type: 'result',
        success: false,
        error: error.message || 'Worker processing failed'
      });
    }
  }
};
