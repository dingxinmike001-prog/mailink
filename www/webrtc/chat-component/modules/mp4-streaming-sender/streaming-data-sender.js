/**
 * Streaming Data Sender
 * Responsible for sending MP4 stream data chunks
 */

export class StreamingDataSender {
  constructor(sender, progressTracker) {
    this.sender = sender;
    this.progressTracker = progressTracker;
  }

  /**
   * Wait for send window
   */
  async waitForSendWindow() {
    while (this.sender.isStreaming) {
      const bufferedAmount = this.sender.connection.getBufferedAmount
        ? this.sender.connection.getBufferedAmount()
        : 0;
      if (bufferedAmount <= 2048 * 1024) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  /**
   * Send a single chunk
   * @param {number} offset - Offset
   * @param {number} size - Size
   * @param {Object|string} meta - Metadata
   */
  async sendChunk(offset, size, meta = 'data') {
    if (!this.sender.isStreaming) {
      throw new Error('stream stopped');
    }

    const normalizedMeta = typeof meta === 'string'
      ? {
          phase: meta === 'data' ? 'tail' : 'metadata',
          chunkType: meta,
          rangeStart: offset,
          rangeEnd: offset + size
        }
      : {
          phase: meta.phase || 'tail',
          chunkType: meta.chunkType || 'data',
          rangeStart: meta.rangeStart ?? offset,
          rangeEnd: meta.rangeEnd ?? (offset + size)
        };

    if (!this.sender.connection.isConnected()) {
      this.sender.lastSentOffset = offset;
      throw new Error('connection disconnected');
    }

    await this.waitForSendWindow();

    const arrayBuffer = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      const slice = this.sender.file.slice(offset, offset + size);
      reader.onload = (event) => resolve(event.target.result);
      reader.onerror = reject;
      reader.readAsArrayBuffer(slice);
    });

    const header = {
      type: 'file-data-binary',
      id: this.sender.transferId,
      offset,
      totalSize: this.sender.file.size,
      isMP4Stream: true,
      byteLength: arrayBuffer.byteLength,
      chunkType: normalizedMeta.chunkType,
      phase: normalizedMeta.phase,
      rangeStart: normalizedMeta.rangeStart,
      rangeEnd: normalizedMeta.rangeEnd
    };

    const bufferedBeforeSend = this.sender.connection.getBufferedAmount
      ? this.sender.connection.getBufferedAmount()
      : 0;
    const channelState = this.sender.dataChannelManager?.dataChannel?.readyState || 'unknown';

    const headerSent = typeof this.sender.connection.sendDataReliable === 'function'
      ? await this.sender.connection.sendDataReliable(header, { timeoutMs: 10000, intervalMs: 50 })
      : this.sender.connection.sendData(header);
    if (!headerSent) {
      this.sender.logger.error(
        `[StreamingDataSender] send ${normalizedMeta.chunkType} header failed: offset=${offset}, size=${arrayBuffer.byteLength}, buffered=${bufferedBeforeSend}, state=${channelState}`
      );
      throw new Error(`send ${normalizedMeta.chunkType} header failed`);
    }

    const binarySent = typeof this.sender.connection.sendBinaryReliable === 'function'
      ? await this.sender.connection.sendBinaryReliable(arrayBuffer, { timeoutMs: 30000, intervalMs: 50 })
      : (typeof this.sender.dataChannelManager?.sendBinaryReliable === 'function'
        ? await this.sender.dataChannelManager.sendBinaryReliable(arrayBuffer, { timeoutMs: 30000, intervalMs: 50 })
        : (this.sender.dataChannelManager?.sendBinary
          ? this.sender.dataChannelManager.sendBinary(arrayBuffer)
          : false));
    if (!binarySent) {
      const bufferedAfterSend = this.sender.connection.getBufferedAmount
        ? this.sender.connection.getBufferedAmount()
        : bufferedBeforeSend;
      const latestChannelState = this.sender.dataChannelManager?.dataChannel?.readyState || channelState;
      this.sender.logger.error(
        `[StreamingDataSender] send ${normalizedMeta.chunkType} payload failed: offset=${offset}, size=${arrayBuffer.byteLength}, bufferedBefore=${bufferedBeforeSend}, bufferedAfter=${bufferedAfterSend}, state=${latestChannelState}`
      );
      throw new Error(`send ${normalizedMeta.chunkType} payload failed`);
    }

    const sentEnd = offset + arrayBuffer.byteLength;
    this.sender.lastSentOffset = Math.max(this.sender.lastSentOffset, sentEnd);
    this.progressTracker.recordSentRange(offset, sentEnd);
    await this.progressTracker.sendProgressUpdate(sentEnd >= this.sender.file.size);
  }

