/**
 * File hash calculation Worker
 * Responsibility: calculate file SHA256 hash in background thread
 * Avoid blocking main thread with large file hash calculation
 */

const fs = require('fs');
const crypto = require('crypto');
const { parentPort } = require('worker_threads');
const logger = require('../../logger');

// Listen to messages from the main thread
parentPort.on('message', (message) => {
  const { type, id, filePath, data } = message;

  if (type === 'calculate-file-hash') {
    handleCalculateFileHash(id, filePath);
  } else if (type === 'calculate-data-hash') {
    handleCalculateDataHash(id, data);
  }
});

/**
 * Calculate file SHA256 hash
 * @param {string} id - task ID
 * @param {string} filePath - file path
 */
async function handleCalculateFileHash(id, filePath) {
  logger.debug(`[FileHashWorker] Starting file hash calculation`, { taskId: id, filePath });
  const startTime = Date.now();

  try {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    let bytesProcessed = 0;

    stream.on('error', (err) => {
      logger.error(`[FileHashWorker] File read error`, { taskId: id, filePath, error: err.message });
      parentPort.postMessage({
        id,
        success: false,
        error: `Failed to read file: ${err.message}`
      });
    });

    stream.on('data', (chunk) => {
      hash.update(chunk);
      bytesProcessed += chunk.length;
    });

    stream.on('end', () => {
      const hashValue = hash.digest('hex');
      const duration = Date.now() - startTime;
      logger.info(`[FileHashWorker] File hash calculated`, { taskId: id, filePath, bytesProcessed, duration, hashPrefix: hashValue.substring(0, 16) });
      parentPort.postMessage({
        id,
        success: true,
        hash: hashValue
      });
    });
  } catch (err) {
    logger.error(`[FileHashWorker] Hash calculation failed`, { taskId: id, filePath, error: err.message });
    parentPort.postMessage({
      id,
      success: false,
      error: err.message
    });
  }
}

/**
 * Calculate data SHA256 hash
 * @param {string} id - task ID
 * @param {Buffer|string} data - data
 */
function handleCalculateDataHash(id, data) {
  logger.debug(`[FileHashWorker] Starting data hash calculation`, { taskId: id, dataSize: data?.length || 0 });
  const startTime = Date.now();

  try {
    const hash = crypto.createHash('sha256');
    hash.update(data);
    const hashValue = hash.digest('hex');
    const duration = Date.now() - startTime;
    logger.info(`[FileHashWorker] Data hash calculated`, { taskId: id, dataSize: data?.length || 0, duration, hashPrefix: hashValue.substring(0, 16) });
    parentPort.postMessage({
      id,
      success: true,
      hash: hashValue
    });
  } catch (err) {
    logger.error(`[FileHashWorker] Data hash calculation failed`, { taskId: id, error: err.message });
    parentPort.postMessage({
      id,
      success: false,
      error: err.message
    });
  }
}

// Worker initialization log
logger.info('[FileHashWorker] Initialized and ready');
parentPort.postMessage({ type: 'ready' });
