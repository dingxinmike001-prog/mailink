/**

 * IMAP streaming attachment download module (optimized)

 * 1. First fetch BODYSTRUCTURE to find the target attachment MIME part number

 * 2. Download only that part (BODY.PEEK[N]) to avoid irrelevant content

 * 3. Stream-decode (Base64/QP) directly to disk without mailparser buffering

 */



const Imap = require('imap');

const fs = require('fs');

const fsPromises = fs.promises;

const path = require('path');

const { Transform, PassThrough } = require('stream');

const logger = require('../logger');

const pathUtils = require('../../shared/path/path-utils');

const fileWriterManager = require('../files/workers/file-writer-manager');

const { createDecoderStream } = require('./streaming-decoder');

const connectionManager = require('./imap-connection-manager');

const iconv = require('iconv-lite');

const libmime = require('libmime');





// ─────────────────────────────────────────────

// Base64/QP streaming decoding has been moved to streaming-decoder.js

// Now processed using Worker thread to avoid blocking main thread

// ─────────────────────────────────────────────



// ─────────────────────────────────────────────

// BODYSTRUCTURE parsing: recursively find target attachment part

// ─────────────────────────────────────────────

function _extractPartFilename(part) {

  if (!part) return '';

  return part.disposition?.params?.filename ||

         part.params?.name ||

         part.params?.filename ||

         part.disposition?.parameters?.filename ||

         (part.partID ? `attachment_${part.partID}` : '') ||

         '';

}



function _decodeMimeFilename(name) {

  if (!name) return '';

  try {

    return libmime.decodeWords(name);

  } catch (e) { /* ignore */ }

  return name;

}



function _nameMatch(a, b) {

  if (!a || !b) return false;

  const n = s => s.trim().replace(/\s+/g, ' ').toLowerCase();

  const na = n(a), nb = n(b);

  return na === nb || na.includes(nb) || nb.includes(na);

}



