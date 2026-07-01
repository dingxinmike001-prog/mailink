// Dependencies
const { simpleParser } = require('mailparser');
const { Readable } = require('stream');
const { parentPort } = require('worker_threads');
const { isDangerousExtension, isDangerousMimeType } = require('../../security/file-security-node');
const iconv = require('iconv-lite');

/**
 * Email parsing Worker
 * Responsible for email stream parsing, runs in independent threads
 */

/**
 * Send log message to main thread
 * @param {string} level - Log level (info, warn, error)
 * @param {string} message - Log message
 */
function sendLog(level, message) {
  parentPort.postMessage({
    type: 'log',
    level,
    message: `[EmailParser] ${message}`
  });
}

/**
 * Detect whether byte sequence is non-UTF-8 GBK/GB2312 Chinese encoding
 * Strategy: first try UTF-8 decoding; if no garbled text, it is valid UTF-8, no processing needed;
 * if \uFFFD replacement characters exist, then check whether bytes match GBK double-byte sequence pattern.
 * @param {Buffer} bytes - Bytes to detect
 * @returns {boolean}
 */
function looksLikeNonUtf8Gbk(bytes) {
  if (!bytes || bytes.length === 0) return false;

  // Step 1: if valid UTF-8 (including Chinese or pure ASCII), no processing needed
  const asUtf8 = bytes.toString('utf8');
  if (!asUtf8.includes('\uFFFD')) return false;

  // Step 2: check GBK double-byte sequence: first byte 0x81-0xFE, second byte 0x40-0x7E or 0x80-0xFE
  let validPairs = 0;
  let highBytes = 0;
  const limit = Math.min(bytes.length, 4096);
  for (let i = 0; i < limit; i++) {
    const b = bytes[i];
    if (b > 0x7F) {
      highBytes++;
      if (b >= 0x81 && b <= 0xFE && i + 1 < limit) {
        const b2 = bytes[i + 1];
        if ((b2 >= 0x40 && b2 <= 0x7E) || (b2 >= 0x80 && b2 <= 0xFE)) {
          validPairs++;
          i++; // Consume trailing byte
        }
      }
    }
  }
  // If more than 70% of high bytes can form valid GBK pairs, identify as GBK
  return highBytes > 1 && validPairs >= Math.ceil(highBytes / 2 * 0.7);
}

/**
 * Before passing to simpleParser, inject charset for each text/* MIME part missing charset declaration.
 *
 * Why pre-inject instead of fixing afterwards:
 *   - simpleParser handles each part's transfer-encoding (base64/QP, etc.);
 *   - As long as each part has the correct charset, simpleParser can fully and correctly decode all content;
 *   - Re-decoding the entire rawBuffer afterwards would bring in MIME boundaries, base64 strings, etc.
 *
 * Detection logic:
 *   1. Find all text/* Content-Type headers without charset
 *   2. Probe body bytes of that part (decode first if base64) for UTF-8 / GBK
 *   3. If non-UTF-8 GBK bytes, inject '; charset=gbk' into Content-Type header
 *
 * @param {Buffer} rawBuffer - Raw email bytes
 * @returns {Buffer} - Bytes after charset injection (return original buffer if no modification needed)
 */
function preInjectMissingCharsets(rawBuffer) {
  const buf = Buffer.isBuffer(rawBuffer) ? rawBuffer : Buffer.from(rawBuffer);
  // Use latin1 to losslessly convert binary bytes to string (all byte values are within 0-255)
  const emailStr = buf.toString('latin1');

  // Find all text/* Content-Type headers (support multiline folded format)
  // Capture groups: (1) type part (2) parameter part (may be multiline) (3) ending \\r\\n
  const ctRegex = /(Content-Type:\s*text\/[a-zA-Z0-9\-]+)((?:[ \t]*;[^\r\n]*(?:\r\n[ \t][^\r\n]*)*)?)(\.?\r\n)/gi;

  const patches = []; // Collect positions to replace
  let m;

  while ((m = ctRegex.exec(emailStr)) !== null) {
    const fullMatch = m[0];
    const typePart = m[1];     // e.g. "Content-Type: text/plain"
    const paramsPart = m[2];   // e.g. "; boundary=..." or ""
    const lineEnd = m[3];      // Usually "\\r\\n"
    const matchIdx = m.index;

    // Already has charset, skip
    if (/charset/i.test(paramsPart)) continue;

    // Find header/body separator blank line of this part (\\r\\n\\r\\n)
    const blankIdx = emailStr.indexOf('\r\n\r\n', matchIdx);
    if (blankIdx === -1) continue;

    // Find Content-Transfer-Encoding of this part
    const partHeaderStr = emailStr.slice(matchIdx, blankIdx);
    const cteM = partHeaderStr.match(/Content-Transfer-Encoding:\s*(\S+)/i);
    const cte = (cteM ? cteM[1] : '').toLowerCase().trim();

    // Take first 4KB of body for detection
    const bodySample = emailStr.slice(blankIdx + 4, blankIdx + 4 + 4096);

    let bytesToCheck;
    if (cte === 'base64') {
      // Decode first if base64, then probe; ignore MIME boundary lines (starting with --)
      const b64 = bodySample.split(/\r?\n/).filter(l => l && !l.startsWith('-')).join('');
      try { bytesToCheck = Buffer.from(b64, 'base64'); } catch (e) { continue; }
    } else {
      // 8bit / 7bit / binary: use latin1 bytes directly
      bytesToCheck = Buffer.from(bodySample, 'latin1');
    }

    if (!looksLikeNonUtf8Gbk(bytesToCheck)) continue;

    // Inject charset=gbk (GBK is a superset of GB2312, better compatibility)
    const injected = `${typePart}${paramsPart}; charset=gbk${lineEnd}`;
    patches.push({ start: matchIdx, end: matchIdx + fullMatch.length, replacement: injected });
    sendLog('info', `preInjectMissingCharsets: injected charset=gbk for ${typePart} (cte=${cte || '8bit'})`);
  }

  if (patches.length === 0) return buf;

  // Apply replacements from back to front so earlier offsets are not affected
  let result = emailStr;
  for (let i = patches.length - 1; i >= 0; i--) {
    const { start, end, replacement } = patches[i];
    result = result.slice(0, start) + replacement + result.slice(end);
  }
  return Buffer.from(result, 'latin1');
}

