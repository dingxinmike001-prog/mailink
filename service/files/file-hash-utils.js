/**
 * File hash and verification utility
 * Used to verify downloaded file integrity
 * Uses Worker thread for hash calculation to avoid blocking the main thread
 */

const fs = require('fs');
const crypto = require('crypto');
const fsPromises = fs.promises;
const { getFileHashManager } = require('./workers/file-hash-manager');

/**
 * Calculate file SHA256 hash
 * Prefer Worker thread, fallback to main thread on failure
 * @param {string} filePath - file path
 * @param {Object} options - options
 * @param {boolean} [options.useWorker=true] - whether to use Worker
 * @param {number} [options.timeout=300000] - Worker timeout in milliseconds
 * @returns {Promise<string>} - hexadecimal hash value
 */
async function calculateFileHash(filePath, options = {}) {
  const { useWorker = true, timeout = 300000 } = options;

  // Prefer Worker thread
  if (useWorker) {
    try {
      const manager = getFileHashManager();
      if (manager.isReady) {
        return await manager.calculateFileHash(filePath, timeout);
      }
    } catch (error) {
      console.warn('[file-hash-utils] Worker hash calculation failed, falling back to main thread:', error.message);
    }
  }

  // Fall back to main thread calculation
  return calculateFileHashMainThread(filePath);
}

/**
 * Calculate file SHA256 hash in main thread (fallback)
 * @param {string} filePath - file path
 * @returns {Promise<string>} - hexadecimal hash value
 */
async function calculateFileHashMainThread(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });
  });
}

/**
 * Calculate data SHA256 hash
 * Prefer Worker thread, fallback to main thread on failure
 * @param {Buffer|string} data - data
 * @param {Object} options - options
 * @param {boolean} [options.useWorker=true] - whether to use Worker
 * @param {number} [options.timeout=30000] - Worker timeout in milliseconds
 * @returns {Promise<string>} - hexadecimal hash value
 */
async function calculateDataHash(data, options = {}) {
  const { useWorker = true, timeout = 30000 } = options;

  // Prefer Worker thread
  if (useWorker) {
    try {
      const manager = getFileHashManager();
      if (manager.isReady) {
        return await manager.calculateDataHash(data, timeout);
      }
    } catch (error) {
      console.warn('[file-hash-utils] Worker hash calculation failed, falling back to main thread:', error.message);
    }
  }

  // Fall back to main thread calculation
  return calculateDataHashMainThread(data);
}

/**
 * Calculate data SHA256 hash in main thread (fallback)
 * @param {Buffer|string} data - data
 * @returns {string} - hexadecimal hash value
 */
function calculateDataHashMainThread(data) {
  const hash = crypto.createHash('sha256');
  hash.update(data);
  return hash.digest('hex');
}

/**
 * Verify file integrity
 * @param {string} filePath - file path
 * @param {object} expectedProps - expected file properties
 *   - size: file size in bytes
 *   - hash: file hash value (optional)
 *   - modifiedAfter: modification timestamp lower bound (optional)
 * @returns {Promise<object>} - verification result
 *   {
 *     isValid: boolean,
 *     exists: boolean,
 *     sizeMatches: boolean,
 *     hashMatches: boolean (if hash provided),
 *     isReadable: boolean,
 *     actualSize: number,
 *     actualHash: string (if hash provided),
 *     error: string (if any)
 *   }
 */
async function verifyFileIntegrity(filePath, expectedProps = {}) {
  const result = {
    isValid: false,
    exists: false,
    sizeMatches: false,
    hashMatches: false,
    isReadable: false,
    actualSize: 0,
    actualHash: null,
    error: null
  };

  try {
    // Check if file exists
    const stats = await fsPromises.stat(filePath);
    result.exists = true;
    result.actualSize = stats.size;

    // Check file size
    if (expectedProps.size !== undefined) {
      result.sizeMatches = stats.size === expectedProps.size;
      if (!result.sizeMatches) {
        result.error = `Size mismatch: expected ${expectedProps.size}, got ${stats.size}`;
      }
    }

    // Check readability
    try {
      await fsPromises.access(filePath, fs.constants.R_OK);
      result.isReadable = true;
    } catch (e) {
      result.error = 'File is not readable';
      return result;
    }

    // Check modification time
    if (expectedProps.modifiedAfter !== undefined) {
      const modifiedTime = stats.mtimeMs;
      if (modifiedTime < expectedProps.modifiedAfter) {
        result.error = `File modified before expected time`;
        return result;
      }
    }

    // Calculate hash value
    if (expectedProps.hash) {
      result.actualHash = await calculateFileHash(filePath);
      result.hashMatches = result.actualHash === expectedProps.hash;
      if (!result.hashMatches) {
        result.error = `Hash mismatch: expected ${expectedProps.hash}, got ${result.actualHash}`;
        return result;
      }
    }

    // Comprehensive determination
    result.isValid = result.exists && result.isReadable && 
                   (!expectedProps.size || result.sizeMatches) &&
                   (!expectedProps.hash || result.hashMatches);

  } catch (error) {
    result.exists = false;
    result.error = error.message;
  }

  return result;
}

/**
 * Quickly check if file exists and size matches
 * @param {string} filePath - file path
 * @param {number} expectedSize - expected file size
 * @returns {Promise<boolean>}
 */
async function quickCheckFile(filePath, expectedSize) {
  try {
    const stats = await fsPromises.stat(filePath);
    return stats.size === expectedSize;
  } catch (e) {
    return false;
  }
}

/**
 * Generate file metadata (for storage)
 * @param {string} filePath - file path
 * @returns {Promise<object>} - file metadata
 */
async function generateFileMetadata(filePath) {
  try {
    const stats = await fsPromises.stat(filePath);
    const hash = await calculateFileHash(filePath);
    
    return {
      size: stats.size,
      hash: hash,
      modifiedTime: stats.mtimeMs,
      createdTime: stats.birthtime ? stats.birthtimeMs : stats.ctimeMs
    };
  } catch (error) {
    throw new Error(`Failed to generate file metadata: ${error.message}`);
  }
}

module.exports = {
  calculateFileHash,
  calculateDataHash,
  verifyFileIntegrity,
  quickCheckFile,
  generateFileMetadata
};
