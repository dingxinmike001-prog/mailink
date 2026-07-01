/**
 * MP4 connection management module
 * Handles connection interruption/recovery and snapshot size calculation
 */

export class MP4ConnectionHandler {
  constructor(receiver) {
    this.receiver = receiver;
    this.logger = receiver.logger;
  }

  /**
   * Calculate segment snapshot size
   */
  computeFragmentSnapshotSize(fileData, offer) {
    const references = offer?.mp4Structure?.fragmentIndex?.references || [];
    if (!references.length) {
      return 0;
    }

    const metadataEnd = this.receiver.rangeManager.getPlayableMetadataEnd(fileData);
    const writtenLimit = Math.max(0, fileData?.writtenSize || 0);
    let snapshotEnd = metadataEnd;

    for (const reference of references) {
      if ((reference?.end || 0) <= writtenLimit) {
        snapshotEnd = Math.max(snapshotEnd, reference.end);
      } else {
        break;
      }
    }

    return snapshotEnd;
  }

  /**
   * Calculate interruption snapshot size
   */
  computeInterruptedSnapshotSize(fileData, offer) {
    if (!fileData || !offer) {
      return 0;
    }

    const metadataEnd = this.receiver.rangeManager.getPlayableMetadataEnd(fileData);
    if (!fileData.phaseState?.metadataReady) {
      return 0;
    }

    if (offer?.mp4Structure?.isFragmented) {
      return this.computeFragmentSnapshotSize(fileData, offer);
    }

    return Math.max(metadataEnd, this.receiver.rangeManager.getPlayableContiguousEnd(fileData));
  }

  /**
   * Handle connection interruption
   */
  async handleConnectionInterrupted() {
    for (const [transferId, offer] of this.receiver.fileOffers.entries()) {
      const fileData = this.receiver.fileChunks.get(transferId);
      if (!fileData || !offer || fileData.writtenSize >= offer.size) {
        continue;
      }

      fileData.interrupted = true;
      const snapshotSize = this.computeInterruptedSnapshotSize(fileData, offer);
      fileData.snapshotSize = snapshotSize;
      fileData.partialPlayable = snapshotSize > this.receiver.rangeManager.getPlayableMetadataEnd(fileData);

      if (!fileData.partialPlayable) {
        const state = this.receiver.stateManager.buildPlaybackState(fileData);
        this.receiver.videoPlayer.updateVideoPlayStatus(transferId, state);
        this.receiver.videoPlayer.dispatchPhaseStateChanged(transferId, state);
        continue;
      }

      fileData.partialSnapshotActive = true;
      fileData.sourceAttached = false;
      fileData.sourceVersion = (fileData.sourceVersion || 0) + 1;
      fileData.nextAttachWrittenSize = 0;

      this.logger.info(`[MP4ConnectionHandler] stream interrupted, switch to partial snapshot: id=${transferId}, snapshotSize=${snapshotSize}, written=${fileData.writtenSize}/${offer.size}`);
      await this.receiver.videoPlayer.updateVideoPlayerSource(transferId);
    }
  }

  /**
   * Handle connection recovery
   */
  async handleConnectionRestored() {
    for (const [transferId] of this.receiver.fileOffers.entries()) {
      const fileData = this.receiver.fileChunks.get(transferId);
      if (!fileData || !fileData.partialSnapshotActive) {
        continue;
      }

      fileData.interrupted = false;
      fileData.partialPlayable = false;
      fileData.partialSnapshotActive = false;
      fileData.snapshotSize = 0;
      fileData.sourceAttached = false;
      fileData.sourceVersion = (fileData.sourceVersion || 0) + 1;

      this.logger.info(`[MP4ConnectionHandler] connection restored, switch back to live stream: id=${transferId}`);

      if (fileData.phaseState?.metadataReady && fileData.phaseState?.startupReady) {
        await this.receiver.videoPlayer.updateVideoPlayerSource(transferId);
      }
    }
  }
}