/**
 * Auto-fix garbled text caused by bounce or email header encoding errors where UTF-8 was parsed as GBK/Latin1
 * @param {string} text - Text to fix
 * @returns {string} - Fixed text
 */
function fixMojibake(text) {
  if (!text || typeof text !== 'string') return text;

  const gbkMojibakePattern = /[鍐婵鐤涓鏍鍙缂鐩鑱闅闆閿鍗淇鏉鍓缁鏋鑸鑺銉鍟鍠鐣鐥鐦鐧鐨鐪鐫鐬鐭鐮鐯鐰鐱鐲鐳鐴鐵鐶鐷鐸鐹鐺鐻鐼鐽鐾鐿杩浠璇氱浜備熸]/;
  const latin1MojibakePattern = /[åæäèéç]/;

  let recovered = text;

  try {
    const iconv = require('iconv-lite');
    // Check GBK forced-decoding garbled text
    if (gbkMojibakePattern.test(recovered)) {
      const rawBytes = iconv.encode(recovered, 'gbk');
      const testStr = iconv.decode(rawBytes, 'utf8');
      if (testStr && !testStr.includes('\uFFFD') && /[\u4e00-\u9fa5]/.test(testStr)) {
         return testStr;
      }
    }

    // Check Latin1 forced-decoding garbled text
    if (latin1MojibakePattern.test(recovered)) {
      const rawBytesIso = iconv.encode(recovered, 'binary');
      const testStrIso = iconv.decode(rawBytesIso, 'utf8');
      if (testStrIso && !testStrIso.includes('\uFFFD') && /[\u4e00-\u9fa5]/.test(testStrIso)) {
         return testStrIso;
      }
    }
  } catch (e) {
    // ignore
  }

  return recovered;
}



