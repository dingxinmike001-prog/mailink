/**
 * MP4BoxHelper - utility class for parsing and modifying MP4 Box structure
 * Uses DataView for compatibility in browser and Node.js environments
 */
class MP4BoxHelper {
  /**
   * Recursively find and modify stco and co64 box offsets
   * @param {Uint8Array} uint8Array moov atom data
   * @param {number} delta Offset increment size (usually moovSize)
   */
  static findAndPatchOffsets(uint8Array, delta) {
    if (!uint8Array || uint8Array.length < 8) return uint8Array;

    const dataView = new DataView(uint8Array.buffer, uint8Array.byteOffset, uint8Array.byteLength);
    const decoder = new TextDecoder('utf-8');

    let offset = 0;
    while (offset + 8 <= uint8Array.length) {
      const size = dataView.getUint32(offset, false);
      const type = decoder.decode(uint8Array.subarray(offset + 4, offset + 8));
      
      let boxHeaderSize = 8;
      let actualSize = size;
      if (size === 1) {
        if (offset + 16 > uint8Array.length) break;
        // Use BigInt for 64-bit size
        actualSize = Number(dataView.getBigUint64(offset + 8, false));
        boxHeaderSize = 16;
      } else if (size === 0) {
        actualSize = uint8Array.length - offset;
      }

      if (actualSize < boxHeaderSize || offset + actualSize > uint8Array.length) break;

      const boxContentOffset = offset + boxHeaderSize;
      const boxContentSize = actualSize - boxHeaderSize;

      if (type === 'stco') {
        this.patchStco(dataView, boxContentOffset, boxContentSize, delta);
      } else if (type === 'co64') {
        this.patchCo64(dataView, boxContentOffset, boxContentSize, delta);
      } else if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) {
        this.findAndPatchOffsets(uint8Array.subarray(boxContentOffset, boxContentOffset + boxContentSize), delta);
      }

      offset += actualSize;
    }
    return uint8Array;
  }

  /**
   * Modify stco (32-bit chunk offsets)
   */
  static patchStco(dataView, contentOffset, contentSize, delta) {
    if (contentSize < 8) return;

    const versionAndFlags = dataView.getUint32(contentOffset, false);
    const entryCount = dataView.getUint32(contentOffset + 4, false);

    if (entryCount === 0) return;

    const expectedDataSize = 4 + 4 + (entryCount * 4);
    if (contentSize < expectedDataSize) {
      return;
    }

    let pos = contentOffset + 8;
    for (let i = 0; i < entryCount; i++) {
      const oldOffset = dataView.getUint32(pos, false);
      dataView.setUint32(pos, oldOffset + delta, false);
      pos += 4;
    }
  }

  /**
   * Modify co64 (64-bit chunk offsets)
   */
  static patchCo64(dataView, contentOffset, contentSize, delta) {
    if (contentSize < 8) return;

    const versionAndFlags = dataView.getUint32(contentOffset, false);
    const entryCount = dataView.getUint32(contentOffset + 4, false);

    if (entryCount === 0) return;

    const expectedDataSize = 4 + 4 + (entryCount * 8);
    if (contentSize < expectedDataSize) {
      return;
    }

    let pos = contentOffset + 8;
    for (let i = 0; i < entryCount; i++) {
      const oldOffset = dataView.getBigUint64(pos, false);
      dataView.setBigUint64(pos, oldOffset + BigInt(delta), false);
      pos += 8;
    }
  }
}

export default MP4BoxHelper;
