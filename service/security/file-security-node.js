/**
 * Backend file security verification module (Node.js version) — adapter layer
 *
 * Only includes Node.js-specific features (Worker threads, file path reading, Buffer operations),
 * constants and pure logic are unified from file-security-common.js
 *
 * Optimization: use Worker threads for dangerous file detection to avoid blocking main thread
 */

const path = require('path');
const fs = require('fs');
const { createWorkerManager } = require('../../shared/worker/worker-factory');

// Import constants and pure logic from shared module
const {
  DANGEROUS_EXTENSIONS,
  DANGEROUS_MIME_TYPES,
  EXECUTABLE_MAGIC_NUMBERS,
  PATHEXT_EXECUTABLES,
  getFileExtension,
  isDangerousExtension,
  isExecutableByPathExt,
  isDangerousMimeType,
  checkMagicNumberFromBytes,
  checkPEFileFromBytes,
  getSecurityWarningMessage
} = require('../../shared/security/file-security-common');

// Worker manager instance (lazy-loaded)
let workerManager = null;

/**
 * Get Worker manager instance
 * @returns {WorkerManager} Worker manager
 */
function getWorkerManager() {
  if (!workerManager) {
    workerManager = createWorkerManager('fileSecurity');
  }
  return workerManager;
}

/**
 * Check whether Worker can be used
 * @returns {boolean} Whether Worker can be used
 */
function canUseWorker() {
  try {
    // Check whether in main thread environment
    const { isMainThread } = require('worker_threads');
    return isMainThread;
  } catch (error) {
    return false;
  }
}

// ────────────────────────────────────────────
// Node.js-specific functions (operating Buffer / file paths)
// ────────────────────────────────────────────

/**
 * Convert Buffer to readBytes callback
 * @param {Buffer} buffer
 * @returns {Function} readBytes callback (offset, length) => number[]
 */
function bufferToReadBytes(buffer) {
  return (offset, length) => {
    const result = [];
    const end = Math.min(offset + length, buffer.length);
    for (let i = offset; i < end; i++) {
      result.push(buffer[i]);
    }
    return result;
  };
}

/**
 * Check file content magic number (Node.js side)
 * @param {Buffer} buffer - File content
 * @returns {Object|null} Detection result
 */
function checkMagicNumber(buffer) {
  if (!buffer || buffer.length < 2) {
    return null;
  }

  return checkMagicNumberFromBytes(bufferToReadBytes(buffer));
}

/**
 * Check whether it is a valid PE (Portable Executable) file (Node.js side)
 * @param {Buffer} buffer - File content (at least first 64 bytes)
 * @returns {Object|null} Detection result
 */
function checkPEFile(buffer) {
  if (!buffer || buffer.length < 64) {
    return null;
  }

  return checkPEFileFromBytes(bufferToReadBytes(buffer), buffer.length);
}

/**
 * Check whether file at path is PE file (async version)
 * @param {string} filePath - File path
 * @returns {Promise<Object|null>} Detection result
 */
async function checkPEFileFromPath(filePath) {
  try {
    const fd = await fs.promises.open(filePath, 'r');
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await fd.read(buffer, 0, 256, 0);
    await fd.close();

    if (bytesRead < 64) {
      return null;
    }

    return checkPEFile(buffer);
  } catch (error) {
    return null;
  }
}

/**
 * Check whether file at path is PE file (sync version)
 * @param {string} filePath - File path
 * @returns {Object|null} Detection result
 */
function checkPEFileFromPathSync(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(256);
    const bytesRead = fs.readSync(fd, buffer, 0, 256, 0);
    fs.closeSync(fd);

    if (bytesRead < 64) {
      return null;
    }

    return checkPEFile(buffer);
  } catch (error) {
    return null;
  }
}

/**
 * Read magic number from file path (async version)
 * @param {string} filePath - File path
 * @returns {Promise<Object|null>} Detection result
 */
async function checkMagicNumberFromFile(filePath) {
  try {
    const fd = await fs.promises.open(filePath, 'r');
    const buffer = Buffer.alloc(8);
    await fd.read(buffer, 0, 8, 0);
    await fd.close();

    return checkMagicNumber(buffer);
  } catch (error) {
    return null;
  }
}

