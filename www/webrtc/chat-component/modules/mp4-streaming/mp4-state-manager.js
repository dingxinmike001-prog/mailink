/**
 * MP4 state management module
 * Handles file data structure creation, playback state management, and phase state checks
 */

export class MP4StateManager {
  constructor(receiver) {
    this.receiver = receiver;
    this.logger = receiver.logger;
  }

  /**
   * Create initial file data structure
   */
  createInitialFileData(offer) {
    const metadataRanges = offer?.mp4Structure?.metadataRanges || [];
    const moovRangeFromOffer = offer?.mp4Structure?.moovRange ||
      metadataRanges.find(range => range?.chunkType === 'moov' || range?.chunkType === 'metadata');
    const moovRangeStart = Number.isFinite(moovRangeFromOffer?.start)
      ? moovRangeFromOffer.start
      : (Number.isFinite(offer?.mp4Structure?.moovOffset) ? offer.mp4Structure.moovOffset : 0);
    const moovRangeEndFromOffer = Number.isFinite(moovRangeFromOffer?.end) ? moovRangeFromOffer.end : null;
    const moovSizeFromOffer = offer?.mp4Structure?.moovSize || 0;
    const moovSize = Math.max(
      moovSizeFromOffer,
      moovRangeEndFromOffer && moovRangeEndFromOffer > moovRangeStart
        ? moovRangeEndFromOffer - moovRangeStart
        : 0
    );
    const moovRangeEnd = moovRangeEndFromOffer && moovRangeEndFromOffer > moovRangeStart
      ? moovRangeEndFromOffer
      : (moovRangeStart + moovSize);

    return {
      totalSize: offer.size,
      receivedSize: 0,
      writtenSize: 0,
      moovPosition: offer.mp4Structure?.moovPosition || 'unknown',
      needsReassembly: offer.mp4Structure?.moovPosition === 'back',
      ftypSize: offer.mp4Structure?.ftypSize || 0,
      moovSize,
      moovRangeStart,
      moovRangeEnd,
      moovReceived: false,
      moovAssembled: false,
      ftypWritten: false,
      moovWritten: false,
      pendingMdatChunks: [],
      moovAssemblyBuffer: null,
      moovAssemblyRanges: [],
      writtenRanges: [],
      phaseWrittenRanges: {
        metadata: [],
        startup: [],
        tail: []
      },
      phaseState: {
        metadataReady: false,
        startupReady: false,
        mediaReady: false
      },
      sourceAttached: false,
      sourceVersion: 0,
      interrupted: false,
      partialPlayable: false,
      partialSnapshotActive: false,
      snapshotSize: 0,
      nextAttachWrittenSize: 0,
      lastMediaErrorCode: null,
      playbackPlan: this.receiver.utilsModule.buildPlaybackPlanFromOffer(offer)
    };
  }

  /**
   * Build playback state object
   */
  buildPlaybackState(fileData) {
    // Calculate playable continuous byte range
    const playableRange = this.calculatePlayableRange(fileData);
    
    return {
      metadataReady: !!fileData?.phaseState?.metadataReady,
      startupReady: !!fileData?.phaseState?.startupReady,
      mediaReady: !!fileData?.phaseState?.mediaReady,
      interrupted: !!fileData?.interrupted,
      partialPlayable: !!fileData?.partialPlayable,
      snapshotSize: fileData?.snapshotSize || 0,
      totalSize: fileData?.totalSize || 0,
      progress: this.receiver.utilsModule.calcWriteProgress(fileData),
      // Add playable range info for limiting seeking
      playableRange,
      playableBytes: playableRange.end - playableRange.start,
      playablePercent: fileData?.totalSize > 0 
        ? Math.round(((playableRange.end - playableRange.start) / fileData.totalSize) * 100)
        : 0
    };
  }

  /**
   * Calculate playable continuous byte range
   * For files with moov at end, playable range is continuous data after reassembled moov
   * @param {Object} fileData - File data
   * @returns {Object} Playable range {start, end}
   */
  calculatePlayableRange(fileData) {
    if (!fileData) {
      return { start: 0, end: 0 };
    }

    const metadataEnd = this.receiver.rangeManager.getPlayableMetadataEnd(fileData);
    
    // Cannot play if metadata is not ready
    if (!metadataEnd || metadataEnd === 0) {
      return { start: 0, end: 0 };
    }

    // Get continuous write range starting from metadata end position
    const contiguousEnd = this.receiver.rangeManager.getPlayableContiguousEnd(fileData);
    
    return {
      start: metadataEnd,
      end: contiguousEnd
    };
  }

  /**
   * Get metadata end position
   */
  getMetadataEnd(fileData) {
    const metadataRanges = this.receiver.rangeManager.getPhaseRanges(fileData, 'metadata');
    if (!metadataRanges.length) {
      return 0;
    }
    return Math.max(...metadataRanges.map(range => range.end));
  }

