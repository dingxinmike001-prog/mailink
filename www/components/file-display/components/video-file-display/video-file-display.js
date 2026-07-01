/**
 * Video file display component.
 * Supports progressive MP4 playback status updates.
 */

import { FileDisplayBase } from '../../base/file-display-base.js';

export class VideoFileDisplay extends FileDisplayBase {
  static get componentName() {
    return 'video-file-display';
  }

  static get supportedMimeTypes() {
    return ['video/mp4'];
  }

  render() {
    if (!this._offer) return;

    const { id, filename, size } = this._offer;
    const fileSize = this.formatFileSize(size);
    const isCompleted = this._transferCompleted;
    const statusPresentation = this.getStatusPresentation();
    const statusText = statusPresentation.text;
    const statusClass = statusPresentation.playable ? 'stream-status playable' : 'stream-status';
    const progressDisplay = isCompleted ? 'none' : 'block';
    const completedClass = isCompleted ? 'transfer-completed' : '';
    const defaultPoster = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='225' viewBox='0 0 400 225'%3E%3Crect fill='%23333' width='400' height='225'/%3E%3Ctext fill='%23666' font-family='sans-serif' font-size='20' dy='10.5' font-weight='bold' x='50%25' y='50%25' text-anchor='middle'%3EVideo loading...%3C/text%3E%3C/svg%3E";
    const posterUrl = this._posterUrl || this._pendingPosterUrl || this._offer?.poster || defaultPoster;
    const controlsEnabled = this.canStartPlayback();

    let videoSrc = this._streamingVideoUrl || '';
    if (isCompleted && this._filePath) {
      const folder = this._isSender ? 'sends' : 'recvs';
      const fileName = this._offer.storedFileName || this._offer.filename;
      videoSrc = `http://127.0.0.1:${this._context?.httpServerPort || 8080}/${folder}/${encodeURIComponent(fileName)}?totalSize=${this._offer.size}`;
    }

    // Transmission Information Line Display Control
    const transferInfoDisplay = isCompleted ? 'none' : 'block';
    const transferStatusText = this._isSender ? 'waiting for peer to accept...' : 'request to send file';

    this.shadowRoot.innerHTML = `
      <style>
        ${this.getStyles()}
      </style>
      <div class="streaming-video-message file-request ${completedClass}" id="file-request-${id}">
        <div class="video-container" id="video-container-${id}">
          <video
            ${controlsEnabled ? 'controls' : ''}
            preload="metadata"
            crossorigin="anonymous"
            ${videoSrc ? `src="${videoSrc}"` : ''}
            poster="${posterUrl}"
          >
            <p>Your browser does not support video playback</p>
          </video>
          <div class="video-overlay">
            <span class="${statusClass}">${statusText}</span>
            <span class="file-name" title="${filename}">${filename}</span>
            <span class="file-size">${fileSize}</span>
          </div>
          <div class="stream-progress-container" style="display: ${progressDisplay}">
            <div class="stream-progress" id="stream-progress-${id}" style="width: ${isCompleted ? '100%' : '0%'}"></div>
          </div>
        </div>
        <!-- Transfer info row - Keep consistent with regular files -->
        <div class="transfer-info-row" style="display: ${transferInfoDisplay}">
          <div class="transfer-info-content">
            <span class="transfer-status" id="transfer-status-${id}">${transferStatusText}</span>
            <span class="transfer-progress-text" id="transfer-progress-text-${id}"></span>
          </div>
          <div class="transfer-progress-container">
            <div class="transfer-progress-bar" id="transfer-progress-bar-${id}" style="width: 0%"></div>
          </div>
        </div>
        <div class="file-complete-actions">
          <button class="open-folder-btn" data-file-path="${this._filePath || ''}">open folder</button>
          <button class="save-as-btn" data-file-path="${this._filePath || ''}">save as</button>
        </div>
      </div>
    `;

    this.attachEventListeners();
    this._applyPendingPoster();
    this.syncVideoControls();
  }

