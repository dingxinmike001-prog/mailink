/**
 * MP4 data processing module
 * Handles MP4 data reception, write queue management, and playability checks
 */

export class MP4DataHandler {
  constructor(receiver) {
    this.receiver = receiver;
    this.logger = receiver.logger;
    this.context = receiver.context;
    this.electronAPI = receiver.electronAPI;
  }

  /**
   * Persist MP4 metadata to database
   * Use actual bytes written to disk (writtenSize) to calculate progress
   */
  async saveMP4Metadata(id, fileData) {
    if (!this.electronAPI?.updateTransferMetadata) return;

    try {
      const metadata = {
        moovReceived: fileData.moovReceived,
        moovAssembled: fileData.moovAssembled,
        ftypSize: fileData.ftypSize,
        moovSize: fileData.moovSize,
        moovRangeStart: fileData.moovRangeStart,
        moovRangeEnd: fileData.moovRangeEnd,
        needsReassembly: fileData.needsReassembly,
        moovPosition: fileData.moovPosition
      };

      const offer = this.receiver.fileOffers.get(id);
      
      // Use actual bytes written to disk (writtenSize)
      const receivedSize = fileData.writtenSize || 0;
      
      this.logger.info(`[MP4DataHandler] savetransfermetadata: id=${id}, receivedSize=${receivedSize}, writtenSize=${fileData.writtenSize}`);
      
      await this.electronAPI.updateTransferMetadata({
        msgId: id,
        fileName: offer?.filename || 'video.mp4',
        filePath: offer?.storedFileName || '',
        totalSize: fileData.totalSize || 0,
        receivedSize: receivedSize,
        metadata: JSON.stringify(metadata),
        userId: this.context.myEmail
      });
    } catch (e) {
      this.logger.warn(`[MP4DataHandler] persist MP4 metadatafailed:`, e);
    }
  }

  /**
   * Handle MP4 data
   */
  async handleMP4Data(data) {
    const {
      id,
      offset,
      data: chunkData,
      totalSize,
      chunkType,
      phase,
      rangeStart,
      rangeEnd
    } = data;

    const offer = this.receiver.fileOffers.get(id);
    if (!offer) {
      this.logger.error(`[MP4DataHandler] offer not found: ${id}`);
      return;
    }

    if (!this.receiver.fileChunks.has(id)) {
      this.receiver.fileChunks.set(id, this.receiver.stateManager.createInitialFileData(offer));
    }

    const fileData = this.receiver.fileChunks.get(id);
    if (!(chunkData instanceof ArrayBuffer)) {
      this.logger.error(`[MP4DataHandler] unsupported chunk payload: ${typeof chunkData}`);
      return;
    }

    let finalChunk = new Uint8Array(chunkData);
    const effectiveChunkType = chunkType || 'data';
    const effectivePhase = phase || (effectiveChunkType === 'metadata' ? 'metadata' : 'tail');
    let logicalOffset = offset;

    if (effectiveChunkType === 'ftyp') {
      fileData.ftypSize = finalChunk.length;
      this.saveMP4Metadata(id, fileData);
    } else if (effectiveChunkType === 'metadata') {
      fileData.moovSize = Math.max(fileData.moovSize || 0, finalChunk.length);
      fileData.moovReceived = true;
      fileData.moovAssembled = true;
      this.saveMP4Metadata(id, fileData);
    } else if (effectiveChunkType === 'moov') {
      if (!fileData.needsReassembly) {
        fileData.moovSize = Math.max(fileData.moovSize || 0, finalChunk.length);
        fileData.moovReceived = true;
        fileData.moovAssembled = true;
        this.saveMP4Metadata(id, fileData);
      } else if (!fileData.moovAssembled) {
        const moovLayout = await this.receiver.moovReassembler.resolveMoovLayout(fileData, rangeStart, rangeEnd, offset, finalChunk.length);
        const moovAppendResult = await this.receiver.moovReassembler.appendMoovChunkForReassembly(fileData, finalChunk, offset, moovLayout);
        fileData.receivedSize = Math.max(fileData.receivedSize, offset + finalChunk.length);

        if (!moovAppendResult.complete) {
          this.saveMP4Metadata(id, fileData);
          return;
        }

        finalChunk = moovAppendResult.chunk;
        logicalOffset = moovAppendResult.originalOffset;
        fileData.moovReceived = true;
        fileData.moovAssembled = true;

        try {
          const MP4BoxHelper = (await import('../mp4-box-helper.js')).default;
          MP4BoxHelper.findAndPatchOffsets(finalChunk, fileData.moovSize);
        } catch (error) {
          this.logger.error('[MP4DataHandler] patch moov offsets failed:', error);
        }

        fileData.moovAssemblyBuffer = null;
        fileData.moovAssemblyRanges = [];
        this.saveMP4Metadata(id, fileData);
      } else {
        fileData.receivedSize = Math.max(fileData.receivedSize, offset + finalChunk.length);
        return;
      }
    }

    if (fileData.needsReassembly && !fileData.moovReceived && this.receiver.utilsModule.isMdatPayloadChunkType(effectiveChunkType)) {
      fileData.pendingMdatChunks.push({
        chunk: finalChunk,
        offset,
        totalSize,
        chunkType: effectiveChunkType,
        phase: effectivePhase,
        rangeStart,
        rangeEnd
      });
      fileData.receivedSize = Math.max(fileData.receivedSize, offset + finalChunk.length);
      return;
    }

    let writeOffset = logicalOffset;
    if (fileData.needsReassembly) {
      if (effectiveChunkType === 'moov') {
        writeOffset = fileData.ftypSize || 0;
      } else if (this.receiver.utilsModule.isMdatPayloadChunkType(effectiveChunkType) && fileData.moovReceived && logicalOffset >= (fileData.ftypSize || 0)) {
        writeOffset = logicalOffset + fileData.moovSize;
      }
    }

    this.enqueueWriteChunk(
      id,
      offer,
      fileData,
      finalChunk,
      writeOffset,
      logicalOffset,
      totalSize,
      {
        chunkType: effectiveChunkType,
        phase: effectivePhase,
        rangeStart,
        rangeEnd,
        flush: effectiveChunkType === 'ftyp' || effectiveChunkType === 'moov' || effectiveChunkType === 'metadata'
      }
    );

    if (fileData.needsReassembly && effectiveChunkType === 'moov') {
      this.receiver.moovReassembler.flushPendingMdatChunks(id, offer, fileData);
    }

    fileData.receivedSize = Math.max(fileData.receivedSize, logicalOffset + finalChunk.length);
    this.checkPlayableStatus(id);
  }