// Listen to main thread messages
parentPort.on('message', async (message) => {
  const { id, streamBuffer, uid, onlySignaling } = message;
  const startTime = Date.now();

  try {
    sendLog('info', `Start parsing email UID=${uid}, buffer size=${streamBuffer?.length || 0} bytes`);

    // Preprocessing: inject charset for text/* MIME parts missing charset declaration
    // This way simpleParser can correctly handle all transfer-encoding + charset conversions by itself
    const processedBuffer = preInjectMissingCharsets(streamBuffer);

    // Convert preprocessed Buffer to Readable stream
    const stream = new Readable({
      read() {
        this.push(processedBuffer);
        this.push(null);
      }
    });

    // Add 10-second timeout using Promise.race
    const simpleParserPromise = simpleParser(stream);
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Email parsing timeout (10s)')), 10000);
    });

    // Wait for parsing to complete or timeout
    const parsed = await Promise.race([simpleParserPromise, timeoutPromise]);

    // Detect whether it is a signaling email
    const { SIGNALING_EMAIL_PREFIX } = require('../../../shared/config/signaling-constants');
    const isSignaling = parsed.subject && parsed.subject.startsWith(SIGNALING_EMAIL_PREFIX);
    sendLog('info', `Email parsing completed UID=${uid}, subject=${parsed.subject}, signaling=${isSignaling}`);

    // Extract attachments
    // Signaling emails: extract full attachments (including content)
    // Normal emails: extract only metadata (not content, reduces memory usage)
    const attachments = [];
    if (parsed.attachments && Array.isArray(parsed.attachments)) {
      sendLog('info', `Start extracting attachments UID=${uid}, original attachment count=${parsed.attachments.length}`);
      parsed.attachments.forEach((att, i) => {
        // Security check: filter dangerous attachments
        const isDangerousFile = isDangerousExtension(att.filename) ||
                                isDangerousMimeType(att.contentType, att.filename);
        if (isDangerousFile) {
          sendLog('warn', `🚫 Blocked dangerous attachment UID=${uid}: filename=${att.filename}, type=${att.contentType}`);
          return; // Skip dangerous attachments
        }

        if (isSignaling) {
          // Signaling email: extract full attachment content
          attachments.push({
            filename: att.filename,
            contentType: att.contentType,
            content: att.content, // Buffer type
            size: att.size,
            cid: att.cid
          });
        } else {
          // Normal emails: extract only metadata, not content
          attachments.push({
            filename: att.filename,
            contentType: att.contentType,
            size: att.size,
            cid: att.cid
          });
        }
        sendLog('info', `Attachment[${i}] UID=${uid}: filename=${att.filename}, size=${att.size}, type=${att.contentType}, cid=${att.cid}`);
      });
      sendLog('info', `Attachment extraction completed UID=${uid}, extracted count=${attachments.length}, dangerous attachments filtered`);
    }
    
    // Helper function to extract email text from various formats
    function getEmailFromText(fromField) {
      if (!fromField) return '';
      if (typeof fromField === 'string') return fromField;
      if (Array.isArray(fromField) && fromField.length > 0) {
        // Handle array of addresses
        return fromField.map(addr => {
          if (typeof addr === 'string') return addr;
          if (addr.text) return addr.text;
          if (addr.address) return addr.address;
          return '';
        }).join(', ');
      }
      if (fromField.text) return fromField.text;
      if (fromField.address) return fromField.address;
      return '';
    }

    // Extract priority information
    let priority = null;
    const headers = {};

    if (parsed.headers) {
      // Handle headers as Map or plain object
      let headersMap = {};
      if (parsed.headers instanceof Map) {
        headersMap = Object.fromEntries(parsed.headers);
      } else if (typeof parsed.headers === 'object') {
        headersMap = parsed.headers;
      }

      // Try both lowercase and original case for header names
      const xPriority = headersMap['x-priority'] || headersMap['X-Priority'];
      const importance = headersMap['importance'] || headersMap['Importance'];
      const mpPriority = headersMap['priority'];

      if (mpPriority) {
        priority = mpPriority;
      } else if (xPriority) {
        const p = String(xPriority).charAt(0);
        if (p === '1') priority = 'high';
        else if (p === '5') priority = 'low';
        else if (p === '3') priority = 'normal';
      } else if (importance) {
        const i = String(importance).toLowerCase();
        if (i === 'high') priority = 'high';
        else if (i === 'low') priority = 'low';
        else if (i === 'normal') priority = 'normal';
      }

      // Extract key headers for frontend use (use lowercase keys for consistency)
      if (headersMap['priority']) {
        headers['priority'] = headersMap['priority'];
      }
      if (headersMap['x-priority'] || headersMap['X-Priority']) {
        headers['x-priority'] = headersMap['x-priority'] || headersMap['X-Priority'];
      }
      if (headersMap['importance'] || headersMap['Importance']) {
        headers['importance'] = headersMap['importance'] || headersMap['Importance'];
      }
    }

    // Build email data
    // Signaling emails return only necessary fields, normal emails return full fields
    const emailData = isSignaling ? {
      uid: uid,
      subject: fixMojibake(parsed.subject) || '',
      from: getEmailFromText(parsed.from),
      date: parsed.date || new Date(),
      // Add email arrival time, using header time or current time as fallback
      receivedDate: parsed.receivedDate || parsed.date || new Date(),
      text: fixMojibake(parsed.text) || '',
      messageId: parsed.messageId || '',
      attachments: attachments,
      priority: priority,
      headers: headers
    } : {
      uid: uid,
      subject: fixMojibake(parsed.subject) || 'No Subject',
      from: getEmailFromText(parsed.from) || 'Unknown Sender',
      date: parsed.date || new Date(),
      // Add email arrival time, using header time or current time as fallback
      receivedDate: parsed.receivedDate || parsed.date || new Date(),
      text: fixMojibake(parsed.text) || '',
      html: fixMojibake(parsed.html) || '',
      messageId: parsed.messageId || '',
      attachments: attachments,  // normal emails also return attachment metadata
      priority: priority,
      headers: headers
    };

    const duration = Date.now() - startTime;
    sendLog('info', `Email processing completed UID=${uid}, signaling=${isSignaling}, attachment count=${attachments.length}, duration=${duration}ms`);

    // Send success result back to main thread
    parentPort.postMessage({
      id,
      success: true,
      data: emailData
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    sendLog('error', `Email parsing failed UID=${uid}: ${error.message}, duration=${duration}ms`);
    // Send error result back to main thread
    parentPort.postMessage({
      id,
      success: false,
      error: error.message
    });
  }
});
