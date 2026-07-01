/**
 * Streaming Base64/QP decoding Worker
 * Decode encoded data in worker thread, avoid blocking the main thread
 * Supports: Base64, Quoted-Printable, 7BIT/8BIT/BINARY
 */

const { parentPort } = require('worker_threads');

class Base64Decoder {
  constructor() {
    this.pending = '';
  }

  // Pure decoding logic (no stream overhead)
  decode(chunk) {
    this.pending += chunk.replace(/[\s\r\n]+/g, '');
    const fullLen = Math.floor(this.pending.length / 4) * 4;

    if (fullLen > 0) {
      const toEncode = this.pending.slice(0, fullLen);
      this.pending = this.pending.slice(fullLen);
      try {
        return Buffer.from(toEncode, 'base64');
      } catch (e) {
        throw new Error(`Base64 decode failed: ${e.message}`);
      }
    }
    return null;
  }

  flush() {
    if (this.pending.length > 0) {
      try {
        const result = Buffer.from(this.pending, 'base64');
        this.pending = '';
        return result;
      } catch (e) {
        throw new Error(`Base64 decode failed (flush): ${e.message}`);
      }
    }
    return null;
  }
}

class QPDecoder {
  constructor() {
    this.buf = '';
  }

  decode(chunk) {
    this.buf += chunk;
    const splitAt = this.buf.lastIndexOf('\n');

    if (splitAt >= 0) {
      const part = this.buf.slice(0, splitAt + 1);
      this.buf = this.buf.slice(splitAt + 1);
      return this._decodeQPToBuffer(part);
    }
    return null;
  }

  flush() {
    if (this.buf.length > 0) {
      const result = this._decodeQPToBuffer(this.buf);
      this.buf = '';
      return result;
    }
    return null;
  }

  _decodeQPToBuffer(str) {
    // Remove soft line breaks
    const cleaned = str.replace(/=\r\n/g, '').replace(/=\n/g, '');

    // Calculate decoded size
    let decodedLength = 0;
    let i = 0;
    while (i < cleaned.length) {
      if (cleaned[i] === '=' && i + 2 < cleaned.length && /^[0-9A-Fa-f]{2}$/.test(cleaned.slice(i + 1, i + 3))) {
        decodedLength++;
        i += 3;
      } else {
        decodedLength++;
        i++;
      }
    }

    // Create Buffer and fill with decoded bytes
    const result = Buffer.alloc(decodedLength);
    let pos = 0;
    i = 0;
    while (i < cleaned.length) {
      if (cleaned[i] === '=' && i + 2 < cleaned.length && /^[0-9A-Fa-f]{2}$/.test(cleaned.slice(i + 1, i + 3))) {
        result[pos++] = parseInt(cleaned.slice(i + 1, i + 3), 16);
        i += 3;
      } else {
        // Non-encoded characters take byte values directly (ASCII part of QP encoding)
        result[pos++] = cleaned.charCodeAt(i) & 0xFF;
        i++;
      }
    }

    return result;
  }
}

// Global decoder instance (one per Worker)
let decoder = null;

/**
 * Message format:
 * {
 *   cmd: 'init' | 'decode' | 'flush' | 'end',
 *   encoding: 'BASE64' | 'QP' | '7BIT' (only for init)
 *   data: Buffer | string (only for decode)
 * }
 */
parentPort.on('message', (msg) => {
  try {
    const { cmd, encoding, data } = msg;

    if (cmd === 'init') {
      // Initialize decoder
      const enc = encoding?.toUpperCase() || 'BASE64';
      if (enc === 'BASE64' || enc === 'B') {
        decoder = new Base64Decoder();
      } else if (enc === 'QUOTED-PRINTABLE' || enc === 'QP') {
        decoder = new QPDecoder();
      } else {
        // 7BIT / 8BIT / BINARY: no decoding needed
        decoder = { decode: (x) => x, flush: () => null };
      }
      parentPort.postMessage({ cmd: 'init', success: true });
    } else if (cmd === 'decode') {
      if (!decoder) {
        throw new Error('Decoder not initialized');
      }
      // Convert string to Buffer (if needed)
      let buf = data;
      if (typeof data === 'string') {
        buf = Buffer.from(data, 'ascii');
      }
      const decoded = decoder.decode(buf.toString('ascii'));
      if (decoded) {
        // Convert to transferable format
        parentPort.postMessage(
          { cmd: 'decoded', data: decoded },
          [] // transferList is empty, use copy mode
        );
      } else {
        parentPort.postMessage({ cmd: 'decoded', data: null });
      }
    } else if (cmd === 'flush') {
      if (!decoder) {
        throw new Error('Decoder not initialized');
      }
      const decoded = decoder.flush();
      parentPort.postMessage({ cmd: 'flushed', data: decoded || null });
    } else if (cmd === 'end') {
      decoder = null;
      parentPort.postMessage({ cmd: 'ended', success: true });
    } else {
      throw new Error(`Unknown command: ${cmd}`);
    }
  } catch (error) {
    parentPort.postMessage({ cmd: 'error', message: error.message });
  }
});
