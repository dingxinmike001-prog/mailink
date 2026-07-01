/**
 * MP4 Moov reassembly module
 * Handles reassembly logic when moov atom is at file end
 *
 * Uses Worker thread for binary data and range management to avoid blocking main thread
 */

export class MP4MoovReassembler {
  constructor(receiver) {
    this.receiver = receiver;
    this.logger = receiver.logger;
    this.worker = null;
    this.pendingRequests = new Map();
    this.requestIdCounter = 0;
    
    this._initWorker();
  }

  /**
   * Initialize Worker
   */
  _initWorker() {
    try {
      this.worker = new Worker(
        new URL('./mp4-moov-reassembler.worker.js', import.meta.url),
        { type: 'module' }
      );

      this.worker.onmessage = (e) => {
        const { id, type, success, data, error, level, message } = e.data;

        if (type === 'log') {
          if (level === 'info') {
            this.logger.info(message);
          } else if (level === 'warn') {
            this.logger.warn(message);
          } else if (level === 'error') {
            this.logger.error(message);
          }
          return;
        }

        const pending = this.pendingRequests.get(id);
        if (pending) {
          this.pendingRequests.delete(id);
          if (success) {
            pending.resolve(data);
          } else {
            pending.reject(new Error(error || 'Worker processing failed'));
          }
        }
      };

      this.worker.onerror = (error) => {
        this.logger.error('[MP4MoovReassembler] Worker error:', error);
      };

      this.logger.info('[MP4MoovReassembler] Worker initialized successfully');
    } catch (error) {
      this.logger.error('[MP4MoovReassembler] Failed to initialize Worker:', error);
      this.worker = null;
    }
  }

