/**
 * MP4 Box Parser
 * Responsible for parsing Box structure in MP4 files
 */

export class MP4BoxParser {
  /**
   * Scan top-level boxes from file
   * @param {File} file - File object
   * @param {number} maxBoxes - Max boxes to scan
   * @returns {Promise<Array>} Box list
   */
  async scanTopLevelBoxesFromFile(file, maxBoxes = 32) {
    const boxes = [];
    let offset = 0;

    while (offset < file.size - 8 && boxes.length < maxBoxes) {
      const boxInfo = await this.readBoxHeaderFromFile(file, offset);
      if (!boxInfo || boxInfo.size === 0) {
        break;
      }
      if (offset + boxInfo.size > file.size) {
        break;
      }

      boxes.push({
        type: boxInfo.type,
        offset,
        size: boxInfo.size,
        headerSize: boxInfo.headerSize,
        localOffset: 0
      });

      offset += boxInfo.size;
    }

    return boxes;
  }

  /**
   * Read Box header from file
   * @param {File} file - File object
   * @param {number} offset - Offset
   * @returns {Promise<Object|null>} Box info
   */
  async readBoxHeaderFromFile(file, offset) {
    const headerEnd = Math.min(file.size, offset + 16);
    const headerBuffer = await file.slice(offset, headerEnd).arrayBuffer();
    if (headerBuffer.byteLength < 8) {
      return null;
    }

    const view = new DataView(headerBuffer);
    let size = view.getUint32(0, false);
    const type = this.readAtomType(headerBuffer, 4);
    let headerSize = 8;

    if (size === 1) {
      if (headerBuffer.byteLength < 16) {
        return null;
      }
      size = this.readUint64AsNumber(view, 8);
      headerSize = 16;
    } else if (size === 0) {
      size = file.size - offset;
    }

    if (!this.isValidBoxType(type) || size < headerSize) {
      return null;
    }

    return { size, type, headerSize };
  }

  /**
   * Scan top-level boxes from buffer
   * @param {ArrayBuffer} buffer - Buffer
   * @param {number} baseOffset - Base offset
   * @returns {Array} Box list
   */
  scanTopLevelBoxes(buffer, baseOffset = 0) {
    const boxes = [];
    let offset = 0;

    while (offset < buffer.byteLength - 8) {
      const boxInfo = this.parseBoxHeader(buffer, offset);
      if (!boxInfo || boxInfo.size === 0) {
        break;
      }
      if (offset + boxInfo.size > buffer.byteLength) {
        break;
      }

      boxes.push({
        type: boxInfo.type,
        offset: baseOffset + offset,
        size: boxInfo.size,
        headerSize: boxInfo.headerSize,
        localOffset: offset
      });

      offset += boxInfo.size;
    }

    return boxes;
  }