  /**
   * Send range data
   * @param {number} start - Start position
   * @param {number} end - End position
   * @param {Object} meta - Metadata
   */
  async sendRange(start, end, meta) {
    let offset = start;

    while (offset < end && this.sender.isStreaming) {
      const chunkSize = Math.min(this.sender.chunkSize, end - offset);
      await this.sendChunk(offset, chunkSize, meta);
      offset += chunkSize;
    }
  }

  /**
   * Send phase data
   * @param {Object} phase - Phase info
   * @param {Object} resumeState - Resume state
   * @param {Object} planBuilder - Playback plan builder
   */
  async sendPhase(phase, resumeState, planBuilder) {
    for (const range of phase.ranges) {
      const start = planBuilder.resolveResumeStartForRange(range, resumeState);
      if (start >= range.end) {
        continue;
      }
      await this.sendRange(start, range.end, {
        phase: phase.phase,
        chunkType: range.chunkType || 'data',
        rangeStart: range.start,
        rangeEnd: range.end
      });
    }
  }

  /**
   * Send according to playback plan
   * @param {Object} plan - Playback plan
   * @param {Object} resumeState - Resume state
   * @param {Object} planBuilder - Playback plan builder
   */
  async sendByPlaybackPlan(plan, resumeState, planBuilder) {
    if (!plan?.phases?.length) {
      throw new Error('missing playback plan');
    }

    // Check whether to prioritize sending startup data (for resume scenarios)
    // If resumeOffset already exceeds startup range, but startup is critical for playback
    const startupPhase = plan.phases.find(p => p.phase === 'startup');
    const tailPhase = plan.phases.find(p => p.phase === 'tail');
    
    if (startupPhase?.ranges?.length && tailPhase?.ranges?.length && resumeState?.globalOffset > 0) {
      const startupRange = startupPhase.ranges[0];
      const tailRange = tailPhase.ranges[0];
      
      // If resumeOffset already exceeds startup end position, startup was skipped
      // But receiver needs startup data to begin playback
      // So insert startup data before tail phase
      if (resumeState.globalOffset >= startupRange.end) {
        this.sender.logger.info(`[StreamingDataSender] resume offset(${resumeState.globalOffset})greater thanstartuprange, will startupdataprioritysend`);
        
        // Reorder: send startup first, then tail
        const reorderedPhases = [
          ...plan.phases.filter(p => p.phase === 'metadata'),
          {
            phase: 'startup',
            ranges: [{ ...startupRange, priority: 'high' }]
          },
          {
            phase: 'tail',
            ranges: tailPhase.ranges
          }
        ];
        
        for (const phase of reorderedPhases) {
          if (!phase.ranges?.length) {
            continue;
          }
          await this.sendPhase(phase, resumeState, planBuilder);
        }
        return;
      }
    }

    for (const phase of plan.phases) {
      if (!phase.ranges?.length) {
        continue;
      }
      await this.sendPhase(phase, resumeState, planBuilder);
    }
  }

  /**
   * Send file data
   * @param {number} startOffset - Start offset
   * @param {File} file - File object
   * @param {Object} playbackPlan - Playback plan
   * @param {Object} mp4Structure - MP4 structure info
   * @param {Object} planBuilder - Playback plan builder
   * @param {Function} finishCallback - Completion callback
   */
  async sendFileData(startOffset = 0, file, playbackPlan, mp4Structure, planBuilder, finishCallback) {
    const fileSize = file.size;

    const resumeState = planBuilder.buildResumeState(startOffset, mp4Structure);
    this.sender.logger.info(`[StreamingDataSender] send by playback plan: ${file.name}, size=${fileSize}, offset=${startOffset}`);

    await this.sendByPlaybackPlan(playbackPlan, resumeState, planBuilder);
    if (finishCallback) {
      await finishCallback(file, fileSize);
    }
  }

  /**
   * Send file data range
   * @param {number} startOffset - Start offset
   * @param {number} endOffset - End offset
   */
  async sendFileDataRange(startOffset, endOffset) {
    return this.sendRange(startOffset, endOffset, {
      phase: 'tail',
      chunkType: 'data',
      rangeStart: startOffset,
      rangeEnd: endOffset
    });
  }

  /**
   * Send file data in optimal order
   * @param {number} resumeOffset - Resume offset
   * @param {File} file - File object
   * @param {Object} playbackPlan - Playback plan
   * @param {Object} mp4Structure - MP4 structure info
   * @param {Object} planBuilder - Playback plan builder
   * @param {Function} finishCallback - Completion callback
   */
  async sendFileDataInOptimalOrder(resumeOffset = 0, file, playbackPlan, mp4Structure, planBuilder, finishCallback) {
    return this.sendFileData(resumeOffset, file, playbackPlan, mp4Structure, planBuilder, finishCallback);
  }
}
