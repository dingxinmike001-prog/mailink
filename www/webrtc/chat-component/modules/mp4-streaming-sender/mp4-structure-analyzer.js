/**
 * MP4 Structure Analyzer
 * Analyzes MP4 file structure and extracts metadata
 * Uses Web Worker to perform heavy operations in background thread, avoiding UI blocking
 */

// MP4 Analyzer Worker instance (lazy loaded)
let mp4AnalyzerWorker = null;
let taskIdCounter = 0;
const pendingTasks = new Map();

/**
 * Get or create MP4 Analyzer Worker instance
 * @returns {Worker} MP4 Analyzer Worker instance
 */
function getMP4AnalyzerWorker() {
  if (!mp4AnalyzerWorker) {
    const workerPath = new URL('./mp4-analyzer.worker.js', import.meta.url).href;
    mp4AnalyzerWorker = new Worker(workerPath);

    mp4AnalyzerWorker.onmessage = (e) => {
      const { type, taskId, success, result, error } = e.data;

      if (type === 'result' && pendingTasks.has(taskId)) {
        const { resolve, reject } = pendingTasks.get(taskId);
        pendingTasks.delete(taskId);

        if (success) {
          resolve(result);
        } else {
          reject(new Error(error));
        }
      }
    };

    mp4AnalyzerWorker.onerror = (error) => {
      console.error('[MP4 Analyzer Worker] Error:', error);
    };
  }

  return mp4AnalyzerWorker;
}

/**
 * Send task to MP4 Analyzer Worker
 * @param {string} type - Task type
 * @param {Object} params - Task parameters
 * @returns {Promise<any>} Task result
 */
function sendAnalyzerTask(type, params) {
  return new Promise((resolve, reject) => {
    const taskId = ++taskIdCounter;
    pendingTasks.set(taskId, { resolve, reject });

    try {
      const worker = getMP4AnalyzerWorker();
      worker.postMessage({ type, taskId, params });
    } catch (error) {
      pendingTasks.delete(taskId);
      reject(error);
    }
  });
}

/**
 * Terminate MP4 Analyzer Worker (for resource cleanup)
 */
export function terminateMP4AnalyzerWorker() {
  if (mp4AnalyzerWorker) {
    mp4AnalyzerWorker.terminate();
    mp4AnalyzerWorker = null;
    pendingTasks.clear();
  }
}

export class MP4StructureAnalyzer {
  constructor(boxParser, logger) {
    this.boxParser = boxParser;
    this.logger = logger;
  }

  /**
   * Analyze MP4 file structure
   * @param {File} file - File object
   * @param {number} defaultStartupWindow - Default startup window size
   * @param {number} startupSafetyBytes - Startup safety bytes
   * @returns {Promise<Object>} Structure info
   */
  async analyze(file, defaultStartupWindow, startupSafetyBytes) {
    try {
      // Use Worker to analyze MP4 structure in background thread
      const fileData = await this.readFileData(file);
      const result = await sendAnalyzerTask('analyzeMP4Structure', {
        fileData,
        fileSize: file.size,
        defaultStartupWindow,
        startupSafetyBytes
      });

      this.logger.info(`[MP4StructureAnalyzer] Analysis completed: hasMoov=${result.hasMoov}, position=${result.moovPosition}`);
      return result;
    } catch (error) {
      this.logger.error('[MP4StructureAnalyzer] Worker analysis failed, falling back to main thread:', error);
      // Fallback: analyze in main thread
      return this.analyzeInMainThread(file, defaultStartupWindow, startupSafetyBytes);
    }
  }