  /**
   * Invoke Worker method
   */
  async _callWorker(type, payload, transferList = []) {
    if (!this.worker) {
      throw new Error('Worker not initialized');
    }

    const id = ++this.requestIdCounter;
    
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      
      this.worker.postMessage(
        { id, type, payload },
        transferList
      );

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Worker timeout'));
        }
      }, 30000);
    });
  }

  /**
   * Parse Moov layout (sync version, for fallback)
   */
  _resolveMoovLayoutSync(fileData, rangeStart, rangeEnd, chunkOffset, chunkLength) {
    const start = Number.isFinite(fileData?.moovRangeStart)
      ? fileData.moovRangeStart
      : (Number.isFinite(rangeStart) ? rangeStart : chunkOffset);
    const endFromState = Number.isFinite(fileData?.moovRangeEnd) && fileData.moovRangeEnd > start
      ? fileData.moovRangeEnd
      : null;
    const endFromChunk = Number.isFinite(rangeEnd) && rangeEnd > start
      ? rangeEnd
      : null;

    const sizeFromState = fileData?.moovSize || 0;
    const sizeFromRange = endFromChunk ? (endFromChunk - start) : 0;
    const resolvedSize = Math.max(sizeFromState, sizeFromRange, chunkLength || 0);
    const resolvedEnd = Math.max(endFromState || 0, endFromChunk || 0, start + resolvedSize);

    fileData.moovRangeStart = start;
    fileData.moovRangeEnd = resolvedEnd;
    fileData.moovSize = resolvedSize;

    return {
      start,
      end: resolvedEnd,
      size: resolvedSize
    };
  }

  /**
   * Parse Moov layout
   */
  async resolveMoovLayout(fileData, rangeStart, rangeEnd, chunkOffset, chunkLength) {
    if (!this.worker) {
      return this._resolveMoovLayoutSync(fileData, rangeStart, rangeEnd, chunkOffset, chunkLength);
    }

    try {
      const result = await this._callWorker('resolveMoovLayout', {
        fileData: {
          moovRangeStart: fileData.moovRangeStart,
          moovRangeEnd: fileData.moovRangeEnd,
          moovSize: fileData.moovSize
        },
        rangeStart,
        rangeEnd,
        chunkOffset,
        chunkLength
      });

      fileData.moovRangeStart = result.moovRangeStart;
      fileData.moovRangeEnd = result.moovRangeEnd;
      fileData.moovSize = result.moovSize;

      return {
        start: result.start,
        end: result.end,
        size: result.size
      };
    } catch (error) {
      this.logger.warn('[MP4MoovReassembler] Worker failed, fallback to sync:', error);
      return this._resolveMoovLayoutSync(fileData, rangeStart, rangeEnd, chunkOffset, chunkLength);
    }
  }

  /**
   * Append Moov chunk for reassembly (sync version, for fallback)
   */
  _appendMoovChunkForReassemblySync(fileData, chunk, chunkOffset, moovLayout) {
    if (!moovLayout?.size || !chunk?.length) {
      return { complete: false };
    }

    if (!fileData.moovAssemblyBuffer || fileData.moovAssemblyBuffer.length !== moovLayout.size) {
      fileData.moovAssemblyBuffer = new Uint8Array(moovLayout.size);
      fileData.moovAssemblyRanges = [];
    }

    const relativeOffset = chunkOffset - moovLayout.start;
    if (relativeOffset < 0 || relativeOffset >= moovLayout.size) {
      this.logger.warn(
        `[MP4MoovReassembler] moov chunk out of range: offset=${chunkOffset}, moovStart=${moovLayout.start}, moovSize=${moovLayout.size}`
      );
      return { complete: false };
    }

    const writableLength = Math.min(chunk.length, moovLayout.size - relativeOffset);
    if (writableLength <= 0) {
      return { complete: false };
    }

    fileData.moovAssemblyBuffer.set(chunk.subarray(0, writableLength), relativeOffset);
    this.receiver.rangeManager.recordWrittenRange(fileData.moovAssemblyRanges, relativeOffset, relativeOffset + writableLength);

    if (writableLength < chunk.length) {
      this.logger.warn(
        `[MP4MoovReassembler] moov chunk truncated: offset=${chunkOffset}, chunk=${chunk.length}, accepted=${writableLength}, moovSize=${moovLayout.size}`
      );
    }

    const complete = this.receiver.rangeManager.getContiguousWrittenEndFrom(fileData.moovAssemblyRanges, 0) >= moovLayout.size;
    return {
      complete,
      chunk: complete ? fileData.moovAssemblyBuffer.slice() : null,
      originalOffset: moovLayout.start
    };
  }

  /**
   * Append Moov chunk for reassembly
   */
  async appendMoovChunkForReassembly(fileData, chunk, chunkOffset, moovLayout) {
    if (!this.worker) {
      return this._appendMoovChunkForReassemblySync(fileData, chunk, chunkOffset, moovLayout);
    }

    try {
      const transferList = [chunk.buffer];
      
      const result = await this._callWorker('appendMoovChunk', {
        moovAssemblyBuffer: fileData.moovAssemblyBuffer ? fileData.moovAssemblyBuffer.buffer : null,
        moovAssemblyRanges: fileData.moovAssemblyRanges || [],
        chunk: chunk.buffer,
        chunkOffset,
        moovLayout
      }, transferList);

      if (result.complete) {
        fileData.moovAssemblyBuffer = null;
        fileData.moovAssemblyRanges = [];
      } else {
        fileData.moovAssemblyRanges = result.moovAssemblyRanges;
      }

      return {
        complete: result.complete,
        chunk: result.chunk ? new Uint8Array(result.chunk) : null,
        originalOffset: result.originalOffset
      };
    } catch (error) {
      this.logger.warn('[MP4MoovReassembler] Worker failed, fallback to sync:', error);
      return this._appendMoovChunkForReassemblySync(fileData, chunk, chunkOffset, moovLayout);
    }
  }

  /**
   * Flush pending MDAT chunks
   */
  flushPendingMdatChunks(id, offer, fileData) {
    if (!fileData?.pendingMdatChunks?.length) {
      return;
    }

    const pendingItems = [...fileData.pendingMdatChunks].sort((a, b) => a.offset - b.offset);
    fileData.pendingMdatChunks = [];

    for (const pendingItem of pendingItems) {
      const mdatWriteOffset = pendingItem.offset + (fileData.moovSize || 0);
      this.receiver.dataHandler.enqueueWriteChunk(
        id,
        offer,
        fileData,
        pendingItem.chunk,
        mdatWriteOffset,
        pendingItem.offset,
        pendingItem.totalSize,
        {
          chunkType: pendingItem.chunkType || 'data',
          phase: pendingItem.phase || 'tail',
          rangeStart: pendingItem.rangeStart,
          rangeEnd: pendingItem.rangeEnd
        }
      );
    }
  }

  /**
   * Destroy Worker
   */
  destroy() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.logger.info('[MP4MoovReassembler] Worker terminated');
    }
    
    this.pendingRequests.clear();
  }
}