  showComplete(filePath) {
    this._transferCompleted = true;
    this._filePath = filePath;

    const fileRequest = this.shadowRoot.querySelector('.file-request');
    if (fileRequest) {
      fileRequest.classList.add('transfer-completed');
    }

    const statusEl = this.shadowRoot.querySelector('.stream-status');
    if (statusEl) {
      statusEl.textContent = 'video received，loading';
      statusEl.classList.remove('playable');
    }

    const progressContainer = this.shadowRoot.querySelector('.stream-progress-container');
    if (progressContainer) {
      progressContainer.style.display = 'none';
    }

    // Hide transmission information line
    const transferInfoRow = this.shadowRoot.querySelector('.transfer-info-row');
    if (transferInfoRow) {
      transferInfoRow.style.display = 'none';
    }

    const actionsContainer = this.shadowRoot.querySelector('.file-complete-actions');
    if (actionsContainer && filePath) {
      const buttons = actionsContainer.querySelectorAll('button');
      buttons.forEach(btn => {
        btn.dataset.filePath = filePath;
      });
    }

    if (filePath && this._offer) {
      const folder = this._isSender ? 'sends' : 'recvs';
      const fileName = this._offer.storedFileName || this._offer.filename;
      const streamFormat = this._offer.mp4Structure?.streamFormat || 'mp4';
      const videoUrl = `http://127.0.0.1:${this._context?.httpServerPort || 8080}/${folder}/${encodeURIComponent(fileName)}?t=${Date.now()}&totalSize=${this._offer.size}&streamFormat=${encodeURIComponent(streamFormat)}`;
      this.setVideoSource(videoUrl);
    }
  }

  setVideoSource(videoUrl) {
    const video = this.shadowRoot.querySelector('video');
    if (!video) {
      this.logger?.warn?.('[VideoFileDisplay] video element not found');
      return;
    }

    this.bindMediaDebugEvents(video);

    if (!video.src || video.src !== videoUrl) {
      this.logger?.info?.(`[VideoFileDisplay] setVideoSource: ${videoUrl}`);
      this._streamingVideoUrl = videoUrl;
      this._playbackState = {
        ...this._playbackState,
        mediaReady: false
      };
      this.syncVideoControls(video);
      this.updatePlayStatus({
        ...this._playbackState,
        mediaReady: false
      });
      video.src = videoUrl;
      video.load();
    }
  }

  bindMediaDebugEvents(video) {
    if (this._mediaDebugBound) {
      return;
    }

    this._mediaDebugBound = true;

    video.addEventListener('loadedmetadata', () => {
      this.logger?.info?.(`[VideoFileDisplay] loadedmetadata duration=${video.duration}`);
      this.updatePlayStatus({
        ...this._playbackState,
        metadataReady: true
      });
      this._adjustVideoSize(video);
      this._updateSeekableRange(video);
    });

    video.addEventListener('durationchange', () => {
      this.logger?.info?.(`[VideoFileDisplay] durationchange duration=${video.duration}`);
      this._updateSeekableRange(video);
    });

    video.addEventListener('loadeddata', () => {
      this.logger?.info?.(`[VideoFileDisplay] loadeddata readyState=${video.readyState}`);
      if (video.readyState >= 2 && !this._posterCaptured) {
        this._captureVideoFrame(video);
      }
      this.updatePlayStatus({
        ...this._playbackState,
        metadataReady: true,
        startupReady: true,
        mediaReady: true
      });
      this.emitMediaReady();
      this._updateSeekableRange(video);
    });

    video.addEventListener('canplay', () => {
      this.logger?.info?.(`[VideoFileDisplay] canplay readyState=${video.readyState}`);
      this.updatePlayStatus({
        ...this._playbackState,
        metadataReady: true,
        startupReady: true,
        mediaReady: true
      });
      this.emitMediaReady();
      this._updateSeekableRange(video);
    });

    video.addEventListener('waiting', () => {
      this.logger?.warn?.('[VideoFileDisplay] waiting');
    });

    video.addEventListener('stalled', () => {
      this.logger?.warn?.('[VideoFileDisplay] stalled');
    });

    video.addEventListener('error', () => {
      const code = video.error?.code;
      this.logger?.error?.(`[VideoFileDisplay] error code=${code}`);
      this._playbackState = {
        ...this._playbackState,
        mediaReady: false
      };
      this.syncVideoControls(video);
      this.dispatchEvent(new CustomEvent('mp4-media-error', {
        detail: {
          transferId: this._offer?.id,
          code
        },
        bubbles: true,
        composed: true
      }));
    });

    // Handle seeking event and limit drag range
    video.addEventListener('seeking', (e) => {
      this._handleSeeking(video, e);
    });

    // Listen for progress updates, used to update the draggable range indicator
    video.addEventListener('progress', () => {
      this._updateSeekableRange(video);
    });
  }

