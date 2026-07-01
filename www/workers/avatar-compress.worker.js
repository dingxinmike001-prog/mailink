/**
 * Avatar compression Worker
 * Uses OffscreenCanvas in a Worker thread to compress avatar images to 48x48px
 * and generate 8-bit grayscale images, avoiding blocking the main thread
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
 * Compress image to 48x48px and generate grayscale version
 * @param {ImageBitmap} bitmap - original image bitmap
 * @returns {Promise<{color: string, gray: string}>}
 */
async function compressAvatar(bitmap) {
  const TARGET_SIZE = 48;

  // Create color image canvas
  const colorCanvas = new OffscreenCanvas(TARGET_SIZE, TARGET_SIZE);
  const colorCtx = colorCanvas.getContext('2d');

  // Crop and scale image using cover mode
  const scale = Math.max(TARGET_SIZE / bitmap.width, TARGET_SIZE / bitmap.height);
  const scaledWidth = bitmap.width * scale;
  const scaledHeight = bitmap.height * scale;
  const offsetX = (TARGET_SIZE - scaledWidth) / 2;
  const offsetY = (TARGET_SIZE - scaledHeight) / 2;

  // Draw the color image
  colorCtx.drawImage(bitmap, offsetX, offsetY, scaledWidth, scaledHeight);

  // Get image data for grayscale generation
  const imageData = colorCtx.getImageData(0, 0, TARGET_SIZE, TARGET_SIZE);
  const data = imageData.data;

  // Create grayscale canvas
  const grayCanvas = new OffscreenCanvas(TARGET_SIZE, TARGET_SIZE);
  const grayCtx = grayCanvas.getContext('2d');
  const grayImageData = grayCtx.createImageData(TARGET_SIZE, TARGET_SIZE);
  const grayData = grayImageData.data;

  // Convert to 8-bit grayscale
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // Use standard grayscale conversion formula: Gray = 0.299*R + 0.587*G + 0.114*B
    const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    grayData[i] = gray;     // R
    grayData[i + 1] = gray; // G
    grayData[i + 2] = gray; // B
    grayData[i + 3] = 255;  // A (opaque)
  }

  grayCtx.putImageData(grayImageData, 0, 0);

  // Convert to JPEG Blob
  const colorBlob = await colorCanvas.convertToBlob({
    type: 'image/jpeg',
    quality: 0.85
  });

  const grayBlob = await grayCanvas.convertToBlob({
    type: 'image/jpeg',
    quality: 0.85
  });

  // Convert to Data URL
  const [colorDataUrl, grayDataUrl] = await Promise.all([
    blobToDataUrl(colorBlob),
    blobToDataUrl(grayBlob)
  ]);

  return {
    color: colorDataUrl,
    gray: grayDataUrl
  };
}

/**
 * Create ImageBitmap from various input formats
 * @param {string|ArrayBuffer} imageData - image data (data:image URL or ArrayBuffer)
 * @returns {Promise<ImageBitmap>}
 */
async function createImageBitmapFromData(imageData) {
  if (typeof imageData === 'string') {
    // data:image URL format
    const response = await fetch(imageData);
    const blob = await response.blob();
    return await createImageBitmap(blob);
  } else if (imageData instanceof ArrayBuffer) {
    // ArrayBuffer format
    const blob = new Blob([imageData]);
    return await createImageBitmap(blob);
  } else {
    throw new Error('Unsupported image data format');
  }
}

// Process message
self.onmessage = async (e) => {
  const { id, type, payload } = e.data;

  if (type === 'compress') {
    const { imageData } = payload;

    try {
      // Create ImageBitmap
      const bitmap = await createImageBitmapFromData(imageData);

      // Compress and generate a grayscale image
      const result = await compressAvatar(bitmap);

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
      logger.error(`compression failed: ${error.message}`);
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
