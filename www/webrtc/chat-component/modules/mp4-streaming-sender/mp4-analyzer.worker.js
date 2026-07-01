/**
 * MP4 Analyzer Worker
 * Responsibilities: process MP4 file structure analysis in background thread
 * - Scan top-level boxes (ftyp, moov, mdat, sidx, moof, etc.)
 * - Parse SIDX Box to get segment index
 * - Calculate startup range
 */

// Task queue management
const taskQueue = new Map();
let taskIdCounter = 0;

/**
 * Read Box header
 * @param {DataView} view - DataView
 * @param {number} offset - Offset
 * @returns {Object|null} Box info
 */
function parseBoxHeader(view, offset) {
  if (offset + 8 > view.byteLength) {
    return null;
  }

  let size = view.getUint32(offset, false);
  const type = readAtomType(view.buffer, offset + 4);
  let headerSize = 8;

  if (size === 1) {
    if (offset + 16 > view.byteLength) {
      return null;
    }
    size = readUint64AsNumber(view, offset + 8);
    headerSize = 16;
  } else if (size === 0) {
    size = view.byteLength - offset;
  }

  if (!isValidBoxType(type) || size < headerSize) {
    return null;
  }

  return { size, type, headerSize };
}

/**
 * Scan top-level boxes from file slice
 * @param {ArrayBuffer} buffer - Buffer
 * @param {number} fileSize - Total file size
 * @param {number} maxBoxes - Max boxes to scan
 * @returns {Array} Box list
 */
