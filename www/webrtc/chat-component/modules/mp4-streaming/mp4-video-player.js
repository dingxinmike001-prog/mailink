/**
 * MP4 video player module
 * Handles video source updates, playback state management, and media event handling
 */

export class MP4VideoPlayer {
  constructor(receiver) {
    this.receiver = receiver;
    this.logger = receiver.logger;
    this.context = receiver.context;
  }

  /**
   * Bind video component events
   */
  bindVideoComponentEvents(component, transferId) {
    if (!component || component.__mp4ReceiverBound === transferId) {
      return;
    }

    component.__mp4ReceiverBound = transferId;
    component.addEventListener('mp4-media-ready', () => {
      this.handleMediaReadyEvent(transferId);
    });
    component.addEventListener('mp4-media-error', event => {
      this.handleMediaErrorEvent(transferId, event?.detail);
    });
  }

  /**
   * Handle media ready event
   */
  handleMediaReadyEvent(transferId) {
    const fileData = this.receiver.fileChunks.get(transferId);
    if (!fileData) {
      return;
    }

    if (!fileData.phaseState.mediaReady) {
      fileData.phaseState.mediaReady = true;
      const state = this.receiver.stateManager.buildPlaybackState(fileData);
      this.updateVideoPlayStatus(transferId, state);
      this.dispatchPhaseStateChanged(transferId, state);
    }
  }

  /**
   * Handle media error event
   */
  handleMediaErrorEvent(transferId, detail = {}) {
    const fileData = this.receiver.fileChunks.get(transferId);
    if (!fileData) {
      return;
    }

    const errorCode = detail?.code ?? null;
    fileData.lastMediaErrorCode = errorCode;

    if (errorCode === 4 && !fileData.phaseState.mediaReady) {
      fileData.sourceAttached = false;
      fileData.sourceVersion = (fileData.sourceVersion || 0) + 1;
      fileData.nextAttachWrittenSize = Math.min(
        fileData.totalSize || Number.MAX_SAFE_INTEGER,
        (fileData.writtenSize || 0) + (2 * 1024 * 1024)
      );
      this.logger.warn(`[MP4VideoPlayer] media source rejected, will retry later: id=${transferId}, retryAt=${fileData.nextAttachWrittenSize}`);
    }
  }

  /**
   * Dispatch phase state change event
   */
  dispatchPhaseStateChanged(transferId, state) {
    document.dispatchEvent(new CustomEvent('mp4-phase-state-changed', {
      detail: {
        transferId,
        ...state
      }
    }));
  }

  /**
   * Notify video is playable
   */
  notifyVideoPlayable(transferId) {
    const offer = this.receiver.fileOffers.get(transferId);
    if (!offer) return;

    const event = new CustomEvent('mp4-stream-playable', {
      detail: {
        transferId,
        fileName: offer.filename,
        storedFileName: offer.storedFileName,
        port: this.receiver.utilsModule.getHttpPort()
      }
    });
    document.dispatchEvent(event);
  }