  /**
   * Read file data as ArrayBuffer
   * @param {File} file - File object
   * @returns {Promise<ArrayBuffer>} File data
   */
  async readFileData(file) {
    // Read header and tail data (required for analysis in Worker)
    const headerSize = Math.min(2 * 1024 * 1024, file.size);
    const tailSize = Math.min(4 * 1024 * 1024, file.size);

    const headerBuffer = await file.slice(0, headerSize).arrayBuffer();

    if (file.size <= headerSize) {
      return headerBuffer;
    }

    // Merge header and tail data
    const tailOffset = file.size - tailSize;
    const tailBuffer = await file.slice(tailOffset, file.size).arrayBuffer();

    // Create merged buffer
    const combinedBuffer = new ArrayBuffer(headerSize + tailSize);
    const combinedView = new Uint8Array(combinedBuffer);

    combinedView.set(new Uint8Array(headerBuffer), 0);
    combinedView.set(new Uint8Array(tailBuffer), headerSize);

    return combinedBuffer;
  }

  /**
   * Analyze MP4 structure in main thread (fallback)
   * @param {File} file - File object
   * @param {number} defaultStartupWindow - Default startup window size
   * @param {number} startupSafetyBytes - Startup safety bytes
   * @returns {Promise<Object>} Structure info
   */
  async analyzeInMainThread(file, defaultStartupWindow, startupSafetyBytes) {
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
      const topLevelBoxes = await this.boxParser.scanTopLevelBoxesFromFile(file);
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

      await this.enrichFragmentedStructureFromFile(result, file, topLevelBoxes);

      if (moovBox) {
        result.hasMoov = true;
        result.moovPosition = mdatBox && moovBox.offset > mdatBox.offset ? 'back' : 'front';
        result.moovOffset = moovBox.offset;
        result.moovSize = moovBox.size;
        result.moovRange = {
          start: moovBox.offset,
          end: moovBox.offset + moovBox.size
        };
        result.metadataRanges = this.buildMetadataRanges(result);
        result.startupRange = this.calculateStartupRange(result, file.size, defaultStartupWindow, startupSafetyBytes);
        return result;
      }

      this.logger.warn(`[MP4StructureAnalyzer] moov not found in top-level index, fallback to buffered scan: size=${file.size}`);
      const fallback = await this.analyzeFromBufferedScan(file, result, defaultStartupWindow, startupSafetyBytes);
      if (fallback.hasMoov) {
        return fallback;
      }

      this.logger.warn(`[MP4StructureAnalyzer] moov not found, fallback to plain sequential plan, size=${file.size}`);
      fallback.metadataRanges = [];
      fallback.startupRange = {
        start: 0,
        end: Math.min(file.size, defaultStartupWindow)
      };
      return fallback;
    } catch (error) {
      this.logger.error('[MP4StructureAnalyzer] analyze MP4 failed:', error);
      result.startupRange = {
        start: 0,
        end: Math.min(file.size, defaultStartupWindow)
      };
    }