  /**
   * Handle the seeking event, restricting dragging to the received range
   * @param {HTMLVideoElement} video - Video element
   * @param {Event} event - Seeking event
   */
  _handleSeeking(video, event) {
    // If the transfer is complete, allow free dragging
    if (this._transferCompleted) {
      return;
    }

    // Get the current playable range
    const buffered = video.buffered;
    if (!buffered || buffered.length === 0) {
      return;
    }

    // Find the buffer range that contains the current time
    let currentBufferedEnd = 0;
    for (let i = 0; i < buffered.length; i++) {
      if (video.currentTime >= buffered.start(i) && video.currentTime <= buffered.end(i)) {
        currentBufferedEnd = buffered.end(i);
        break;
      }
    }

    // If the corresponding buffer range is not found, it means the drag has moved to an unbuffered area
    if (currentBufferedEnd === 0) {
      // Find the nearest buffered position
      let nearestBufferedTime = 0;
      for (let i = 0; i < buffered.length; i++) {
        if (buffered.start(i) <= video.currentTime) {
          nearestBufferedTime = buffered.end(i);
        }
      }

      // If the dragged position goes beyond the buffered range, reset it to the nearest buffered position
      if (video.currentTime > nearestBufferedTime) {
        this.logger?.warn?.(`[VideoFileDisplay] seeking blocked: ${video.currentTime.toFixed(2)}s > ${nearestBufferedTime.toFixed(2)}s (buffered)`);
        video.currentTime = Math.max(0, nearestBufferedTime - 0.1);
        event.preventDefault?.();
      }
    }
  }

  /**
   * Update draggable range indicator
   * @param {HTMLVideoElement} video - Video element
   */
  _updateSeekableRange(video) {
    if (this._transferCompleted) {
      this._hideSeekableIndicator();
      return;
    }

    const buffered = video.buffered;
    if (!buffered || buffered.length === 0) {
      return;
    }

    // Get total buffer duration
    let totalBuffered = 0;
    for (let i = 0; i < buffered.length; i++) {
      totalBuffered += buffered.end(i) - buffered.start(i);
    }

    // Update playable range indicator
    this._showSeekableIndicator(video, totalBuffered);
  }

  /**
   * Show playable range indicator
   * @param {HTMLVideoElement} video - Video element
   * @param {number} bufferedSeconds - Number of seconds buffered
   */
  _showSeekableIndicator(video, bufferedSeconds) {
    // Create or update the playable range indicator
    let indicator = this.shadowRoot.querySelector('.seekable-range-indicator');
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.className = 'seekable-range-indicator';
      const videoContainer = this.shadowRoot.querySelector('.video-container');
      if (videoContainer) {
        videoContainer.appendChild(indicator);
      }
    }