/**
 * Read magic number from file path (sync version)
 * @param {string} filePath - File path
 * @returns {Object|null} Detection result
 */
function checkMagicNumberFromFileSync(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(8);
    fs.readSync(fd, buffer, 0, 8, 0);
    fs.closeSync(fd);

    return checkMagicNumber(buffer);
  } catch (error) {
    return null;
  }
}

/**
 * Comprehensive security check (main thread sync version)
 * Used inside Worker or as fallback when Worker fails
 * @param {Object} fileInfo - File info object
 * @returns {Object} Check result
 */
function checkFileSecuritySync(fileInfo) {
  const result = {
    isSafe: true,
    isDangerous: false,
    reasons: [],
    extension: null,
    mimeType: null,
    magicCheck: null,
    peCheck: null
  };

  if (!fileInfo || typeof fileInfo !== 'object') {
    result.isSafe = false;
    result.reasons.push('Invalid file information');
    return result;
  }

  const { name, type, path: filePath } = fileInfo;

  // Check extension (only real executable files)
  result.extension = getFileExtension(name);
  if (result.extension && isDangerousExtension(name)) {
    result.isDangerous = true;
    result.isSafe = false;
    result.reasons.push(`Executable file: .${result.extension}`);
  }

  // Check MIME type
  result.mimeType = type;
  if (isDangerousMimeType(type, name)) {
    result.isDangerous = true;
    result.isSafe = false;
    result.reasons.push(`Executable file MIME type: ${type}`);
  }

  // Check file magic number (only PE files)
  if (filePath && typeof filePath === 'string') {
    try {
      result.peCheck = checkPEFileFromPathSync(filePath);
      if (result.peCheck && result.peCheck.isExecutable) {
        result.isDangerous = true;
        result.isSafe = false;
        result.reasons.push(`Windows executable: ${result.peCheck.type}`);
      }

      // Only check MZ header (DOS/Windows executables)
      if (!result.peCheck) {
        result.magicCheck = checkMagicNumberFromFileSync(filePath);
        if (result.magicCheck && result.magicCheck.isExecutable) {
          result.isDangerous = true;
          result.isSafe = false;
          result.reasons.push(`Windows executable: ${result.magicCheck.type}`);
        }
      }
    } catch (e) {
      // ignore magic number check error
    }
  }

  return result;
}

/**
 * Comprehensive security check (Worker version)
 * Use Worker threads for dangerous file detection to avoid blocking main thread
 * Only block immediately-executable Windows files, allow all others
 * @param {Object} fileInfo - File info object
 * @param {string} fileInfo.name - File name
 * @param {string} fileInfo.type - MIME type
 * @param {number} fileInfo.size - File size
 * @param {string} [fileInfo.path] - File path (optional, used for magic number check)
 * @param {Object} [options] - Optional config
 * @param {boolean} [options.useWorker=true] - Whether to use Worker
 * @param {string} [options.mode='normal'] - Detection mode: light/normal/strict
 * @returns {Promise<Object>} Check result
 */
async function checkFileSecurity(fileInfo, options = {}) {
  const { useWorker = true, mode = 'normal' } = options;

  // If Worker can be used and file content needs checking, use Worker for detection
  if (useWorker && canUseWorker() && fileInfo?.path) {
    try {
      const manager = getWorkerManager();
      const result = await manager.sendTask({
        type: 'check-file',
        payload: {
          filePath: fileInfo.path,
          fileInfo: {
            name: fileInfo.name,
            type: fileInfo.type,
            size: fileInfo.size
          },
          mode
        }
      }, 30000); // 30-second timeout

      return {
        isSafe: result.isSafe,
        isDangerous: result.isDangerous,
        reasons: result.reasons,
        extension: result.extension,
        mimeType: result.mimeType,
        magicCheck: result.magicCheck,
        peCheck: result.peCheck,
        duration: result.duration,
        mode: result.mode
      };
    } catch (error) {
      // Fallback to main thread detection when Worker fails
      console.warn('Worker detection failed, falling back to main thread:', error.message);
    }
  }

  // Main thread detection (sync version)
  return checkFileSecuritySync(fileInfo);
}