    return result;
  }

  /**
   * Analyze MP4 structure by scanning from buffer
   * @param {File} file - File object
   * @param {Object} seedResult - Seed result
   * @param {number} defaultStartupWindow - Default startup window size
   * @param {number} startupSafetyBytes - Startup safety bytes
   * @returns {Promise<Object>} Structure info
   */
  async analyzeFromBufferedScan(file, seedResult, defaultStartupWindow, startupSafetyBytes) {
    const fallback = {
      ...seedResult,
      metadataRanges: seedResult.metadataRanges || [],
      startupRange: seedResult.startupRange || null
    };
    const headerSize = Math.min(2 * 1024 * 1024, file.size);
    const headerBuffer = await file.slice(0, headerSize).arrayBuffer();
    const topLevelBoxes = this.boxParser.scanTopLevelBoxes(headerBuffer, 0);

    const moovInFront = this.boxParser.findMoovInBuffer(headerBuffer, 0);
    if (moovInFront) {
      fallback.hasMoov = true;
      fallback.moovPosition = 'front';
      fallback.moovOffset = moovInFront.offset;
      fallback.moovSize = moovInFront.size;
      fallback.moovRange = {
        start: moovInFront.offset,
        end: moovInFront.offset + moovInFront.size
      };

      const ftypInfo = this.boxParser.findFtypInBuffer(headerBuffer, 0);
      if (ftypInfo) {
        fallback.ftypSize = ftypInfo.size;
        fallback.ftypRange = {
          start: ftypInfo.offset,
          end: ftypInfo.offset + ftypInfo.size
        };
      }

      this.enrichFragmentedStructure(fallback, headerBuffer, topLevelBoxes, file.size);
      fallback.metadataRanges = this.buildMetadataRanges(fallback);
      fallback.startupRange = this.calculateStartupRange(fallback, file.size, defaultStartupWindow, startupSafetyBytes);
      return fallback;
    }

    if (file.size > headerSize) {
      const tailSize = Math.min(4 * 1024 * 1024, file.size);
      const tailOffset = file.size - tailSize;
      const tailBuffer = await file.slice(tailOffset, file.size).arrayBuffer();
      const moovInBack = this.boxParser.findMoovInBuffer(tailBuffer, tailOffset);

      if (moovInBack) {
        fallback.hasMoov = true;
        fallback.moovPosition = 'back';
        fallback.moovOffset = moovInBack.offset;
        fallback.moovSize = moovInBack.size;
        fallback.moovRange = {
          start: moovInBack.offset,
          end: moovInBack.offset + moovInBack.size
        };

        const ftypBuffer = await file.slice(0, Math.min(64 * 1024, file.size)).arrayBuffer();
        const ftypInfo = this.boxParser.findFtypInBuffer(ftypBuffer, 0);
        if (ftypInfo) {
          fallback.ftypSize = ftypInfo.size;
          fallback.ftypRange = {
            start: ftypInfo.offset,
            end: ftypInfo.offset + ftypInfo.size
          };
        }

        fallback.metadataRanges = this.buildMetadataRanges(fallback);
        fallback.startupRange = this.calculateStartupRange(fallback, file.size, defaultStartupWindow, startupSafetyBytes);
      }
    }

    return fallback;
  }

  /**
   * Build metadata ranges
   * @param {Object} structure - Structure info
   * @returns {Array} Metadata range list
   */
  buildMetadataRanges(structure) {
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
  calculateStartupRange(structure, fileSize, defaultStartupWindow, startupSafetyBytes) {
    if (!structure?.metadataRanges?.length) {
      return {
        start: 0,
        end: Math.min(fileSize, defaultStartupWindow)
      };
    }

    if (structure.isFragmented) {
      return this.calculateFragmentedStartupRange(structure, fileSize, defaultStartupWindow);
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
  calculateFragmentedStartupRange(structure, fileSize, defaultStartupWindow) {
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
   * Enhance fragmented structure info (from buffer)
   * @param {Object} structure - Structure info
   * @param {ArrayBuffer} buffer - Buffer
   * @param {Array} topLevelBoxes - Top-level box list
   * @param {number} fileSize - File size
   */
  enrichFragmentedStructure(structure, buffer, topLevelBoxes, fileSize) {
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
      structure.fragmentIndex = this.parseSidxBox(buffer, sidxBox, fileSize);
    }
  }

  /**
   * Enhance fragmented structure info (from file)
   * @param {Object} structure - Structure info
   * @param {File} file - File object
   * @param {Array} topLevelBoxes - Top-level box list
   */
  async enrichFragmentedStructureFromFile(structure, file, topLevelBoxes) {
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

      const sidxBuffer = await file.slice(sidxBox.offset, sidxBox.offset + sidxBox.size).arrayBuffer();
      structure.fragmentIndex = this.parseSidxBox(sidxBuffer, {
        ...sidxBox,
        localOffset: 0
      }, file.size);
    }
  }

  /**
   * Parse SIDX Box
   * @param {ArrayBuffer} buffer - Buffer
   * @param {Object} sidxBox - SIDX Box info
   * @param {number} fileSize - File size
   * @returns {Object|null} Segment index
   */
  parseSidxBox(buffer, sidxBox, fileSize) {
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
      this.logger.warn('[MP4StructureAnalyzer] parse sidx failed:', error);
      return null;
    }
  }
}