  /**
   * Update video player source
   */
  async updateVideoPlayerSource(transferId) {
    const offer = this.receiver.fileOffers.get(transferId);
    if (!offer) return;

    const fileName = offer.storedFileName || offer.filename;
    const port = await this.receiver.utilsModule.getHttpPort();
    const fileData = this.receiver.fileChunks.get(transferId);
    if (fileData) {
      fileData.sourceAttached = true;
      fileData.phaseState.mediaReady = false;
    }
    const playbackState = this.receiver.stateManager.buildPlaybackState(fileData);
    const sourceVersion = fileData?.sourceVersion || 0;
    const streamFormat = offer.mp4Structure?.streamFormat || 'mp4';
    const targetSize = fileData?.partialSnapshotActive && fileData?.snapshotSize > 0
      ? fileData.snapshotSize
      : offer.size;
    const snapshotParams = fileData?.partialSnapshotActive && fileData?.snapshotSize > 0
      ? `&snapshot=1&snapshotSize=${fileData.snapshotSize}`
      : '';
    const userId = this.context.myEmail || '';
    const videoUrl = `http://127.0.0.1:${port}/${userId}/files/recvs/${encodeURIComponent(fileName)}?totalSize=${targetSize}&streamFormat=${encodeURIComponent(streamFormat)}&sourceVersion=${sourceVersion}${snapshotParams}`;

    const component = this.receiver.videoComponents.get(transferId);
    if (component?.setVideoSource) {
      component.setVideoSource(videoUrl);
      component.updatePlayStatus?.(playbackState);
      return;
    }

    const shadowRoot = this.context.shadowRoot;
    if (!shadowRoot) return;

    const videoComponent = shadowRoot.querySelector(`video-file-display[id="${transferId}"], video-file-display[data-transfer-id="${transferId}"]`);
    if (videoComponent?.setVideoSource) {
      videoComponent.setVideoSource(videoUrl);
      videoComponent.updatePlayStatus?.(playbackState);
      return;
    }

    const videoContainer = shadowRoot.querySelector(`#video-container-${transferId}`);
    if (!videoContainer) return;

    const videoEl = videoContainer.querySelector('video');
    if (!videoEl) return;

    if (!videoEl.src || videoEl.src !== videoUrl) {
      videoEl.src = videoUrl;
      videoEl.load();
    }

    const statusEl = videoContainer.querySelector('.stream-status');
    if (statusEl) {
      statusEl.textContent = 'receivedvideoinfo';
      statusEl.classList.remove('playable');
    }
  }

  /**
   * Update video playback state
   */
  updateVideoPlayStatus(transferId, stateOrCanPlay, percent = 0, receivedSize = 0) {
    const state = typeof stateOrCanPlay === 'object' && stateOrCanPlay !== null
      ? stateOrCanPlay
      : {
          metadataReady: !!stateOrCanPlay,
          startupReady: !!stateOrCanPlay,
          mediaReady: !!stateOrCanPlay,
          progress: percent,
          receivedSize
        };

    // Add playable range info to state
    const fileData = this.receiver.fileChunks.get(transferId);
    if (fileData && state.playableRange) {
      // Convert byte range to estimated time range (for UI display)
      const totalSize = fileData.totalSize || 1;
      const duration = fileData.estimatedDuration || 0;
      if (duration > 0) {
        state.playableTimeRange = {
          start: (state.playableRange.start / totalSize) * duration,
          end: (state.playableRange.end / totalSize) * duration
        };
      }
    }

    const component = this.receiver.videoComponents.get(transferId);
    if (component?.updatePlayStatus) {
      component.updatePlayStatus(state);
      return;
    }

    const shadowRoot = this.context.shadowRoot;
    if (!shadowRoot) return;

    const videoComponent = shadowRoot.querySelector(`video-file-display[id="${transferId}"], video-file-display[data-transfer-id="${transferId}"]`);
    if (videoComponent?.updatePlayStatus) {
      videoComponent.updatePlayStatus(state);
      return;
    }

    const videoContainer = shadowRoot.querySelector(`#video-container-${transferId}`);
    if (!videoContainer) return;

    const statusEl = videoContainer.querySelector('.stream-status');
    const progressEl = videoContainer.querySelector('.stream-progress');

    if (statusEl) {
      if (state.mediaReady) {
        // Display playable range info
        if (state.playablePercent && state.playablePercent < 100) {
          statusEl.textContent = `Can play (${state.playablePercent}% draggable)`;
        } else {
          statusEl.textContent = 'Can play';
        }
        statusEl.classList.add('playable');
      } else if (state.startupReady) {
        statusEl.textContent = 'preparefirst frame';
        statusEl.classList.remove('playable');
      } else if (state.metadataReady) {
        statusEl.textContent = 'receivedvideoinfo';
        statusEl.classList.remove('playable');
      } else {
        statusEl.textContent = `Buffering... ${Math.round(state.progress || 0)}%`;
        statusEl.classList.remove('playable');
      }
    }

    if (progressEl) {
      progressEl.style.width = `${Math.min(100, state.progress || 0)}%`;
    }
  }
}