function findAttachmentPart(struct, targetFilename) {

  if (!struct) return null;

  

  const searchInNode = (node) => {

    if (!node) return null;

    

    if (Array.isArray(node)) {

      for (const item of node) {

        const found = searchInNode(item);

        if (found) return found;

      }

      return null;

    }

    

    if (typeof node === 'object' && node.partID) {

      const rawName = _extractPartFilename(node);

      const decodedName = _decodeMimeFilename(rawName);

      if (_nameMatch(rawName, targetFilename) || _nameMatch(decodedName, targetFilename)) {

        let charset = null;

        if (node.params) {

          const charsetKey = Object.keys(node.params).find(k => k.toLowerCase() === 'charset');

          if (charsetKey) {

            charset = node.params[charsetKey];

            if (typeof charset === 'string') {

              charset = charset.replace(/["']/g, '').trim();

            }

          }

        }

        let subType = node.subtype || '';

        let type = node.type || '';



        return {

          partNum: node.partID,

          encoding: (node.encoding || 'BASE64').toUpperCase(),

          size: node.size || 0,

          filename: decodedName || rawName || targetFilename,

          charset: charset,

          contentType: type ? `${type}/${subType}`.toLowerCase() : ''

        };

      }

    }

    

    if (node.parts && Array.isArray(node.parts)) {

      return searchInNode(node.parts);

    }

    

    return null;

  };

  

  return searchInNode(struct);

}



// ─────────────────────────────────────────────

// Main function

// ─────────────────────────────────────────────

const downloadAttachmentStreaming = async ({ username, emailUid, filename, imapConfig, onProgress }) => {

  return new Promise(async (resolve, reject) => {

    // Get connection using dedicated fetchBody connection pool

    const { imap } = await connectionManager.getFetchBodyConnection(imapConfig);



    let isResolved = false;

    let activeFilePath = null;



    const timeout = setTimeout(() => {

      if (!isResolved) safeReject(new Error('download timeout'));

    }, 600000);



    const safeResolve = (result) => {

      if (!isResolved) {

        isResolved = true;

        clearTimeout(timeout);

        resolve(result);

      }

    };



    const safeReject = (error) => {

      if (!isResolved) {

        isResolved = true;

        clearTimeout(timeout);

        if (activeFilePath) fileWriterManager.closeFile(activeFilePath).catch(() => {});

        reject(error);

      }

    };



    // Helper function: analyze IMAP error type and return user-friendly error message

    const analyzeIMAPError = (err) => {

      const errorMessage = err.message || err.text || String(err);

      const lowerError = errorMessage.toLowerCase();

      

      // Error pattern for email deleted or UID does not exist

      if (lowerError.includes('uid') && (lowerError.includes('not found') || lowerError.includes('does not exist') || lowerError.includes('no such'))) {

        return {

          type: 'EMAIL_NOT_FOUND',

          message: 'this email has been deleted or moved on the server, cannot download attachment',

          originalError: errorMessage

        };

      }

      

      // Email has been deleted

      if (lowerError.includes('deleted') || lowerError.includes('deleted') || lowerError.includes('expunge')) {

        return {

          type: 'EMAIL_DELETED',

          message: 'this email has been deleted on the server, cannot download attachment',

          originalError: errorMessage

        };

      }

      

      // Permission error

      if (lowerError.includes('permission') || lowerError.includes('auth') || lowerError.includes('login') || lowerError.includes('credential')) {

        return {

          type: 'AUTH_ERROR',

          message: 'mailbox authentication failed, please check account settings',

          originalError: errorMessage

        };

      }

      

      // Connection error

      if (lowerError.includes('connect') || lowerError.includes('network') || lowerError.includes('timeout') || lowerError.includes('econnrefused')) {

        return {

          type: 'CONNECTION_ERROR',

          message: 'failed to connect to mail server, please check network',

          originalError: errorMessage

        };

      }

      

      // Mailbox does not exist

      if (lowerError.includes('mailbox') && (lowerError.includes('not found') || lowerError.includes('does not exist'))) {

        return {

          type: 'MAILBOX_NOT_FOUND',

          message: 'mailbox folder does not exist',

          originalError: errorMessage

        };

      }



      // File is busy (EBUSY)

      if (lowerError.includes('ebusy') || lowerError.includes('resource busy') || lowerError.includes('lock') || lowerError.includes('occupied')) {

        return {

          type: 'FILE_BUSY',

          message: 'file is occupied, please close other programs using this file and retry',

          originalError: errorMessage

        };

      }



      // Insufficient disk space

      if (lowerError.includes('enospc') || lowerError.includes('no space') || lowerError.includes('disk full') || lowerError.includes('insufficient space')) {

        return {

          type: 'DISK_FULL',

          message: 'insufficient disk space, please clean disk and retry',

          originalError: errorMessage

        };

      }



      // Insufficient permissions (filesystem)

      if (lowerError.includes('eacces') || lowerError.includes('permission denied') || lowerError.includes('access denied')) {

        return {

          type: 'PERMISSION_DENIED',

          message: 'no permission to save file, please check folder permissions',

          originalError: errorMessage

        };

      }



      // Default error

      return {

        type: 'UNKNOWN_ERROR',

        message: errorMessage,

        originalError: errorMessage

      };

    };



    const reportProgress = (downloaded, total) => {

      if (typeof onProgress !== 'function') return;

      const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0;

      try { onProgress(downloaded, total, pct); } catch (e) {}

    };



    logger.info(`[AttachmentDownload] Using fetchBody connection, opening INBOX`);

    

    // ── Phase 1: Fetch BODYSTRUCTURE ──────────────────────

    logger.info(`[AttachmentDownload] Phase 1: fetching BODYSTRUCTURE, UID=${emailUid}`);

    const structFetch = imap.fetch([emailUid], { struct: true });



    let partInfo = null;



    structFetch.on('message', (msg) => {

      msg.once('attributes', (attrs) => {

        partInfo = findAttachmentPart(attrs.struct, filename);

        if (partInfo) {

          logger.info(`[AttachmentDownload] Found part: num=${partInfo.partNum}, enc=${partInfo.encoding}, size=${partInfo.size}`);

        } else {

          logger.warn(`[AttachmentDownload] Part not found in BODYSTRUCTURE for: ${filename}`);

        }

      });

      msg.on('body', (stream) => stream.resume()); // consume if any

    });



    structFetch.once('error', (err) => {

      const errorInfo = analyzeIMAPError(err);

      // If email does not exist error, give more specific prompt

      if (errorInfo.type === 'EMAIL_NOT_FOUND' || errorInfo.type === 'EMAIL_DELETED') {

        safeReject(new Error(errorInfo.message));

      } else {

        safeReject(new Error(`failed to get email structure: ${errorInfo.message}`));

      }

    });



    structFetch.once('end', async () => {

      if (isResolved) return;



      if (!partInfo) {

        return safeReject(new Error(`inBODYSTRUCTUREattachment not found in: ${filename}`));

      }



      // ── Phase 2: Download only target part ─────────────────────────

      await _fetchAndDecodePart({

        imap, emailUid, partInfo, filename, username,

        reportProgress, safeResolve, safeReject,

        setActiveFilePath: (fp) => { activeFilePath = fp; }

      });

    });

  });

};



// ─────────────────────────────────────────────

// Phase 2: Download and decode specified part

// ─────────────────────────────────────────────

async function _fetchAndDecodePart({ imap, emailUid, partInfo, filename, username, reportProgress, safeResolve, safeReject, setActiveFilePath }) {

  const { partNum, encoding, size, charset, contentType } = partInfo;



  const saveDir = pathUtils.getUserAttachmentDir(username);

  try {

    await fsPromises.mkdir(saveDir, { recursive: true });

  } catch (err) {

    if (err.code !== 'EEXIST') {

      return safeReject(new Error(`failed to create save directory: ${err.message}`));

    }

  }

  const safeFilename = _sanitizeFilename(filename);

  const savePath = path.join(saveDir, safeFilename);

  setActiveFilePath(savePath);



  logger.info(`[AttachmentDownload] Phase 2: BODY.PEEK[${partNum}], encoding=${encoding}, target=${savePath}`);



  // node-imap wraps the bodies value inside BODY.PEEK[...] when sending

  // Only pass the part number, without BODY.PEEK prefix (otherwise becomes BODY.PEEK[BODY.PEEK[N]])

  const bodyFetch = imap.fetch([emailUid], {

    bodies: String(partNum),

    markSeen: false

  });



  bodyFetch.on('message', (msg) => {

    msg.on('body', (stream, info) => {

      // Total network bytes (after encoding, base64 is about 1.34x file size)

      const networkTotal = info.size || Math.ceil(size * 1.34) || 0;

      let networkReceived = 0;



      // Choose decoder (using Worker-based decoder)

      let decoder;

      if (encoding === 'BASE64' || encoding === 'B') {

        decoder = createDecoderStream('BASE64');

      } else if (encoding === 'QUOTED-PRINTABLE' || encoding === 'QP') {

        decoder = createDecoderStream('QP');

      } else {

        decoder = new PassThrough(); // 7BIT / 8BIT / BINARY

      }



      // Track network progress

      stream.on('data', (rawChunk) => {

        networkReceived += rawChunk.length;

        if (networkTotal > 0) reportProgress(networkReceived, networkTotal);

      });



      // Synchronously initialize file to ensure even empty files are created

      // Prevent stream data loss caused by entering then() async operations

      fileWriterManager.writeFile(savePath, Buffer.alloc(0), 0, false)

        .catch((e) => logger.warn(`[AttachmentDownload] failed to initialize empty file: ${e.message}`));



      logger.info(`[AttachmentDownload] File initialized, piping decode stream synchronously`);



      let writePosition = 0;

      let pendingWrites = 0;

      let streamEnded = false;

      let closeInProgress = false;



      const tryClose = async () => {

        // Prevent concurrent close calls

        if (closeInProgress) return;



        if (streamEnded && pendingWrites === 0) {

          closeInProgress = true;

          try {

            await fileWriterManager.closeFile(savePath);



            // 🆕 For text files, perform charset conversion

            if (isTextFile && charset && decodedChunks.length > 0) {

              try {

                logger.info(`[AttachmentDownload] text file charset conversion: ${filename}, charset=${charset}`);

                const originalBuffer = Buffer.concat(decodedChunks);



                // Use iconv-lite for charset conversion

                let convertedContent;

                try {

                  // Try decoding with the specified charset

                  convertedContent = iconv.decode(originalBuffer, charset);

                } catch (convErr) {

                  logger.warn(`[AttachmentDownload] charset conversion failed, try using UTF-8: ${convErr.message}`);

                  // If that fails, try UTF-8

                  convertedContent = originalBuffer.toString('utf-8');

                }



                // Write converted content back to file (using UTF-8)

                let utf8Buffer = Buffer.from(convertedContent, 'utf-8');

                // Add UTF-8 BOM to avoid garbled text when opening with Notepad or Excel on Windows

                if (utf8Buffer.length >= 3 && utf8Buffer[0] === 0xEF && utf8Buffer[1] === 0xBB && utf8Buffer[2] === 0xBF) {

                  // already have BOM，no need to add repeatedly

                } else {

                  const bom = Buffer.from([0xEF, 0xBB, 0xBF]);

                  utf8Buffer = Buffer.concat([bom, utf8Buffer]);

                }

                await fsPromises.writeFile(savePath, utf8Buffer);

                logger.info(`[AttachmentDownload] charset conversion completed(containsBOM): ${filename}, original size=${originalBuffer.length}, converted size=${utf8Buffer.length}`);

              } catch (charsetErr) {

                logger.error(`[AttachmentDownload] charset conversion failed: ${charsetErr.message}`);

                // conversion failure does not block process，kept original file

              }

            }



            // 🛡️ Added: secondary on-disk verification (async version)

            try {

              await fsPromises.access(savePath);

              const stats = await fsPromises.stat(savePath);



              // 🛡️ Added: compare with declared attachment size in email

              const declaredSize = partInfo.size || 0;

              if (declaredSize > 0) {

                // Tolerance adjusted to ±25% because declared size from mail server can be inaccurate

                const expectedMinSize = Math.floor(declaredSize * 0.75);

                const expectedMaxSize = Math.ceil(declaredSize * 1.25);

                const actualSize = stats.size;



                if (actualSize < expectedMinSize || actualSize > expectedMaxSize) {

                  logger.error(

                    `[AttachmentDownload] attachment size verification warning: email declared size=${declaredSize} bytes, ` +

                    `actual download size=${actualSize} bytes, expected range=[${expectedMinSize}, ${expectedMaxSize}] bytes, ` +

                    `deviation=${(Math.abs(actualSize - declaredSize) / declaredSize * 100).toFixed(2)}%`

                  );

                  // [Improvement] Do not delete the file! Keep it for user inspection, only log a warning

                  logger.warn(`[AttachmentDownload] file kept for inspection: ${savePath}`);

                } else {

                  logger.info(

                    `[AttachmentDownload] attachment size verification passed: declare=${declaredSize} bytes, ` +

                    `actual=${actualSize} bytes, deviation=${Math.abs(actualSize - declaredSize)} bytes ` +

                    `(${(Math.abs(actualSize - declaredSize) / declaredSize * 100).toFixed(2)}%)`

                  );

                }

              } else {

                logger.warn(`[AttachmentDownload] email did not declare attachment size, skipped size verification`);

              }



              logger.info(`[AttachmentDownload] download and verification succeeded: ${savePath} (${stats.size} bytes)`);

              safeResolve({ success: true, savePath, filename: safeFilename, size: stats.size });

            } catch (verifyErr) {

              if (verifyErr.code === 'ENOENT') {

                return safeReject(new Error(`file verification failed: file could not be created on disk`));

              }

              safeReject(new Error(`failed to verify file status: ${verifyErr.message}`));

            }

          } catch (e) {

            safeReject(new Error(`failed to close file: ${e.message}`));

          } finally {

            closeInProgress = false;

          }

        }

      };



      // Collect all decoded data (used for charset conversion of text files)

      const decodedChunks = [];

      const isTextFile = contentType && contentType.startsWith('text/');



      // Receive decoded chunks and write to disk

      decoder.on('data', (decoded) => {

        const chunkSize = decoded.length;

        const pos = writePosition;

        writePosition += chunkSize;

        pendingWrites++;



        // If it is a text file with charset info, collect data for later conversion

        if (isTextFile && charset) {

          decodedChunks.push(Buffer.from(decoded));

        }



        fileWriterManager.writeFile(savePath, Buffer.from(decoded), pos, false)

          .then(() => {

            pendingWrites--;

            tryClose();

          })

          .catch((e) => {

            pendingWrites--;

            logger.error(`[AttachmentDownload] Write error: ${e.message}`);

            decoder.destroy();

            safeReject(new Error(`failed to write file: ${e.message}`));

          });

      });



      decoder.on('end', () => {

        logger.info(`[AttachmentDownload] Decoder ended, pendingWrites=${pendingWrites}`);

        streamEnded = true;

        tryClose();

      });



      decoder.on('error', (e) => {

        logger.error(`[AttachmentDownload] Decoder error: ${e.message}`);

        safeReject(new Error(`decode failed: ${e.message}`));

      });



      stream.pipe(decoder);

    });

  });



  bodyFetch.once('error', (err) => {

    const errorInfo = analyzeIMAPError(err);

    // If email does not exist error, give more specific prompt

    if (errorInfo.type === 'EMAIL_NOT_FOUND' || errorInfo.type === 'EMAIL_DELETED') {

      safeReject(new Error(errorInfo.message));

    } else {

      safeReject(new Error(`failed to get email content: ${errorInfo.message}`));

    }

  });



  bodyFetch.once('end', () => {

    logger.info(`[AttachmentDownload] Body fetch ended`);

  });

}



// ─────────────────────────────────────────────

// Utility functions

// ─────────────────────────────────────────────

function _sanitizeFilename(filename) {

  if (!filename) return 'attachment';

  return filename

    .replace(/[<>:"/\\|?*]/g, '_')

    .replace(/\s+/g, '_')

    .substring(0, 200);

}



module.exports = { downloadAttachmentStreaming };