function scanTopLevelBoxes(buffer, fileSize, maxBoxes = 32) {
  const boxes = [];
  let offset = 0;
  const view = new DataView(buffer);

  while (offset < Math.min(buffer.byteLength, fileSize) - 8 && boxes.length < maxBoxes) {
    const boxInfo = parseBoxHeader(view, offset);
    if (!boxInfo || boxInfo.size === 0) {
      break;
    }
    if (offset + boxInfo.size > fileSize) {
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
 * Read atom type
 * @param {ArrayBuffer} buffer - Buffer
 * @param {number} offset - Offset
 * @returns {string} Type string
 */
function readAtomType(buffer, offset) {
  if (offset + 4 > buffer.byteLength) {
    return '';
  }
  const bytes = new Uint8Array(buffer, offset, 4);
  return String.fromCharCode(...bytes);
}

/**
 * Read 64-bit unsigned integer
 * @param {DataView} view - DataView
 * @param {number} offset - Offset
 * @returns {number} Value
 */
function readUint64AsNumber(view, offset) {
  const sizeHigh = view.getUint32(offset, false);
  const sizeLow = view.getUint32(offset + 4, false);
  const combined = (BigInt(sizeHigh) << 32n) | BigInt(sizeLow);

  return combined > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(combined);
}

/**
 * Validate Box type
 * @param {string} type - Box type
 * @returns {boolean} Whether valid
 */
function isValidBoxType(type) {
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
 * Recursively find Box
 * @param {ArrayBuffer} buffer - Buffer
 * @param {number} baseOffset - Base offset
 * @param {string} targetType - Target Box type
 * @param {number} depth - Recursion depth
 * @returns {Object|null} Box info
 */
function findBoxInBufferRecursive(buffer, baseOffset, targetType, depth = 0) {
  if (depth > 3) {
    return null;
  }

  const maxOffset = buffer.byteLength;
  let offset = 0;
  const view = new DataView(buffer);

  while (offset < maxOffset - 8) {
    const boxInfo = parseBoxHeader(view, offset);

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

    if (isContainerBox(boxInfo.type)) {
      const containerDataOffset = offset + boxInfo.headerSize;
      const containerDataSize = boxInfo.size - boxInfo.headerSize;

      if (containerDataSize > 8) {
        try {
          const subBuffer = buffer.slice(containerDataOffset, containerDataOffset + containerDataSize);
          const found = findBoxInBufferRecursive(subBuffer, baseOffset + containerDataOffset, targetType, depth + 1);
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
function findBoxInBuffer(buffer, baseOffset, targetType) {
  const maxOffset = buffer.byteLength;
  let offset = 0;
  const view = new DataView(buffer);

  while (offset < maxOffset - 8) {
    const boxInfo = parseBoxHeader(view, offset);
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
function findMoovInBuffer(buffer, baseOffset) {
  return findBoxInBufferRecursive(buffer, baseOffset, 'moov', 0);
}

/**
 * Find ftyp Box
 * @param {ArrayBuffer} buffer - Buffer
 * @param {number} baseOffset - Base offset
 * @returns {Object|null} Box info
 */
function findFtypInBuffer(buffer, baseOffset) {
  return findBoxInBuffer(buffer, baseOffset, 'ftyp');
}

/**
 * Check if Box is a container
 * @param {string} type - Box type
 * @returns {boolean} Whether it's a container
 */
function isContainerBox(type) {
  const containerTypes = [
    'moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts',
    'meta', 'mvex', 'moof', 'traf', 'mfra', 'skip', 'free'
  ];
  return containerTypes.includes(type);
}

/**
 * Parse SIDX Box
 * @param {ArrayBuffer} buffer - Buffer
 * @param {Object} sidxBox - SIDX Box info
 * @param {number} fileSize - File size
 * @returns {Object|null} Segment index
 */
function parseSidxBox(buffer, sidxBox, fileSize) {
  try {
    const view = new DataView(buffer);
    let cursor = sidxBox.localOffset + sidxBox.headerSize;
    if (cursor + 12 > buffer.byteLength) {
      return null;
    }

    const version = view.getUint8(cursor);
    cursor += 4; // version + flags
    const referenceId = view.getUint32(cursor, false);
    const timescale = view.getUint32(cursor + 4, false);
    cursor += 8;

    let earliestPresentationTime = 0;
    let firstOffset = 0;
    if (version === 0) {
      earliestPresentationTime = view.getUint32(cursor, false);
      firstOffset = view.getUint32(cursor + 4, false);
      cursor += 8;
    } else {
      earliestPresentationTime = Number(view.getBigUint64(cursor, false));
      firstOffset = Number(view.getBigUint64(cursor + 8, false));
      cursor += 16;
    }

    cursor += 2; // reserved
    const referenceCount = view.getUint16(cursor, false);
    cursor += 2;

    const references = [];
    let segmentOffset = sidxBox.offset + sidxBox.size + firstOffset;
    for (let index = 0; index < referenceCount; index++) {
      if (cursor + 12 > buffer.byteLength) {
        break;
      }

      const referenceWord = view.getUint32(cursor, false);
      const duration = view.getUint32(cursor + 4, false);
      const sapWord = view.getUint32(cursor + 8, false);
      cursor += 12;

      const referenceType = (referenceWord >>> 31) & 0x1;
      const referenceSize = referenceWord & 0x7fffffff;
      const startsWithSap = ((sapWord >>> 31) & 0x1) === 1;

      const start = segmentOffset;
      const end = Math.min(fileSize, start + referenceSize);
      references.push({
        index,
        referenceType,
        size: referenceSize,
        duration,
        durationSeconds: timescale > 0 ? duration / timescale : 0,
        start,
        end,
        startsWithSap
      });

      segmentOffset += referenceSize;
    }

    return {
      referenceId,
      timescale,
      earliestPresentationTime,
      firstOffset,
      references
    };
  } catch (error) {
    console.warn('[MP4AnalyzerWorker] parse sidx failed:', error);
    return null;
  }
}

/**
 * Build metadata ranges
 * @param {Object} structure - Structure info
 * @returns {Array} Metadata range list
 */
function buildMetadataRanges(structure) {
  if (!structure?.hasMoov || !structure.moovRange) {
    return [];
  }

  if (structure.moovPosition === 'front') {
    return [{
      start: structure.ftypRange?.start ?? structure.moovRange.start,
      end: structure.sidxRange?.end ?? structure.moovRange.end,
      chunkType: 'metadata'
    }];
  }

  const ranges = [];
  if (structure.ftypRange) {
    ranges.push({
      start: structure.ftypRange.start,
      end: structure.ftypRange.end,
      chunkType: 'ftyp'
    });
  }
  ranges.push({
    start: structure.moovRange.start,
    end: structure.moovRange.end,
    chunkType: 'moov'
  });
  return ranges;
}

/**
 * Calculate startup range
 * @param {Object} structure - Structure info
 * @param {number} fileSize - File size
 * @param {number} defaultStartupWindow - Default startup window size
 * @param {number} startupSafetyBytes - Startup safety bytes
 * @returns {Object} Startup range
 */
function calculateStartupRange(structure, fileSize, defaultStartupWindow, startupSafetyBytes) {
  if (!structure?.metadataRanges?.length) {
    return {
      start: 0,
      end: Math.min(fileSize, defaultStartupWindow)
    };
  }

  if (structure.isFragmented) {
    return calculateFragmentedStartupRange(structure, fileSize, defaultStartupWindow);
  }

  if (structure.moovPosition === 'front') {
    const metadataEnd = Math.max(...structure.metadataRanges.map(range => range.end));
    return {
      start: metadataEnd,
      end: Math.min(fileSize, metadataEnd + defaultStartupWindow)
    };
  }

  const start = structure.ftypRange?.end ?? 0;
  return {
    start,
    end: Math.min(structure.moovOffset, start + defaultStartupWindow + startupSafetyBytes)
  };
}

/**
 * Calculate fragmented MP4 startup range
 * @param {Object} structure - Structure info
 * @param {number} fileSize - File size
 * @param {number} defaultStartupWindow - Default startup window size
 * @returns {Object} Startup range
 */
function calculateFragmentedStartupRange(structure, fileSize, defaultStartupWindow) {
  const metadataEnd = Math.max(...structure.metadataRanges.map(range => range.end));
  const references = structure.fragmentIndex?.references || [];

  if (!references.length) {
    return {
      start: metadataEnd,
      end: Math.min(fileSize, metadataEnd + defaultStartupWindow)
    };
  }

  let startupEnd = metadataEnd;
  let coveredSeconds = 0;
  let coveredSegments = 0;

  for (const reference of references) {
    startupEnd = Math.max(startupEnd, reference.end);
    coveredSeconds += reference.durationSeconds || 0;
    coveredSegments += 1;

    const coveredBytes = startupEnd - metadataEnd;
    if (
      coveredSegments >= 6 &&
      (coveredSeconds >= 60 || coveredBytes >= defaultStartupWindow)
    ) {
      break;
    }
  }

  return {
    start: metadataEnd,
    end: Math.min(fileSize, startupEnd)
  };
}

/**
 * Enhance fragmented structure info
 * @param {Object} structure - Structure info
 * @param {ArrayBuffer} buffer - Buffer
 * @param {Array} topLevelBoxes - Top-level box list
 * @param {number} fileSize - File size
 */
function enrichFragmentedStructure(structure, buffer, topLevelBoxes, fileSize) {
  const sidxBox = topLevelBoxes.find(box => box.type === 'sidx');
  const moofBox = topLevelBoxes.find(box => box.type === 'moof');

  if (!sidxBox && !moofBox) {
    return;
  }

  structure.isFragmented = true;
  structure.streamFormat = 'fmp4';

  if (sidxBox) {
    structure.sidxRange = {
      start: sidxBox.offset,
      end: sidxBox.offset + sidxBox.size
    };
    structure.fragmentIndex = parseSidxBox(buffer, sidxBox, fileSize);
  }
}

/**
 * Analyze MP4 file structure
 * @param {Object} params - Parameters
 * @returns {Promise<Object>} Structure info
 */
async function analyzeMP4Structure(params) {
  const { fileData, fileSize, defaultStartupWindow, startupSafetyBytes } = params;

  const result = {
    hasMoov: false,
    moovPosition: 'unknown',
    moovOffset: -1,
    moovSize: 0,
    sendOrder: 'playback_plan',
    ftypSize: 0,
    mdatOffset: -1,
    mdatSize: 0,
    ftypRange: null,
    moovRange: null,
    sidxRange: null,
    metadataRanges: [],
    startupRange: null,
    playbackPlan: null,
    streamFormat: 'mp4',
    isFragmented: false,
    fragmentIndex: null
  };

  try {
    // First scan file header
    const headerSize = Math.min(2 * 1024 * 1024, fileSize);
    const headerBuffer = fileData.slice(0, headerSize);
    const topLevelBoxes = scanTopLevelBoxes(headerBuffer, fileSize, 32);

    const ftypBox = topLevelBoxes.find(box => box.type === 'ftyp');
    const mdatBox = topLevelBoxes.find(box => box.type === 'mdat');
    const moovBox = topLevelBoxes.find(box => box.type === 'moov');

    if (ftypBox) {
      result.ftypSize = ftypBox.size;
      result.ftypRange = {
        start: ftypBox.offset,
        end: ftypBox.offset + ftypBox.size
      };
    }

    if (mdatBox) {
      result.mdatOffset = mdatBox.offset;
      result.mdatSize = mdatBox.size;
    }

    // Check if it's fragmented MP4
    enrichFragmentedStructure(result, headerBuffer, topLevelBoxes, fileSize);

    if (moovBox) {
      result.hasMoov = true;
      result.moovPosition = mdatBox && moovBox.offset > mdatBox.offset ? 'back' : 'front';
      result.moovOffset = moovBox.offset;
      result.moovSize = moovBox.size;
      result.moovRange = {
        start: moovBox.offset,
        end: moovBox.offset + moovBox.size
      };
      result.metadataRanges = buildMetadataRanges(result);
      result.startupRange = calculateStartupRange(result, fileSize, defaultStartupWindow, startupSafetyBytes);
      return result;
    }

    // If moov not found in header, try searching at tail
    if (fileSize > headerSize) {
      const tailSize = Math.min(4 * 1024 * 1024, fileSize);
      const tailOffset = fileSize - tailSize;
      const tailBuffer = fileData.slice(tailOffset, fileSize);
      const moovInBack = findMoovInBuffer(tailBuffer, tailOffset);

      if (moovInBack) {
        result.hasMoov = true;
        result.moovPosition = 'back';
        result.moovOffset = moovInBack.offset;
        result.moovSize = moovInBack.size;
        result.moovRange = {
          start: moovInBack.offset,
          end: moovInBack.offset + moovInBack.size
        };

        // If ftyp not found earlier, try searching at header
        if (!result.ftypRange) {
          const ftypBuffer = fileData.slice(0, Math.min(64 * 1024, fileSize));
          const ftypInfo = findFtypInBuffer(ftypBuffer, 0);
          if (ftypInfo) {
            result.ftypSize = ftypInfo.size;
            result.ftypRange = {
              start: ftypInfo.offset,
              end: ftypInfo.offset + ftypInfo.size
            };
          }
        }

        result.metadataRanges = buildMetadataRanges(result);
        result.startupRange = calculateStartupRange(result, fileSize, defaultStartupWindow, startupSafetyBytes);
        return result;
      }
    }

    // Fallback plan
    result.startupRange = {
      start: 0,
      end: Math.min(fileSize, defaultStartupWindow)
    };

    return result;
  } catch (error) {
    console.error('[MP4AnalyzerWorker] analyze MP4 failed:', error);
    result.startupRange = {
      start: 0,
      end: Math.min(fileSize, defaultStartupWindow)
    };
    return result;
  }
}

// Message processing
self.onmessage = async function(e) {
  const { type, taskId, params } = e.data;

  try {
    let result;

    switch (type) {
      case 'analyzeMP4Structure':
        result = await analyzeMP4Structure(params);
        break;
      default:
        throw new Error(`Unknown operation type: ${type}`);
    }

    // Return result
    self.postMessage({
      type: 'result',
      taskId: taskId,
      success: true,
      result: result
    });
  } catch (error) {
    // Return error
    self.postMessage({
      type: 'result',
      taskId: taskId,
      success: false,
      error: error.message
    });
  }
};

// Worker initialization log
console.log('[MP4 Analyzer Worker] Initialized and ready');