/**
 * Batch file security check (Worker version)
 * Use Worker threads for batch processing to avoid blocking main thread
 * @param {Array} files - File list [{filePath, fileInfo}]
 * @param {Object} [options] - Optional config
 * @param {string} [options.mode='normal'] - Detection mode
 * @returns {Promise<Object>} Batch check result
 */
async function checkFileSecurityBatch(files, options = {}) {
  const { mode = 'normal' } = options;

  if (!Array.isArray(files) || files.length === 0) {
    return {
      results: [],
      summary: {
        total: 0,
        safe: 0,
        dangerous: 0,
        safeRate: 0,
        duration: 0
      }
    };
  }

  // Use Worker for batch detection
  if (canUseWorker()) {
    try {
      const manager = getWorkerManager();
      const result = await manager.sendTask({
        type: 'check-batch',
        payload: {
          files,
          mode
        }
      }, 60000); // 60-second timeout (batch processing needs more time)

      return result;
    } catch (error) {
      console.warn('Worker batch detection failed, falling back to main thread:', error.message);
    }
  }

  // Main thread batch detection
  const startTime = Date.now();
  const results = [];
  let safeCount = 0;
  let dangerousCount = 0;

  for (const fileItem of files) {
    const { filePath, fileInfo } = fileItem;
    const result = checkFileSecuritySync({
      ...fileInfo,
      path: filePath
    });

    results.push({
      filePath,
      ...result,
      status: 'success'
    });

    if (result.isSafe) {
      safeCount++;
    } else {
      dangerousCount++;
    }
  }

  const duration = Date.now() - startTime;

  return {
    results,
    summary: {
      total: files.length,
      safe: safeCount,
      dangerous: dangerousCount,
      safeRate: safeCount / files.length,
      duration,
      avgTimePerFile: duration / files.length
    }
  };
}

/**
 * Verify whether file is allowed to transfer (Node.js side)
 * @param {string} filePath - File path
 * @param {Object} metadata - File metadata
 * @returns {Promise<Object>} Verification result
 */
async function validateFileForTransfer(filePath, metadata = {}) {
  const fileInfo = {
    name: metadata.name || path.basename(filePath),
    type: metadata.type || '',
    size: metadata.size || 0,
    path: filePath
  };

  const checkResult = await checkFileSecurity(fileInfo);

  return {
    allowed: checkResult.isSafe,
    ...checkResult,
    message: getSecurityWarningMessage(checkResult)
  };
}

/**
 * Verify whether email attachment is safe
 * @param {Object} attachment - Attachment object
 * @returns {Promise<Object>} Verification result
 */
async function validateEmailAttachment(attachment) {
  const fileInfo = {
    name: attachment.filename || attachment.name || '',
    type: attachment.mimeType || attachment.contentType || '',
    size: attachment.size || 0
  };

  if (attachment.path) {
    fileInfo.path = attachment.path;
  }

  const checkResult = await checkFileSecurity(fileInfo);

  return {
    allowed: checkResult.isSafe,
    ...checkResult,
    message: getSecurityWarningMessage(checkResult)
  };
}

module.exports = {
  DANGEROUS_EXTENSIONS,
  DANGEROUS_MIME_TYPES,
  EXECUTABLE_MAGIC_NUMBERS,
  PATHEXT_EXECUTABLES,
  isDangerousExtension,
  isDangerousMimeType,
  isExecutableByPathExt,
  checkMagicNumber,
  checkMagicNumberFromFile,
  checkMagicNumberFromFileSync,
  checkPEFile,
  checkPEFileFromPath,
  checkPEFileFromPathSync,
  checkFileSecurity,
  checkFileSecuritySync,
  checkFileSecurityBatch,
  getSecurityWarningMessage,
  validateFileForTransfer,
  validateEmailAttachment,
  getWorkerManager,
  canUseWorker
};
