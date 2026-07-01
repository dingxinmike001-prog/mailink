/**
 * IMAP attachment download module
 * Responsible for downloading email attachments from the IMAP server
 * 
 * 💡 Optimization notes:
 * - Use email-parser-manager to parse emails in Worker thread (avoid main-thread CPU blocking)
 * - Use attachment-download-manager to write files in Worker thread (avoid IO blocking)
 * - Supports batch processing task queue, up to 100 concurrent
 * - Estimated performance improvement: 50-70% for large email parsing
 */

const Imap = require('imap');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const logger = require('../logger');
const pathUtils = require('../../shared/path/path-utils');
const { getInstance: getParserManager } = require('./email-parser-manager');
const { getInstance: getDownloadManager } = require('./attachment-download-manager');

/**
 * Convert stream to Buffer
 */
const streamToBuffer = (stream) => {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
};

/**
 * Download a single attachment
 * @param {Object} params - Parameter object
 * @returns {Promise}
 */
const downloadAttachments = async ({ username, emailUid, filename, imapConfig, onProgress }) => {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: imapConfig.username,
      password: imapConfig.password,
      host: imapConfig.host,
      port: imapConfig.port,
      tls: imapConfig.tls,
      tlsOptions: { rejectUnauthorized: false }
    });

    let isResolved = false;
    let attachmentFound = false;

    const safeResolve = (result) => {
      if (!isResolved) {
        isResolved = true;
        imap.end();
        resolve(result);
      }
    };

    const safeReject = (error) => {
      if (!isResolved) {
        isResolved = true;
        imap.end();
        reject(error);
      }
    };

    const reportProgress = (downloaded, total) => {
      if (onProgress && typeof onProgress === 'function') {
        const percentage = total > 0 ? Math.round((downloaded / total) * 100) : 0;
        try {
          onProgress(downloaded, total, percentage);
        } catch (e) {
          // Ignore send errors
        }
      }
    };

    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err, box) => {
        if (err) {
          return safeReject(new Error(`failed to open inbox: ${err.message}`));
        }

        const fetch = imap.fetch([emailUid], { bodies: '' });

        fetch.on('message', (msg, seqno) => {
          msg.on('body', async (stream, info) => {
            try {
              const startTime = Date.now();
              const mailSize = info.size || 0;
              logger.info(
                `[AttachmentDownload] started processing email UID=${emailUid}, size=${mailSize} bytes`
              );

              // 1. Convert stream to Buffer
              reportProgress(10, mailSize);
              const streamBuffer = await streamToBuffer(stream);
              reportProgress(30, mailSize);

              // 2. Use Worker thread to parse email (avoid CPU-intensive operations on main thread)
              logger.info(`[AttachmentDownload] sent to parseWorker UID=${emailUid}`);
              const parserManager = getParserManager();
              const parsed = await parserManager.parseEmail(streamBuffer, emailUid, {
                timeout: 10000,
                onlySignaling: false
              });

              reportProgress(60, mailSize);
              logger.info(
                `[AttachmentDownload] parse completed UID=${emailUid}, attachment count=${
                  parsed.attachments ? parsed.attachments.length : 0
                }`
              );

              if (parsed.attachments && parsed.attachments.length > 0) {
                for (const att of parsed.attachments) {
                  const attFilename = att.filename || '';
                  const searchFilename = filename || '';

                  // Try multiple matching methods
                  const exactMatch = attFilename === searchFilename;
                  let decodedMatch = false;
                  try {
                    decodedMatch = attFilename === decodeURIComponent(searchFilename);
                  } catch (e) {
                    decodedMatch = false;
                  }
                  const normalizedMatch =
                    attFilename.replace(/\s+/g, '') === searchFilename.replace(/\s+/g, '');
                  const containsMatch =
                    attFilename.includes(searchFilename) || searchFilename.includes(attFilename);

                  logger.info(
                    `[AttachmentDownload] checking attachments: "${attFilename}" vs "${searchFilename}" | ` +
                    `match=${exactMatch || decodedMatch || normalizedMatch || containsMatch}`
                  );

                  if (exactMatch || decodedMatch || normalizedMatch || containsMatch) {
                    attachmentFound = true;
                    const totalSize = att.size || 0;

                    // Prepare save path
                    const saveDir = pathUtils.getUserAttachmentDir(username);
                    const safeFilename = _sanitizeFilename(attFilename || filename);
                    const savePath = path.join(saveDir, safeFilename);

                    reportProgress(75, mailSize);

                    // 3. Use Worker thread to save file (avoid IO blocking on main thread)
                    logger.info(
                      `[AttachmentDownload] sent to downloadWorker: ${savePath}, size=${att.content?.length || 0}`
                    );
                    const downloadManager = getDownloadManager();
                    const saveResult = await downloadManager.saveAttachment(
                      savePath,
                      att.content,
                      { timeout: 10000 }
                    );

                    reportProgress(95, mailSize);

                    const duration = Date.now() - startTime;
                    logger.info(
                      `[AttachmentDownload] ✅ complete UID=${emailUid}, elapsed=${duration}ms, ` +
                      `path=${savePath}`
                    );

                    return safeResolve({
                      success: true,
                      savePath: savePath,
                      filename: safeFilename,
                      size: totalSize,
                      duration,
                      timestamp: new Date().toISOString()
                    });
                  }
                }

                if (!attachmentFound) {
                  return safeReject(new Error(`attachment not found: ${filename}`));
                }
              } else {
                return safeReject(new Error('this email has no attachments'));
              }
            } catch (parseErr) {
              logger.error(
                `[AttachmentDownload] ❌ processing failed UID=${emailUid}: ${parseErr.message}`
              );
              return safeReject(new Error(`failed to process email: ${parseErr.message}`));
            }
          });
        });

        fetch.once('error', (fetchErr) => {
          safeReject(new Error(`failed to fetch email: ${fetchErr.message}`));
        });

        fetch.once('end', () => {
          // Wait for body processing to complete
          setTimeout(() => {
            if (!isResolved) {
              if (!attachmentFound) {
                safeReject(new Error(`attachment not found: ${filename}`));
              }
            }
          }, 5000);
        });
      });
    });

    imap.once('error', (err) => {
      safeReject(new Error(`IMAP connection error: ${err.message}`));
    });

    // Set overall timeout - 10 minutes
    const timeout = setTimeout(() => {
      if (!isResolved) {
        safeReject(new Error('download timeout'));
      }
    }, 600000);

    imap.once('end', () => {
      clearTimeout(timeout);
    });

    imap.connect();
  });
};

function _sanitizeFilename(filename) {
  if (!filename) return 'attachment';

  let sanitized = filename.replace(/[<>:"/\\|?*]/g, '_');
  sanitized = sanitized.replace(/\s+/g, '_');
  sanitized = sanitized.substring(0, 200);

  return sanitized;
}

/**
 * Get Manager statistics (for performance monitoring)
 */
function getStats() {
  const parserStats = getParserManager().getStats();
  const downloadStats = getDownloadManager().getStats();
  
  return {
    parser: parserStats,
    download: downloadStats,
    timestamp: new Date().toISOString()
  };
}

/**
 * Graceful shutdown (should be called on app exit)
 */
async function shutdown() {
  logger.info('[AttachmentDownload] Shutting down managers...');
  await Promise.all([
    getParserManager().shutdown(),
    getDownloadManager().shutdown()
  ]);
}

module.exports = {
  downloadAttachments,
  getStats,
  shutdown
};