  /**
   * Add chunk to write queue
   */
  enqueueWriteChunk(id, offer, fileData, chunk, writeOffset, originalOffset, totalSize, chunkMeta) {
    const meta = typeof chunkMeta === 'string'
      ? { chunkType: chunkMeta, phase: chunkMeta === 'metadata' ? 'metadata' : 'tail' }
      : (chunkMeta || {});

    const queue = this.receiver.recvWriteQueues.get(id) || [];
    queue.push({
      id,
      offer,
      fileData,
      chunk,
      offset: writeOffset,
      originalOffset,
      totalSize,
      userId: this.context.myEmail,
      chunkType: meta.chunkType || 'data',
      phase: meta.phase || 'tail',
      rangeStart: meta.rangeStart,
      rangeEnd: meta.rangeEnd,
      flush: !!meta.flush
    });
    this.receiver.recvWriteQueues.set(id, queue);
    this.receiver.drainRecvWriteQueue(id);
  }

  /**
   * Write single receive chunk
   */
  async writeOneRecvChunk(item) {
    const { id, offer, fileData, chunk, offset, totalSize, userId, originalOffset, flush } = item;

    try {
      const result = await this.electronAPI.streamWriteFileChunk(
        offer.filename,
        chunk,
        offset,
        totalSize,
        id,
        userId,
        flush,
        offer.storedFileName  // [FIX] Pass redirected storage name to reuse old files for resume
      );

      if (!result || !result.success) {
        throw new Error(`stream write failed: ${result?.error || 'unknown error'}`);
      }

      const writtenBytes = result.writtenBytes || chunk.length;
      fileData.writtenSize += writtenBytes;

      this.receiver.rangeManager.recordWrittenRange(
        fileData.writtenRanges,
        originalOffset,
        originalOffset + writtenBytes
      );

      if (item.phase && fileData.phaseWrittenRanges?.[item.phase]) {
        this.receiver.rangeManager.recordWrittenRange(
          fileData.phaseWrittenRanges[item.phase],
          originalOffset,
          originalOffset + writtenBytes
        );
      }

      if (item.chunkType === 'ftyp') {
        fileData.ftypWritten = true;
      } else if (item.chunkType === 'moov') {
        fileData.moovWritten = true;
        fileData.moovAssembled = true;
      } else if (item.chunkType === 'metadata') {
        fileData.ftypWritten = true;
        fileData.moovWritten = true;
        fileData.moovAssembled = true;
      }

      if (result.storedFileName) {
        offer.storedFileName = result.storedFileName;
      }

      // Calculate progress using actual bytes written to disk (writtenSize)
      const progress = Math.min(100, Math.round((fileData.writtenSize / totalSize) * 100));
      this.logger.info(`[MP4DataHandler] write progress: chunkType=${item.chunkType}, phase=${item.phase}, originalOffset=${originalOffset}, writtenBytes=${writtenBytes}, totalWritten=${fileData.writtenSize}, progress=${progress}%`);
      this.receiver.uiManager?.updateProgressDisplay(id, progress, fileData.writtenSize, totalSize, 0);
      this.receiver.stateManager.updateTransferPhaseState(id);
      
      // Periodically save transfer metadata (every 5% or at critical points)
      if (progress % 5 === 0 || item.chunkType === 'ftyp' || item.chunkType === 'moov' || item.chunkType === 'metadata') {
        this.saveMP4Metadata(id, fileData);
      }

      return result;
    } catch (error) {
      this.logger.error('[MP4DataHandler] write chunk failed:', error);
      throw error;
    }
  }

  /**
   * Check playable status
   */
  checkPlayableStatus(transferId) {
    this.receiver.stateManager.updateTransferPhaseState(transferId);
  }
}
