const fs = require('fs');
const path = require('path');
const { parentPort } = require('worker_threads');

// Import the logger module
const logger = require('../../logger');

// Listen to messages from the main thread
parentPort.on('message', (message) => {
  const { type, id, sourcePath, targetPath, options } = message;

  if (type === 'copy-file') {
    handleCopyFile(id, sourcePath, targetPath, options);
  } else if (type === 'copy-file-with-metadata') {
    handleCopyFileWithMetadata(id, sourcePath, targetPath, options);
  }
});

/**
 * Handle file copy request
 * @param {number} id - request ID
 * @param {string} sourcePath - source file path
 * @param {string} targetPath - target file path
 * @param {Object} options - copy options
 */
async function handleCopyFile(id, sourcePath, targetPath, options = {}) {
  try {
    logger.info(`[FileCopyWorker] Starting to copy file: ${sourcePath} -> ${targetPath}`);

    // Check if source file exists
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Source file does not exist: ${sourcePath}`);
    }

    // Get source file info
    const sourceStats = fs.statSync(sourcePath);
    if (!sourceStats.isFile()) {
      throw new Error(`Source path is not a file: ${sourcePath}`);
    }

    // Ensure target directory exists
    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
      logger.info(`[FileCopyWorker] Creating target directory: ${targetDir}`);
    }

    // Use stream copy for large files
    const fileSize = sourceStats.size;
    const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024; // 100MB

    if (fileSize > LARGE_FILE_THRESHOLD && !options.forceSync) {
      // Large files use stream copy
      await streamCopyFile(sourcePath, targetPath, id);
    } else {
      // Small files use fast copy
      await fastCopyFile(sourcePath, targetPath);
    }

    // Verify copy result
    if (!fs.existsSync(targetPath)) {
      throw new Error('Target file does not exist after copy');
    }

    const targetStats = fs.statSync(targetPath);
    if (targetStats.size !== sourceStats.size) {
      throw new Error(`File size mismatch: source ${sourceStats.size} bytes, target ${targetStats.size} bytes`);
    }

    logger.info(`[FileCopyWorker] File copy successful: ${targetPath}, size: ${targetStats.size} bytes`);

    parentPort.postMessage({
      id,
      success: true,
      filePath: targetPath,
      fileSize: targetStats.size,
      fileName: path.basename(targetPath)
    });

  } catch (err) {
    logger.error(`[FileCopyWorker] Failed to copy file: ${sourcePath} -> ${targetPath}`, err);
    parentPort.postMessage({ id, success: false, error: err.message });
  }
}

/**
 * Fast copy file (for small files)
 * @param {string} sourcePath - source file path
 * @param {string} targetPath - target file path
 */
async function fastCopyFile(sourcePath, targetPath) {
  return new Promise((resolve, reject) => {
    fs.copyFile(sourcePath, targetPath, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Stream copy file (for large files, with progress reporting)
 * @param {string} sourcePath - source file path
 * @param {string} targetPath - target file path
 * @param {number} id - request ID
 */
async function streamCopyFile(sourcePath, targetPath, id) {
  return new Promise((resolve, reject) => {
    const CHUNK_SIZE = 64 * 1024; // 64KB chunks
    const readStream = fs.createReadStream(sourcePath, { highWaterMark: CHUNK_SIZE });
    const writeStream = fs.createWriteStream(targetPath);

    let bytesCopied = 0;
    let lastReportedProgress = 0;
    const PROGRESS_INTERVAL = 10; // Report progress every 10%

    const sourceStats = fs.statSync(sourcePath);
    const totalSize = sourceStats.size;

    readStream.on('data', (chunk) => {
      bytesCopied += chunk.length;

      // Report progress
      const progress = Math.floor((bytesCopied / totalSize) * 100);
      if (progress >= lastReportedProgress + PROGRESS_INTERVAL) {
        lastReportedProgress = progress;
        parentPort.postMessage({
          type: 'progress',
          id,
          progress,
          bytesCopied,
          totalSize
        });
      }
    });

    readStream.on('error', (err) => {
      logger.error(`[FileCopyWorker] Error reading source file: ${sourcePath}`, err);
      writeStream.destroy();
      reject(err);
    });

    writeStream.on('error', (err) => {
      logger.error(`[FileCopyWorker] Error writing target file: ${targetPath}`, err);
      readStream.destroy();
      reject(err);
    });

    writeStream.on('finish', () => {
      logger.info(`[FileCopyWorker] Stream copy completed: ${targetPath}`);
      resolve();
    });

    // Use pipe for stream copy
    readStream.pipe(writeStream);
  });
}

/**
 * Handle file copy request with metadata (preserve file attributes)
 * @param {number} id - request ID
 * @param {string} sourcePath - source file path
 * @param {string} targetPath - target file path
 * @param {Object} options - copy options
 */
async function handleCopyFileWithMetadata(id, sourcePath, targetPath, options = {}) {
  try {
    // Perform normal copy first
    await handleCopyFile(id, sourcePath, targetPath, options);

    // Copy file metadata (modification time, access time, etc.)
    const sourceStats = fs.statSync(sourcePath);
    fs.utimesSync(targetPath, sourceStats.atime, sourceStats.mtime);

    logger.info(`[FileCopyWorker] File metadata copied: ${targetPath}`);

  } catch (err) {
    logger.error(`[FileCopyWorker] Failed to copy file metadata: ${sourcePath}`, err);
    // metadata copy failure does not affect main flow，only log
  }
}
