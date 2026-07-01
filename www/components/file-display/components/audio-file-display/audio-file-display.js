/**
 * Audio file display component.
 * Supports audio playback with HTML5 <audio> tag.
 *
 * Note: audio files display as normal file style before receive completes, audio player shown only after receive completes
 * reuse normal file rendering logic by inheriting NormalFileDisplay
 */

import { NormalFileDisplay } from '../normal-file-display/normal-file-display.js';

export class AudioFileDisplay extends NormalFileDisplay {
  static get componentName() {
    return 'audio-file-display';
  }

  static get supportedMimeTypes() {
    return ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/mp3', 'audio/mp4', 'audio/x-m4a'];
  }

  /**
   * Override render method:
   * - before receive completes: call parent render method (normal file style)
   * - after receive completes: show audio player
   */
  render() {
    if (!this._offer) {
      this.logger?.info?.('[AudioFileDisplay] render: _offer is empty，skip rendering');
      return;
    }

    const isCompleted = this._transferCompleted;

    if (!isCompleted) {
      // Before receive completes: reuse normal file rendering logic
      // But use audio icon 🎵 instead of the default icon
      this._renderAsNormalFile();
    } else {
      // After receive completes: show audio player
      this._renderAsAudioPlayer();
    }

    this.attachEventListeners();
  }

  /**
   * render as normal file style (before receive completes)
   * Reuse parent HTML structure, but use audio icon
   */
  _renderAsNormalFile() {
    const { id, filename, size, mimeType } = this._offer;
    const fileSize = this.formatFileSize(size);
    const statusText = this._isSender ? 'waiting for peer to accept...' : 'request to send file';
    const completedClass = '';
    const storedFileName = this._offer.storedFileName ||
                          this._offer.path?.split(/[\\/]/).pop() ||
                          filename;

    // Use the same HTML structure as the normal file component, but specify the audio icon
    this.shadowRoot.innerHTML = `
      <style>
        ${this._getNormalFileStyles()}
      </style>
      <div class="file-request ${completedClass}" id="file-request-${id}"
           data-mime-type="${mimeType}"
           data-file-size="${size}"
           data-stored-filename="${storedFileName}"
           data-file-path="${this._filePath || ''}">
        <div class="file-info">
          <span class="file-icon">🎵</span>
          <div class="file-details">
            <div class="file-name" title="${filename}">${filename}</div>
            <div class="file-meta">
              <span class="file-size">${fileSize}</span>
              <span class="file-status" id="status-${id}">${statusText}</span>
            </div>
          </div>
        </div>
        <div class="progress-container">
          <div class="progress-bar" id="progress-${id}" style="width: 0%">0%</div>
        </div>
        ${!this._isSender ? `
          <div class="file-actions">
            <button class="accept-btn" data-transfer-id="${id}">accept</button>
            <button class="reject-btn" data-transfer-id="${id}">reject</button>
          </div>
        ` : ''}
        <div class="file-complete-actions">
          <button class="open-folder-btn" data-file-path="${this._filePath || ''}">open folder</button>
          <button class="save-as-btn" data-file-path="${this._filePath || ''}">save as</button>
        </div>
      </div>
    `;
  }

