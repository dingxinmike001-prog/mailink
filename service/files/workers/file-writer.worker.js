const fs = require('fs');
const path = require('path');
const { parentPort } = require('worker_threads');

// Import the logger module
const logger = require('../../logger');

// Import file security verification module
const { isDangerousExtension, checkMagicNumber } = require('../../security/file-security-node');

// Store active write handles and buffer: filePath -> { fd, buffer, bufferOffset, startPosition }
const activeContexts = new Map();

// Write buffer size: 1MB
const WRITE_BUFFER_SIZE = 1024 * 1024;

const FILE_WRITE_TRACE =
  process.env.MAILINK_FILE_WRITE_TRACE === '1' ||
  process.env.MAILINK_FILE_WRITE_TRACE === 'true' ||
  process.env.MAILINK_FILE_WRITE_TRACE === 'TRUE';

// Listen to messages from the main thread
parentPort.on('message', (message) => {
  const { type, id, filePath, content, position, append, flush } = message;

  if (type === 'write-file') {
    handleWriteFile(id, filePath, content, position, append, flush);
  } else if (type === 'close-file') {
    handleCloseFile(id, filePath);
  }
});

/**
 * Force buffer content to disk
 */
function flushBuffer(filePath, context, reason) {
  if (!context || context.bufferOffset === 0) return;

  try {
    const bytesToFlush = context.bufferOffset;
    const flushStartPosition = context.startPosition;
    logger.info(`[Worker] Flush buffer: ${filePath}, size: ${context.bufferOffset}, position: ${context.startPosition}`);
    fs.writeSync(context.fd, context.buffer, 0, context.bufferOffset, context.startPosition);
    context.bufferOffset = 0;

    if (FILE_WRITE_TRACE) {
      context.flushCount = (context.flushCount || 0) + 1;
      parentPort.postMessage({
        type: 'telemetry',
        event: 'flush',
        filePath,
        flushCount: context.flushCount,
        reason: reason || 'unknown',
        startPosition: flushStartPosition,
        bytes: bytesToFlush
      });
    }
  } catch (err) {
    logger.error(`[Worker] Flush error: ${filePath}, Pos: ${context.startPosition}`, err);
    throw err;
  }
}

/**
 * Handle file write request (changed to buffered synchronous sequential write)
 */