  /**
   * Check if metadata phase is ready
   */
  isMetadataPhaseReady(fileData, phaseRanges) {
    if (!phaseRanges.length) {
      return fileData.needsReassembly
        ? !!fileData.ftypWritten && !!fileData.moovWritten
        : fileData.writtenSize >= fileData.totalSize;
    }

    const rangesReady = phaseRanges.every(range =>
      this.receiver.rangeManager.isRangeFullyWritten(fileData.writtenRanges, range.start, range.end)
    );

    if (!rangesReady || !fileData.needsReassembly) {
      return rangesReady;
    }

    const hasFtypRange = phaseRanges.some(range => range.chunkType === 'ftyp');
    const hasMoovRange = phaseRanges.some(range => range.chunkType === 'moov' || range.chunkType === 'metadata');

    return (!hasFtypRange || fileData.ftypWritten) && (!hasMoovRange || fileData.moovWritten);
  }

  /**
   * Check if specified phase is ready
   */
  isPhaseReady(fileData, phase) {
    const phaseRanges = this.receiver.rangeManager.getPhaseRanges(fileData, phase);
    if (phase === 'metadata') {
      return this.isMetadataPhaseReady(fileData, phaseRanges);
    }

    if (!phaseRanges.length) {
      return phase === 'startup'
        ? fileData.writtenSize >= fileData.totalSize
        : false;
    }

    if (phase === 'startup' && fileData?.needsReassembly) {
      return phaseRanges.every(range =>
        this.receiver.rangeManager.getContiguousWrittenEndFrom(fileData.writtenRanges, range.start) >= range.end
      );
    }

    return phaseRanges.every(range =>
      this.receiver.rangeManager.isRangeFullyWritten(fileData.writtenRanges, range.start, range.end)
    );
  }

  /**
   * Restore resume state
   */
  restoreResumeWrittenState(fileData, originalOffset = 0) {
    if (!fileData) {
      return;
    }

    fileData.writtenRanges = [];
    fileData.phaseWrittenRanges = {
      metadata: [],
      startup: [],
      tail: []
    };

    const normalizedOffset = Math.max(0, Math.min(originalOffset, fileData.totalSize || originalOffset));
    if (normalizedOffset > 0) {
      this.receiver.rangeManager.recordWrittenRange(fileData.writtenRanges, 0, normalizedOffset);
    }

    const metadataRanges = this.receiver.rangeManager.getPhaseRanges(fileData, 'metadata');
    const ftypRange = metadataRanges.find(range => range.chunkType === 'ftyp');
    const moovRange = metadataRanges.find(range => range.chunkType === 'moov' || range.chunkType === 'metadata');
    const metadataEnd = this.getMetadataEnd(fileData);

    fileData.ftypWritten = !!(
      fileData.ftypWritten ||
      (ftypRange && normalizedOffset >= ftypRange.end) ||
      (!ftypRange && normalizedOffset >= (fileData.ftypSize || 0))
    );

    if (fileData.needsReassembly) {
      const shouldRestoreMoov = !!(
        fileData.moovWritten ||
        fileData.moovReceived ||
        (fileData.moovSize > 0 && fileData.writtenSize >= (fileData.ftypSize || 0) + fileData.moovSize)
      );

      if (shouldRestoreMoov && moovRange?.end > moovRange?.start) {
        fileData.moovWritten = true;
        fileData.moovReceived = true;
        fileData.moovAssembled = true;
        fileData.moovSize = fileData.moovSize || (moovRange.end - moovRange.start);
        this.receiver.rangeManager.recordWrittenRange(fileData.writtenRanges, moovRange.start, moovRange.end);
      }
      return;
    }

    if (metadataEnd > 0 && normalizedOffset >= metadataEnd) {
      fileData.moovWritten = true;
    }
  }

  /**
   * Update transfer phase state
   */
  updateTransferPhaseState(transferId) {
    const fileData = this.receiver.fileChunks.get(transferId);
    const offer = this.receiver.fileOffers.get(transferId);
    if (!fileData || !offer) {
      return;
    }

    fileData.phaseState.metadataReady = this.isPhaseReady(fileData, 'metadata');
    fileData.phaseState.startupReady = this.isPhaseReady(fileData, 'startup');

    if (
      fileData.phaseState.metadataReady &&
      fileData.phaseState.startupReady &&
      !fileData.sourceAttached &&
      (fileData.writtenSize || 0) >= (fileData.nextAttachWrittenSize || 0)
    ) {
      fileData.sourceAttached = true;
      this.receiver.videoPlayer.updateVideoPlayerSource(transferId).catch(error => {
        this.logger.warn('[MP4StateManager] updateVideoPlayerSource failed:', error);
      });
    }

    const state = this.buildPlaybackState(fileData);
    this.receiver.videoPlayer.updateVideoPlayStatus(transferId, state);
    this.receiver.videoPlayer.dispatchPhaseStateChanged(transferId, state);
  }
}