  /**
   * render as audio player style (after receive completes)
   */
  _renderAsAudioPlayer() {
    const { id, filename, size, mimeType } = this._offer;
    const fileSize = this.formatFileSize(size);
    const completedClass = 'transfer-completed';

    // Determine audio MIME type
    let audioMimeType = mimeType || 'audio/mpeg';
    if (filename.toLowerCase().endsWith('.mp3') && !mimeType) {
      audioMimeType = 'audio/mpeg';
    } else if (filename.toLowerCase().endsWith('.ogg') && !mimeType) {
      audioMimeType = 'audio/ogg';
    } else if (filename.toLowerCase().endsWith('.m4a') && !mimeType) {
      audioMimeType = 'audio/mp4';
    }

    // Build audio source URL
    let audioSrc = '';
    if (this._filePath) {
      const folder = this._isSender ? 'sends' : 'recvs';
      const fileName = this._offer.storedFileName || this._offer.filename;
      audioSrc = `http://127.0.0.1:${this._context?.httpServerPort || 8080}/${folder}/${encodeURIComponent(fileName)}`;
    }

    this.shadowRoot.innerHTML = `
      <style>
        ${this._getAudioPlayerStyles()}
      </style>
      <div class="audio-message file-request ${completedClass}" id="file-request-${id}">
        <div class="audio-container">
          <div class="audio-info">
            <span class="file-icon">🎵</span>
            <div class="file-details">
              <div class="file-name" title="${filename}">${filename}</div>
              <div class="file-meta">
                <span class="file-size">${fileSize}</span>
              </div>
            </div>
          </div>
          <div class="audio-player-container">
            <audio
              controls
              preload="metadata"
              crossorigin="anonymous"
            >
              <source src="${audioSrc}" type="${audioMimeType}">
              <p>your browser does not support audio playback</p>
            </audio>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * style used before receive completes (reuse normal file style)
   */
  _getNormalFileStyles() {
    // Reuse the parent class's styles
    return super.getStyles();
  }

  /**
   * style used after receive completes (audio player style)
   */
  _getAudioPlayerStyles() {
    return `
      :host {
        display: block;
      }
      .audio-message {
        margin: 8px 0;
        padding: 12px;
        border-radius: 12px;
        background: #f5f5f5;
        box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        max-width: 400px;
      }
      .audio-message.transfer-completed {
        cursor: pointer;
      }
      .audio-message.transfer-completed:hover {
        background: #ebebeb;
      }
      .audio-container {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .audio-info {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .file-icon {
        font-size: 24px;
        flex-shrink: 0;
      }
      .file-details {
        flex: 1;
        min-width: 0;
      }
      .file-name {
        font-size: 14px;
        font-weight: 500;
        color: #333;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .file-meta {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-top: 4px;
        font-size: 12px;
        color: #666;
      }
      .file-size {
        font-size: 12px;
        color: #666;
        white-space: nowrap;
      }
      .audio-player-container {
        width: 100%;
      }
      audio {
        width: 100%;
        height: 40px;
        border-radius: 20px;
      }
      audio::-webkit-media-controls-panel {
        background: #e3f2fd;
      }
    `;
  }

  /**
   * override showComplete: switch to audio player display after receive completes
   */
  showComplete(filePath) {
    this._transferCompleted = true;
    this._filePath = filePath;

    this.logger?.info?.(`[AudioFileDisplay] showComplete: switch to audio player display, filePath=${filePath}`);

    // Re-render the entire component and switch to audio player display mode
    this.render();

    // Bind audio events
    const audio = this.shadowRoot?.querySelector('audio');
    if (audio) {
      this._bindAudioEvents(audio);
    }
  }

  /**
   * Bind audio player events
   */
  _bindAudioEvents(audio) {
    audio.addEventListener('loadedmetadata', () => {
      this.logger?.info?.(`[AudioFileDisplay] loadedmetadata duration=${audio.duration}`);
    });

    audio.addEventListener('loadeddata', () => {
      this.logger?.info?.(`[AudioFileDisplay] loadeddata readyState=${audio.readyState}`);
    });

    audio.addEventListener('canplay', () => {
      this.logger?.info?.(`[AudioFileDisplay] canplay readyState=${audio.readyState}`);
    });

    audio.addEventListener('error', () => {
      const code = audio.error?.code;
      this.logger?.error?.(`[AudioFileDisplay] error code=${code}`);
    });

    audio.addEventListener('play', () => {
      this.logger?.info?.('[AudioFileDisplay] play');
    });

    audio.addEventListener('pause', () => {
      this.logger?.info?.('[AudioFileDisplay] pause');
    });

    audio.addEventListener('ended', () => {
      this.logger?.info?.('[AudioFileDisplay] ended');
    });
  }

  /**
   * Override attachEventListeners: reuse the parent class's event listeners and add audio event bindings
   */
  attachEventListeners() {
    // Reuse the parent class's event listeners (Accept/Reject buttons, Open Folder/Save As buttons, right-click menu, etc.)
    super.attachEventListeners();

    // If currently in audio player mode, bind audio events
    const audio = this.shadowRoot?.querySelector('audio');
    if (audio) {
      this._bindAudioEvents(audio);
    }
  }

  /**
   * Icon for the audio file (shows 🎵 before download is complete)
   */
  getFileIcon() {
    return '🎵';
  }
}

customElements.define(AudioFileDisplay.componentName, AudioFileDisplay);
