/**
 * Image thumbnail generation Worker
 * Uses OffscreenCanvas in a Worker thread to generate thumbnails, avoiding blocking the main thread
 */

// Worker internal log
const logger = {
  info: (msg) => self.postMessage({ type: 'log', level: 'info', message: msg }),
  warn: (msg) => self.postMessage({ type: 'log', level: 'warn', message: msg }),
  error: (msg) => self.postMessage({ type: 'log', level: 'error', message: msg })
};

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
 * Generate thumbnail
 * @param {ImageBitmap} bitmap - original image bitmap
 * @param {Object} options - configuration options
 * @returns {Promise<string>} - thumbnail Data URL
 */
async function createThumbnail(bitmap, options = {}) {
  const {
    maxWidth = 100,
    maxHeight = 100,
    type = 'image/png',
    quality = 0.8
  } = options;

  let { width, height } = bitmap;

  // Calculate the scaling ratio
  if (width > maxWidth || height > maxHeight) {
    const ratio = Math.min(maxWidth / width, maxHeight / height);
    width = width * ratio;
    height = height * ratio;
  }

  // Create OffscreenCanvas
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Draw the image
  ctx.drawImage(bitmap, 0, 0, width, height);

  // Convert to Blob
  const blob = await canvas.convertToBlob({
    type,
    quality
  });

  // Convert to Data URL
  const dataUrl = await blobToDataUrl(blob);

  return dataUrl;
}

/**
 * Convert SVG to PNG
 * @param {string} svgString - SVG string
 * @param {Object} options - configuration options
 * @returns {Promise<string>} - PNG Data URL
 */
async function svgToPngDataUrl(svgString, options = {}) {
  const { width = 16, height = 16, fit = 'cover' } = options;

  try {
    // Create an SVG Blob
    const svgBlob = new Blob([svgString], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(svgBlob);

    // Get the SVG image
    const response = await fetch(url);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);

    // Release the URL
    URL.revokeObjectURL(url);

    // Create OffscreenCanvas
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');

    let drawWidth, drawHeight, offsetX, offsetY;

    if (fit === 'cover') {
      const scale = Math.max(width / bitmap.width, height / bitmap.height);
      drawWidth = bitmap.width * scale;
      drawHeight = bitmap.height * scale;
      offsetX = (width - drawWidth) / 2;
      offsetY = (height - drawHeight) / 2;
    } else if (fit === 'contain') {
      const scale = Math.min(width / bitmap.width, height / bitmap.height);
      drawWidth = bitmap.width * scale;
      drawHeight = bitmap.height * scale;
      offsetX = (width - drawWidth) / 2;
      offsetY = (height - drawHeight) / 2;
    } else {
      drawWidth = width;
      drawHeight = height;
      offsetX = 0;
      offsetY = 0;
    }

    ctx.drawImage(bitmap, offsetX, offsetY, drawWidth, drawHeight);

    // Release the bitmap
    bitmap.close();

    // Convert to Blob
    const pngBlob = await canvas.convertToBlob({
      type: 'image/png'
    });

    // Convert to Data URL
    const dataUrl = await blobToDataUrl(pngBlob);

    return dataUrl;
  } catch (error) {
    throw new Error(`SVG conversion failed: ${error.message}`);
  }
}

/**
 * Create ImageBitmap from various input formats
 * @param {string|ArrayBuffer|Blob} imageData - image data
 * @returns {Promise<ImageBitmap>}
 */
async function createImageBitmapFromData(imageData) {
  if (imageData instanceof Blob) {
    return await createImageBitmap(imageData);
  } else if (imageData instanceof ArrayBuffer) {
    const blob = new Blob([imageData]);
    return await createImageBitmap(blob);
  } else if (typeof imageData === 'string') {
    if (imageData.startsWith('data:image')) {
      // data:image URL format
      const response = await fetch(imageData);
      const blob = await response.blob();
      return await createImageBitmap(blob);
    } else if (imageData.startsWith('http')) {
      // HTTP URL format
      const response = await fetch(imageData);
      const blob = await response.blob();
      return await createImageBitmap(blob);
    } else {
      // Assume it is base64
      const response = await fetch(`data:image/png;base64,${imageData}`);
      const blob = await response.blob();
      return await createImageBitmap(blob);
    }
  } else {
    throw new Error('Unsupported image data format');
  }
}

// Process message
self.onmessage = async (e) => {
  const { id, type, payload } = e.data;

  if (type === 'createThumbnail') {
    const { imageData, options } = payload;

    try {
      // Create ImageBitmap
      const bitmap = await createImageBitmapFromData(imageData);

      // Generate thumbnail
      const result = await createThumbnail(bitmap, options);

      // Release resources
      bitmap.close();

      // Send result
      self.postMessage({
        id,
        type: 'result',
        success: true,
        data: result
      });
    } catch (error) {
      logger.error(`thumbnail generation failed: ${error.message}`);
      self.postMessage({
        id,
        type: 'result',
        success: false,
        error: error.message || 'Worker processing failed'
      });
    }
  } else if (type === 'svgToPng') {
    const { svgString, options } = payload;

    try {
      const result = await svgToPngDataUrl(svgString, options);
      self.postMessage({
        id,
        type: 'result',
        success: true,
        data: result
      });
    } catch (error) {
      logger.error(`SVG conversion failed: ${error.message}`);
      self.postMessage({
        id,
        type: 'result',
        success: false,
        error: error.message || 'Worker processing failed'
      });
    }
  }
};

// Notify main thread that Worker is ready
self.postMessage({ type: 'ready' });
