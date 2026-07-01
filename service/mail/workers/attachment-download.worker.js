/**
 * Attachment download Worker (optimized)
 * Handles attachment disk writes in independent threads
 * 
 * Optimization features:
 * - Batch attachment processing support
 * - Lightweight security check (avoids PE check overhead)
 * - Async validation mode support
 * - Statistics collection
 */

const fs = require('fs');
const path = require('path');
const { parentPort } = require('worker_threads');
const { isDangerousExtension, checkMagicNumber } = require('../../security/file-security-node');

// Import the logger module
const logger = require('../../logger');

// Statistics
const stats = {
  saved: 0,
  failed: 0,
  blocked: 0,
  totalBytes: 0,
  totalTime: 0,
  avgTime: 0
};

// Listen to main thread messages
parentPort.on('message', async (message) => {
  const { id, type, filePath, content, options = {} } = message;

  try {
    if (type === 'save-attachment') {
      await handleSaveAttachment(id, filePath, content, options);
    } else if (type === 'save-batch-attachments') {
      await handleSaveBatchAttachments(id, message.attachments, options);
    } else if (type === 'ping') {
      parentPort.postMessage({ id, type: 'pong' });
    } else if (type === 'get-stats') {
      parentPort.postMessage({ id, type: 'stats', data: stats });
    }
  } catch (error) {
    sendError(id, error.message);
  }
});

/**
 * Fast security check (lightweight)
 * @param {string} fileName - File name
 * @param {Buffer} contentBuffer - File content
 * @param {Object} options - { skipPECheck, skipMagicCheck }
 * @returns {Object|null} Check result or null
 */
function quickSecurityCheck(fileName, contentBuffer, options = {}) {
  const { skipPECheck = true, skipMagicCheck = false } = options;

  // 1. Check file extension (fast)
  if (isDangerousExtension(fileName)) {
    return {
      blocked: true,
      reason: `SECURITY_VIOLATION: Dangerous file type - .${path.extname(fileName)}`
    };
  }

  // 2. Check file magic number (only when needed)
  if (!skipMagicCheck && contentBuffer && contentBuffer.length >= 8) {
    const magicCheck = checkMagicNumber(contentBuffer.slice(0, 8));
    if (magicCheck && magicCheck.isExecutable) {
      return {
        blocked: true,
        reason: `SECURITY_VIOLATION: Executable file magic number detected (${magicCheck.type})`
      };
    }
  }

  return null;
}

/**
 * Handle single attachment save
 */
async function handleSaveAttachment(id, filePath, content, options) {
  const startTime = Date.now();
  const { onlyValidate = false, maxFileSize = 100 * 1024 * 1024, asyncValidation = false } = options;

  try {
    const fileName = path.basename(filePath);
    const contentSize = Buffer.byteLength(content);
    const contentBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content);

    // 1. Fast security check
    const securityCheck = quickSecurityCheck(fileName, contentBuffer, {
      skipMagicCheck: asyncValidation // Skip magic number check in async mode
    });

    if (securityCheck && securityCheck.blocked) {
      stats.blocked++;
      throw new Error(securityCheck.reason);
    }

    // 2. Check file size
    if (contentSize > maxFileSize) {
      throw new Error(`File too large: ${contentSize} > ${maxFileSize}`);
    }

    // 3. Verification-only mode
    if (onlyValidate) {
      sendSuccess(id, {
        validated: true,
        size: contentSize,
        duration: Date.now() - startTime
      });
      return;
    }

    // 4. Create directory
    const dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    // 5. Write file
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    fs.writeFileSync(filePath, buffer);

    // 6. Verify file was actually written
    if (!fs.existsSync(filePath)) {
      throw new Error(`File write verification failed: ${filePath}`);
    }

    const fileStats = fs.statSync(filePath);
    if (fileStats.size !== contentSize) {
      throw new Error(
        `File size mismatch: written ${fileStats.size} != expected ${contentSize}`
      );
    }

    const duration = Date.now() - startTime;
    stats.saved++;
    stats.totalBytes += contentSize;
    stats.totalTime += duration;
    stats.avgTime = stats.totalTime / (stats.saved + stats.failed);

    sendSuccess(id, {
      success: true,
      savePath: filePath,
      filename: fileName,
      size: contentSize,
      duration,
      timestamp: new Date().toISOString()
    });

    sendLog('info', `✅ Attachment saved: ${fileName} (${contentSize} bytes, ${duration}ms)`);
  } catch (error) {
    stats.failed++;
    sendError(id, error.message);
    sendLog('error', `❌ Attachment save failed: ${error.message}`);
  }
}

/**
 * Batch process attachment saves
 * Supports batch verification and save
 */
async function handleSaveBatchAttachments(id, attachments, options) {
  const startTime = Date.now();
  const results = [];
  let successCount = 0;
  let failCount = 0;

  try {
    if (!Array.isArray(attachments) || attachments.length === 0) {
      throw new Error('Invalid batch: empty attachments');
    }

    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const { filePath, content } = att;

      try {
        const fileName = path.basename(filePath);
        const contentSize = Buffer.byteLength(content);
        const contentBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content);

        // Fast security check
        const securityCheck = quickSecurityCheck(fileName, contentBuffer, options);
        if (securityCheck && securityCheck.blocked) {
          results.push({
            index: i,
            filePath,
            success: false,
            error: securityCheck.reason,
            size: contentSize
          });
          failCount++;
          stats.blocked++;
          continue;
        }

        // Create directory
        const dirPath = path.dirname(filePath);
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
        }

        // Write file
        const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
        fs.writeFileSync(filePath, buffer);

        results.push({
          index: i,
          filePath,
          success: true,
          size: contentSize,
          filename: fileName
        });
        successCount++;
        stats.saved++;
        stats.totalBytes += contentSize;
      } catch (error) {
        results.push({
          index: i,
          filePath,
          success: false,
          error: error.message,
          size: Buffer.byteLength(attachments[i].content)
        });
        failCount++;
        stats.failed++;
      }

      // Progress report
      if ((i + 1) % 5 === 0 || i === attachments.length - 1) {
        parentPort.postMessage({
          id,
          type: 'batch-progress',
          processed: i + 1,
          total: attachments.length,
          successCount,
          failCount
        });
      }
    }

    const duration = Date.now() - startTime;
    stats.totalTime += duration;
    stats.avgTime = stats.totalTime / (stats.saved + stats.failed);

    sendSuccess(id, {
      results,
      summary: {
        total: attachments.length,
        succeeded: successCount,
        failed: failCount,
        blocked: results.filter(r => r.error && r.error.includes('SECURITY')).length,
        duration,
        avgTimePerFile: duration / attachments.length,
        totalBytes: results.reduce((sum, r) => sum + (r.size || 0), 0)
      }
    });
  } catch (error) {
    sendError(id, error.message);
  }
}

/**
 * Send success response
 */
function sendSuccess(id, data) {
  parentPort.postMessage({
    id,
    type: 'save-attachment-result',
    success: true,
    data
  });
}

/**
 * Send error response
 */
function sendError(id, errorMessage) {
  parentPort.postMessage({
    id,
    type: 'save-attachment-result',
    success: false,
    error: errorMessage
  });
}

/**
 * Send log
 */
function sendLog(level, message) {
  parentPort.postMessage({
    type: 'log',
    level,
    message: `[AttachmentDownload] ${message}`
  });
}