  /**
   * Parse Box header
   * @param {ArrayBuffer} buffer - Buffer
   * @param {number} offset - Offset
   * @returns {Object|null} Box info
   */
  parseBoxHeader(buffer, offset) {
    if (offset + 8 > buffer.byteLength) {
      return null;
    }

    const view = new DataView(buffer);
    let size = view.getUint32(offset, false);
    const type = this.readAtomType(buffer, offset + 4);
    let headerSize = 8;

    if (size === 1) {
      if (offset + 16 > buffer.byteLength) {
        return null;
      }
      size = this.readUint64AsNumber(view, offset + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = buffer.byteLength - offset;
    }

    if (!this.isValidBoxType(type)) {
      return null;
    }

    return { size, type, headerSize };
  }

  /**
   * Recursively find Box
   * @param {ArrayBuffer} buffer - Buffer
   * @param {number} baseOffset - Base offset
   * @param {string} targetType - Target Box type
   * @param {number} depth - Recursion depth
   * @returns {Object|null} Box info
   */
  findBoxInBufferRecursive(buffer, baseOffset, targetType, depth = 0) {
    if (depth > 3) {
      return null;
    }

    const maxOffset = buffer.byteLength;
    let offset = 0;

    while (offset < maxOffset - 8) {
      const boxInfo = this.parseBoxHeader(buffer, offset);

      if (!boxInfo || boxInfo.size === 0) {
        break;
      }
      if (offset + boxInfo.size > maxOffset) {
        break;
      }

      if (boxInfo.type === targetType) {
        return {
          offset: baseOffset + offset,
          size: boxInfo.size,
          headerSize: boxInfo.headerSize
        };
      }

      if (this.isContainerBox(boxInfo.type)) {
        const containerDataOffset = offset + boxInfo.headerSize;
        const containerDataSize = boxInfo.size - boxInfo.headerSize;

        if (containerDataSize > 8) {
          try {
            const subBuffer = buffer.slice(containerDataOffset, containerDataOffset + containerDataSize);
            const found = this.findBoxInBufferRecursive(subBuffer, baseOffset + containerDataOffset, targetType, depth + 1);
            if (found) {
              return found;
            }
          } catch {
            // ignore malformed slice
          }
        }
      }

      offset += boxInfo.size;
    }

    return null;
  }

  /**
   * Find Box in buffer
   * @param {ArrayBuffer} buffer - Buffer
   * @param {number} baseOffset - Base offset
   * @param {string} targetType - Target Box type
   * @returns {Object|null} Box info
   */
  findBoxInBuffer(buffer, baseOffset, targetType) {
    const maxOffset = buffer.byteLength;
    let offset = 0;

    while (offset < maxOffset - 8) {
      const boxInfo = this.parseBoxHeader(buffer, offset);
      if (!boxInfo || boxInfo.size === 0) {
        break;
      }
      if (offset + boxInfo.size > maxOffset) {
        break;
      }

      if (boxInfo.type === targetType) {
        return {
          offset: baseOffset + offset,
          size: boxInfo.size,
          headerSize: boxInfo.headerSize
        };
      }

      offset += boxInfo.size;
    }

    return null;
  }

  /**
   * Find moov Box
   * @param {ArrayBuffer} buffer - Buffer
   * @param {number} baseOffset - Base offset
   * @returns {Object|null} Box info
   */
  findMoovInBuffer(buffer, baseOffset) {
    return this.findBoxInBufferRecursive(buffer, baseOffset, 'moov', 0);
  }

  /**
   * Find ftyp Box
   * @param {ArrayBuffer} buffer - Buffer
   * @param {number} baseOffset - Base offset
   * @returns {Object|null} Box info
   */
  findFtypInBuffer(buffer, baseOffset) {
    return this.findBoxInBuffer(buffer, baseOffset, 'ftyp');
  }

  /**
   * Read 64-bit unsigned integer
   * @param {DataView} view - DataView
   * @param {number} offset - Offset
   * @returns {number} Value
   */
  readUint64AsNumber(view, offset) {
    const sizeHigh = view.getUint32(offset, false);
    const sizeLow = view.getUint32(offset + 4, false);
    const combined = (BigInt(sizeHigh) << 32n) | BigInt(sizeLow);

    return combined > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.MAX_SAFE_INTEGER
      : Number(combined);
  }

  /**
   * Read atom type
   * @param {ArrayBuffer} buffer - Buffer
   * @param {number} offset - Offset
   * @returns {string} Type string
   */
  readAtomType(buffer, offset) {
    if (offset + 4 > buffer.byteLength) {
      return '';
    }
    const bytes = new Uint8Array(buffer, offset, 4);
    return String.fromCharCode(...bytes);
  }

  /**
   * Validate Box type
   * @param {string} type - Box type
   * @returns {boolean} Whether valid
   */
  isValidBoxType(type) {
    if (!type || type.length !== 4) {
      return false;
    }

    for (let i = 0; i < 4; i++) {
      const code = type.charCodeAt(i);
      if (!(code >= 32 && code <= 126)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Check if Box is a container
   * @param {string} type - Box type
   * @returns {boolean} Whether it's a container
   */
  isContainerBox(type) {
    const containerTypes = [
      'moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts',
      'meta', 'mvex', 'moof', 'traf', 'mfra', 'skip', 'free'
    ];
    return containerTypes.includes(type);
  }
}