function handleWriteFile(id, filePath, content, position, append, flush) {
  try {
    // Security check: verify if file name is dangerous
    const fileName = path.basename(filePath);
    if (isDangerousExtension(fileName)) {
      logger.warn(`[Worker] Blocked dangerous file write: ${fileName}`);
      parentPort.postMessage({
        id,
        success: false,
        error: `SECURITY_VIOLATION: Writing executable files is prohibited ${fileName}`,
        securityViolation: true
      });
      return;
    }

    if (append === true) {
      const dirPath = path.dirname(filePath);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }

      const data = Buffer.isBuffer(content) ? content : Buffer.from(content);

      // Security check: if new file, check content magic number
      if (position === 0 && data.length >= 2) {
        const magicCheck = checkMagicNumber(data.slice(0, 8));
        if (magicCheck && magicCheck.isExecutable) {
          logger.warn(`[Worker] Blocked executable file content write: ${fileName}, type: ${magicCheck.type}`);
          parentPort.postMessage({
            id,
            success: false,
            error: `SECURITY_VIOLATION: Executable file content detected (${magicCheck.type})`,
            securityViolation: true
          });
          return;
        }
      }

      fs.appendFileSync(filePath, data);
      parentPort.postMessage({ id, success: true });
      return;
    }

    // 1. Get or create file context
    let context = activeContexts.get(filePath);

    if (context === undefined) {
      // Ensure directory exists
      const dirPath = path.dirname(filePath);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }

      // Decide open mode
      const fileExists = fs.existsSync(filePath);
      let flags = 'r+';
      if (!fileExists) {
        flags = 'w+';
      } else if (position === 0) {
        flags = 'w+';
      }

      // [FIX] Prevent new files from writing at high offsets causing holes
      // If new file and write position > 0, prefill front or reject write
      if (!fileExists && position > 0) {
        logger.warn(`[Worker] Risk of new file writing at high offset: ${filePath}, requested position=${position}`);
        // strategy：pre-fill prefix with0，ensure file structure is complete
        // allows resume from breakpoint，but creates a sparse file
        // better to ensure at application level storedFileName pass correctly
      }

      logger.info(`[Worker] Opening file: ${filePath}, mode: ${flags}, exists=${fileExists}, write position=${position}`);

      // File open with retry mechanism
      const maxRetries = 3;
      const retryDelay = 500; // milliseconds
      let fd = null;
      let openErr = null;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          fd = fs.openSync(filePath, flags);
          openErr = null;
          break; // Opened successfully, exit retry loop
        } catch (err) {
          openErr = err;
          const isBusyError = err.code === 'EBUSY' ||
                             (err.message && err.message.includes('EBUSY')) ||
                             (err.message && err.message.includes('resource busy'));

          if (isBusyError && attempt < maxRetries) {
            logger.warn(`[Worker] File in use, retry ${attempt}: ${filePath}, error: ${err.message}`);
            // Wait a while before retrying
            const start = Date.now();
            while (Date.now() - start < retryDelay) {
              // synchronously wait
            }
          } else {
            break; // Non-EBUSY error or max retries reached
          }
        }
      }

      if (openErr) {
        logger.error(`[Worker] Failed to open file: ${filePath}`, openErr);
        // Provide more user-friendly error message
        let errorMessage = `Open failed: ${openErr.message}`;
        if (openErr.code === 'EBUSY' || openErr.message.includes('EBUSY')) {
          errorMessage = `File in use, please close other programs using this file and retry: ${path.basename(filePath)}`;
        }
        parentPort.postMessage({ id, success: false, error: errorMessage });
        return;
      }

      context = {
        fd: fd,
        buffer: Buffer.allocUnsafe(WRITE_BUFFER_SIZE),
        bufferOffset: 0,
        startPosition: position,
        flushCount: 0
      };
      activeContexts.set(filePath, context);
    }

    // 2. Convert content to Buffer
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);

    // 3. Check if write position is contiguous and buffer is full
    const isContiguous = position === context.startPosition + context.bufferOffset;
    const willOverflow = context.bufferOffset + data.length > WRITE_BUFFER_SIZE;

    if (!isContiguous || willOverflow) {
      // If not contiguous, or new data exceeds buffer size, flush existing data first
      const reason = !isContiguous ? 'non-contiguous' : 'buffer-overflow';
      flushBuffer(filePath, context, reason);
      context.startPosition = position;
    }

    // 4. Execute write or buffer
    if (data.length >= WRITE_BUFFER_SIZE) {
      // Data too large, write directly to disk
      fs.writeSync(context.fd, data, 0, data.length, position);
      context.startPosition = position + data.length;
      if (FILE_WRITE_TRACE) {
        parentPort.postMessage({
          type: 'telemetry',
          event: 'direct-write',
          filePath,
          flushCount: context.flushCount || 0,
          position,
          bytes: data.length
        });
      }
    } else {
      // Store in buffer
      data.copy(context.buffer, context.bufferOffset);
      context.bufferOffset += data.length;
      
      // If buffer is exactly full, flush immediately
      if (context.bufferOffset === WRITE_BUFFER_SIZE) {
        flushBuffer(filePath, context, 'buffer-full');
        context.startPosition = position + data.length;
      } else if (flush === true) {
        // [NEW] If flush is explicitly requested
        flushBuffer(filePath, context, 'explicit-flush');
        context.startPosition = position + data.length;
      }
    }

    parentPort.postMessage({ id, success: true });

  } catch (err) {
    logger.error(`[Worker] Severe exception processing write request: ${filePath}`, err);
    parentPort.postMessage({ id, success: false, error: err.message });
  }
}

/**
 * Handle close file request
 * Use synchronous close to avoid file descriptor race issues caused by async close
 */
function handleCloseFile(id, filePath) {
  try {
    const context = activeContexts.get(filePath);
    if (context !== undefined) {
      // 1. Flush buffer before closing
      try {
        flushBuffer(filePath, context, 'close');
      } catch (flushErr) {
        logger.error(`[Worker] Flush before close failed: ${filePath}`, flushErr);
      }

      logger.info(`[Worker] Closing file handle: ${filePath}`);
      
      // Use synchronous close to avoid file descriptor race issues caused by async close
      // In Worker thread, synchronous operations do not block the main thread
      try {
        fs.closeSync(context.fd);
        activeContexts.delete(filePath);
        parentPort.postMessage({ id, success: true });
      } catch (closeErr) {
        logger.error(`[Worker] Failed to close file handle: ${filePath}`, closeErr);
        // Even if close fails, context should be cleaned up
        activeContexts.delete(filePath);
        parentPort.postMessage({ id, success: false, error: closeErr.message });
      }
    } else {
      parentPort.postMessage({ id, success: true });
    }
  } catch (err) {
    logger.error(`[Worker] Exception closing file: ${filePath}`, err);
    parentPort.postMessage({ id, success: false, error: err.message });
  }
}