    const duration = video.duration || 0;
    if (duration > 0) {
      const percent = Math.min(100, (bufferedSeconds / duration) * 100);
      indicator.style.width = `${percent}%`;
      indicator.style.display = 'block';
      
      // Update status text
      const statusEl = this.shadowRoot.querySelector('.stream-status');
      if (statusEl && !this._transferCompleted) {
        const currentText = statusEl.textContent;
        if (currentText.includes('can play') && bufferedSeconds > 0) {
          statusEl.textContent = `can play (Buffered ${Math.round(bufferedSeconds)}second(s))`;
        }
      }
    }
  }

  /**
   * Hide the playable range indicator
   */
  _hideSeekableIndicator() {
    const indicator = this.shadowRoot.querySelector('.seekable-range-indicator');
    if (indicator) {
      indicator.style.display = 'none';
    }
  }

  emitMediaReady() {
    this.dispatchEvent(new CustomEvent('mp4-media-ready', {
      detail: {
        transferId: this._offer?.id
      },
      bubbles: true,
      composed: true
    }));
  }

  canStartPlayback() {
    return !!this._playbackState?.mediaReady;
  }

  syncVideoControls(video = this.shadowRoot?.querySelector('video')) {
    if (!video) {
      return;
    }

    const controlsEnabled = this.canStartPlayback();
    video.controls = controlsEnabled;
    video.tabIndex = controlsEnabled ? 0 : -1;
    video.style.pointerEvents = controlsEnabled ? 'auto' : 'none';
    video.setAttribute('aria-disabled', controlsEnabled ? 'false' : 'true');

    if (!controlsEnabled && !video.paused) {
      video.pause();
    }
  }

  setInitialProgress(receivedSize, totalSize, isInterrupted = true) {
    if (this._transferCompleted) {
      return;
    }

    const percent = totalSize > 0 ? Math.min(100, (receivedSize / totalSize) * 100) : 0;
    const statusEl = this.shadowRoot.querySelector('.stream-status');
    const progressEl = this.shadowRoot.querySelector('.stream-progress');
    const progressContainer = this.shadowRoot.querySelector('.stream-progress-container');
    const actionText = this._isSender ? 'sent' : 'received';

    if (statusEl) {
      if (isInterrupted) {
        statusEl.textContent = `transfer interrupted(${actionText} ${this.formatFileSize(receivedSize)} / ${this.formatFileSize(totalSize)})`;
      } else {
        const bufferingText = this._isSender ? 'sending' : 'Buffering';
        statusEl.textContent = `${bufferingText}... ${Math.round(percent)}%`;
      }
      statusEl.classList.remove('playable');
    }

    if (progressEl) {
      progressEl.style.width = `${percent}%`;
    }

    if (progressContainer) {
      progressContainer.style.display = 'block';
    }

    // Update external transfer information row - consistent with regular files
    this._updateTransferInfoRow(percent, receivedSize, totalSize, isInterrupted);
  }

  /**
   * Update transmission info line - reuse the transmission progress display logic for regular files
   */
  _updateTransferInfoRow(progress, receivedSize, totalSize, isInterrupted = false) {
    const id = this._offer?.id;
    if (!id) return;

    const transferInfoRow = this.shadowRoot.querySelector('.transfer-info-row');
    const transferStatus = this.shadowRoot.querySelector(`#transfer-status-${id}`);
    const transferProgressText = this.shadowRoot.querySelector(`#transfer-progress-text-${id}`);
    const transferProgressBar = this.shadowRoot.querySelector(`#transfer-progress-bar-${id}`);

    if (transferInfoRow) {
      transferInfoRow.style.display = 'block';
    }

    if (transferProgressBar) {
      transferProgressBar.style.width = `${progress}%`;
    }

    if (transferStatus) {
      const actionText = this._isSender ? 'sent' : 'received';
      const continueText = this._isSender ? 'Resumable transfer: can be resent' : 'Ask sender to resend for resumable transfer';

      if (isInterrupted) {
        transferStatus.innerHTML = `transfer interrupted(${actionText} ${this.formatFileSize(receivedSize)} / ${this.formatFileSize(totalSize)})<br>${continueText}`;
      } else if (progress >= 100) {
        transferStatus.textContent = 'Transfer complete';
      } else {
        transferStatus.textContent = `transferring... ${this.formatFileSize(receivedSize)} / ${this.formatFileSize(totalSize)}`;
      }
    }

    if (transferProgressText) {
      transferProgressText.textContent = progress >= 100 ? '' : `${Math.round(progress)}%`;
    }
  }

  /**
   * Update transfer progress - for external calls, consistent with regular files
   */
  updateTransferProgress(progress, receivedSize, totalSize, transferSpeed) {
    if (this._transferCompleted) {
      return;
    }

    this._updateTransferInfoRow(progress, receivedSize, totalSize, false);
  }

  /**
   * Display transmission interrupt status - consistent with ordinary files
   */
  showTransferInterrupted(receivedSize, totalSize) {
    if (this._transferCompleted) {
      return;
    }

    const progress = totalSize > 0 ? Math.min(100, Math.round((receivedSize / totalSize) * 100)) : 0;
    this._updateTransferInfoRow(progress, receivedSize, totalSize, true);
  }

  updatePlayStatus(stateOrCanPlay, percent = 0) {
    const statusEl = this.shadowRoot.querySelector('.stream-status');
    const progressEl = this.shadowRoot.querySelector('.stream-progress');
    const progressContainer = this.shadowRoot.querySelector('.stream-progress-container');

    let state;
    if (typeof stateOrCanPlay === 'object' && stateOrCanPlay !== null) {
      state = {
        metadataReady: false,
        startupReady: false,
        mediaReady: false,
        progress: 0,
        ...stateOrCanPlay
      };
    } else {
      state = {
        metadataReady: !!stateOrCanPlay,
        startupReady: !!stateOrCanPlay,
        mediaReady: !!stateOrCanPlay,
        progress: percent
      };
    }

    this._playbackState = state;
    this.syncVideoControls();

    const statusPresentation = this.getStatusPresentation(state);
    if (statusEl) {
      statusEl.textContent = statusPresentation.text;
      statusEl.classList.toggle('playable', !!statusPresentation.playable);
    }

    if (progressEl) {
      progressEl.style.width = `${Math.min(100, state.progress || 0)}%`;
    }

    if (progressContainer) {
      progressContainer.style.display = this._transferCompleted ? 'none' : 'block';
    }
  }

  getStatusPresentation(state = this._playbackState) {
    const normalizedState = {
      metadataReady: false,
      startupReady: false,
      mediaReady: false,
      interrupted: false,
      partialPlayable: false,
      snapshotSize: 0,
      totalSize: this._offer?.size || 0,
      progress: 0,
      ...state
    };

    if (normalizedState.interrupted && normalizedState.partialPlayable) {
      const receivedText = normalizedState.snapshotSize && normalizedState.totalSize
        ? ` (${this.formatFileSize(normalizedState.snapshotSize)} / ${this.formatFileSize(normalizedState.totalSize)})`
        : '';
      return {
        text: `disconnected，Playable received portion${receivedText}`,
        playable: true
      };
    }

    if (normalizedState.interrupted) {
      return {
        text: `disconnected，received ${Math.round(normalizedState.progress || 0)}%`,
        playable: false
      };
    }

    if (normalizedState.mediaReady) {
      return {
        text: 'can play',
        playable: true
      };
    }

    if (normalizedState.startupReady) {
      return {
        text: 'Preparing first frame',
        playable: false
      };
    }

    if (normalizedState.metadataReady) {
      return {
        text: 'Video info received',
        playable: false
      };
    }

    if (this._transferCompleted) {
      return {
        text: 'video received，loading',
        playable: false
      };
    }

    return {
      text: this._isSender ? 'Waiting to send...' : 'Waiting to receive data...',
      playable: false
    };
  }

  setPoster(posterUrl) {
    this._posterUrl = posterUrl;
    this._posterCaptured = true;

    const video = this.shadowRoot.querySelector('video');
    if (video) {
      video.poster = posterUrl;
      this.logger?.info?.(`[VideoFileDisplay] set poster: ${posterUrl.substring(0, 50)}...`);
    } else {
      this._pendingPosterUrl = posterUrl;
      this.logger?.info?.(`[VideoFileDisplay] cache poster for later: ${posterUrl.substring(0, 50)}...`);
    }
  }

  _applyPendingPoster() {
    if (!this._pendingPosterUrl) {
      return;
    }

    const video = this.shadowRoot.querySelector('video');
    if (video) {
      video.poster = this._pendingPosterUrl;
      this.logger?.info?.(`[VideoFileDisplay] apply cached poster: ${this._pendingPosterUrl.substring(0, 50)}...`);
      this._pendingPosterUrl = null;
    }
  }

  attachEventListeners() {
    this.shadowRoot.querySelectorAll('.open-folder-btn, .save-as-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        const filePath = e.target.dataset.filePath;
        const action = e.target.classList.contains('open-folder-btn') ? 'open-folder' : 'save-as';
        this.dispatchEvent(new CustomEvent('file-action', {
          detail: { filePath, action },
          bubbles: true,
          composed: true
        }));
      });
    });

    const fileRequest = this.shadowRoot.querySelector('.file-request');
    if (fileRequest) {
      fileRequest.addEventListener('contextmenu', e => {
        this.showContextMenu(e);
      });
    }

    const video = this.shadowRoot.querySelector('video');
    if (video) {
      this.bindMediaDebugEvents(video);

      video.addEventListener('play', () => {
        if (!this.canStartPlayback()) {
          this.logger?.warn?.('[VideoFileDisplay] play blocked until media is ready');
          video.pause();
          return;
        }
        this.logger?.info?.('[VideoFileDisplay] play');
        const videoOverlay = this.shadowRoot.querySelector('.video-overlay');
        if (videoOverlay) {
          videoOverlay.style.display = 'none';
        }
      });

      video.addEventListener('pause', () => {
        this.logger?.info?.('[VideoFileDisplay] pause');
      });

      video.addEventListener('ended', () => {
        this.logger?.info?.('[VideoFileDisplay] ended');
      });
    }
  }

  _adjustVideoSize(video) {
    const maxWidth = 400;
    const maxHeight = 300;
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;

    if (!videoWidth || !videoHeight) {
      return;
    }

    const aspectRatio = videoWidth / videoHeight;
    let displayWidth;
    let displayHeight;
    const widthBasedHeight = maxWidth / aspectRatio;
    const heightBasedWidth = maxHeight * aspectRatio;

    if (widthBasedHeight <= maxHeight) {
      displayWidth = maxWidth;
      displayHeight = widthBasedHeight;
    } else {
      displayWidth = heightBasedWidth;
      displayHeight = maxHeight;
    }

    if (videoWidth <= maxWidth && videoHeight <= maxHeight) {
      displayWidth = videoWidth;
      displayHeight = videoHeight;
    }

    video.style.width = `${displayWidth}px`;
    video.style.height = `${displayHeight}px`;

    this.logger?.info?.(`[VideoFileDisplay] resize ${videoWidth}x${videoHeight} -> ${displayWidth.toFixed(0)}x${displayHeight.toFixed(0)}`);
  }

  _captureVideoFrame(video) {
    try {
      if (video.readyState < 2) {
        this.logger?.warn?.(`[VideoFileDisplay] frame capture skipped, readyState=${video.readyState}`);
        return;
      }

      const seekTime = Math.min(0.5, (video.duration || 0) * 0.1);
      if (video.currentTime === 0 && seekTime > 0) {
        this.logger?.info?.(`[VideoFileDisplay] seek to ${seekTime}s for poster capture`);
        const onSeeked = () => {
          video.removeEventListener('seeked', onSeeked);
          this._doCaptureFrame(video);
        };
        video.addEventListener('seeked', onSeeked);
        video.currentTime = seekTime;
      } else {
        this._doCaptureFrame(video);
      }
    } catch (error) {
      this.logger?.warn?.('[VideoFileDisplay] capture frame failed', error);
    }
  }

  _doCaptureFrame(video) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 400;
      canvas.height = video.videoHeight || 225;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      
      this._processFrameWithWorker(imageData, canvas, video);
    } catch (error) {
      this.logger?.warn?.('[VideoFileDisplay] capture frame failed', error);
    }
  }

  _processFrameWithWorker(imageData, canvas, video) {
    if (typeof Worker === 'undefined') {
      this._fallbackProcessFrame(imageData, canvas, video);
      return;
    }

    try {
      if (!this._frameWorker) {
        this._frameWorker = new Worker(new URL('./video-frame-worker.js', import.meta.url));
      }

      this._frameWorker.onmessage = (e) => {
        if (e.data.success) {
          if (e.data.isBlack) {
            this.logger?.warn?.('[VideoFileDisplay] captured frame is black, skip poster update');
            return;
          }
          const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
          video.poster = dataUrl;
          this.logger?.info?.(`[VideoFileDisplay] poster captured at ${video.currentTime}s`);
        } else {
          this.logger?.warn?.('[VideoFileDisplay] worker frame processing failed', e.data.error);
          this._fallbackProcessFrame(imageData, canvas, video);
        }
      };

      this._frameWorker.onerror = (error) => {
        this.logger?.warn?.('[VideoFileDisplay] worker error', error);
        this._fallbackProcessFrame(imageData, canvas, video);
      };

      this._frameWorker.postMessage({
        action: 'processFrame',
        imageData: imageData.data,
        width: imageData.width,
        height: imageData.height
      }, [imageData.data.buffer]);
    } catch (error) {
      this.logger?.warn?.('[VideoFileDisplay] worker init failed, using fallback', error);
      this._fallbackProcessFrame(imageData, canvas, video);
    }
  }

  _fallbackProcessFrame(imageData, canvas, video) {
    try {
      const data = imageData.data;
      let isBlack = true;

      for (let i = 0; i < Math.min(data.length, 4000); i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (r > 10 || g > 10 || b > 10) {
          isBlack = false;
          break;
        }
      }

      if (isBlack) {
        this.logger?.warn?.('[VideoFileDisplay] captured frame is black, skip poster update');
        return;
      }

      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      video.poster = dataUrl;
      this.logger?.info?.(`[VideoFileDisplay] poster captured at ${video.currentTime}s`);
    } catch (error) {
      this.logger?.warn?.('[VideoFileDisplay] fallback frame processing failed', error);
    }
  }

  disconnectedCallback() {
    if (this._frameWorker) {
      this._frameWorker.terminate();
      this._frameWorker = null;
    }
  }

  getStyles() {
    return `
      :host {
        display: block;
      }
      .streaming-video-message {
        margin: 8px 0;
        border-radius: 12px;
        overflow: hidden;
        background: #1a1a1a;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      }
      .video-container {
        position: relative;
        display: inline-block;
      }
      video {
        display: block;
        border-radius: 8px;
        max-width: 400px;
        max-height: 300px;
      }
      .video-overlay {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        padding: 12px;
        background: linear-gradient(rgba(0,0,0,0.8), transparent);
        color: white;
        font-size: 12px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        pointer-events: none;
      }
      .stream-status {
        font-weight: 600;
        color: #ffc107;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .stream-status::before {
        content: '';
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #ffc107;
        animation: pulse 1.5s infinite;
      }
      .stream-status.playable {
        color: #4caf50;
      }
      .stream-status.playable::before {
        background: #4caf50;
        animation: none;
      }
      @keyframes pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.5; transform: scale(0.8); }
      }
      .file-name {
        font-size: 11px;
        opacity: 0.9;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .file-size {
        font-size: 10px;
        opacity: 0.7;
      }
      .stream-progress-container {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 3px;
        background: rgba(255,255,255,0.2);
      }
      .stream-progress {
        height: 100%;
        background: linear-gradient(90deg, #4caf50, #8bc34a);
        transition: width 0.3s ease;
        box-shadow: 0 0 4px rgba(76, 175, 80, 0.5);
      }
      .file-complete-actions {
        display: none;
      }
      .open-folder-btn, .save-as-btn {
        padding: 6px 12px;
        font-size: 12px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        color: white;
        transition: background 0.2s ease;
      }
      .open-folder-btn {
        background: #4caf50;
      }
      .open-folder-btn:hover {
        background: #45a049;
      }
      .save-as-btn {
        background: #2196f3;
      }
      .save-as-btn:hover {
        background: #1976d2;
      }
      /* Transfer info row style - consistent with normal files */
      .transfer-info-row {
        padding: 8px 12px;
        background: #f5f5f5;
        border-top: 1px solid #e0e0e0;
      }
      .transfer-info-content {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 12px;
        color: #666;
        margin-bottom: 4px;
      }
      .transfer-status {
        color: #2196F3;
      }
      .transfer-progress-text {
        color: #666;
        font-weight: 500;
      }
      .transfer-progress-container {
        width: 100%;
        height: 4px;
        background: #e0e0e0;
        border-radius: 2px;
        overflow: hidden;
      }
      .transfer-progress-bar {
        height: 100%;
        background: linear-gradient(90deg, #4CAF50, #8BC34A);
        transition: width 0.3s ease;
      }
      /* Playable range indicator */
      .seekable-range-indicator {
        position: absolute;
        bottom: 0;
        left: 0;
        height: 4px;
        background: linear-gradient(90deg, rgba(76, 175, 80, 0.6), rgba(139, 195, 74, 0.6));
        pointer-events: none;
        z-index: 10;
        transition: width 0.3s ease;
      }
      /* Video control bar style optimization */
      video::-webkit-media-controls-timeline {
        background: linear-gradient(to right, 
          rgba(76, 175, 80, 0.3) 0%, 
          rgba(76, 175, 80, 0.3) var(--seekable-percent, 0%), 
          rgba(255, 255, 255, 0.2) var(--seekable-percent, 0%), 
          rgba(255, 255, 255, 0.2) 100%
        );
      }
    `;
  }
}

customElements.define(VideoFileDisplay.componentName, VideoFileDisplay);
