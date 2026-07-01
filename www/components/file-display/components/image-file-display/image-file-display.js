import { FileDisplayBase } from '../../base/file-display-base.js';
import { getThumbnailFileName, deriveThumbnailUrl } from '../../../../utils/thumbnail-utils.js';

export class ImageFileDisplay extends FileDisplayBase {
  static get componentName() {
    return 'image-file-display';
  }

  static get supportedMimeTypes() {
    return [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/bmp',
      'image/svg+xml'
    ];
  }

  constructor() {
    super();
    this._retryCount = 0;
    this._maxRetries = 3;
    this._retryDelay = 800;
    this._imageUrl = null;
    this._thumbnailUrl = null;
    this._initialLoadDelay = 500;
  }

  async render() {
    if (!this._offer) return;

    const { id, filename, size } = this._offer;
    
    // Prefer using storedFileName; if it is empty, then use filename
    let fileName = this._offer.storedFileName || filename;
    
    // If storedFileName is empty and there is a filePath, try to extract the actual file name from the filePath
    // But only use it when the extracted filename looks like a valid filename (including the extension)
    if (!this._offer.storedFileName && this._filePath) {
      const pathParts = this._filePath.split(/[\\/]/);
      const actualFileName = pathParts[pathParts.length - 1];
      // Fix: Check whether the extracted file name is valid (not empty, not a directory name, contains an extension)
      if (actualFileName && actualFileName !== '' && actualFileName.includes('.') && actualFileName !== filename) {
        fileName = actualFileName;
        this.logger?.info?.('[ImageFileDisplay] From filePath Extract filename:', actualFileName);
      }
    }

    this.logger?.info?.('[ImageFileDisplay] render:', {
      id,
      filename,
      storedFileName: this._offer.storedFileName,
      isSender: this._isSender,
      fileName,
      filePath: this._filePath,
      username: this._context?.myEmail
    });

    try {
      const imageUrl = await this.getFileUrl(fileName, this._isSender);
      this._imageUrl = imageUrl;

      const thumbnailFileName = getThumbnailFileName(fileName);
      this._thumbnailUrl = await this.getFileUrl(thumbnailFileName, this._isSender);

      this.logger?.info?.('[ImageFileDisplay] imageUrl:', imageUrl, 'thumbnailUrl:', this._thumbnailUrl);
      const fileSize = this.formatFileSize(size);

      const senderEmail = this._isSender ? this._context?.myEmail : this._context?.targetEmail;
      const receiverEmail = this._isSender ? this._context?.targetEmail : this._context?.myEmail;
      const fileInfo = `${window.i18n?.t ? window.i18n.t('fileInfo.filename') : 'filename'}: ${filename}\n${window.i18n?.t ? window.i18n.t('fileInfo.size') : 'size'}: ${fileSize}\n${window.i18n?.t ? window.i18n.t('fileInfo.sender') : 'Sender'}: ${senderEmail}\n${window.i18n?.t ? window.i18n.t('fileInfo.receiver') : 'Recipient'}: ${receiverEmail}\n${window.i18n?.t ? window.i18n.t('fileInfo.transferMethod') : 'Transfer method'}: WebRTC`;

      const isCompleted = this._transferCompleted;
      const statusText = isCompleted
        ? ''
        : (this._isSender ? (window.i18n?.t ? window.i18n.t('chat.sending') : 'sending...') : (window.i18n?.t ? window.i18n.t('chat.requestSendImage') : 'Request to send image'));
      const progressDisplay = isCompleted ? 'none' : 'block';
      const completedClass = isCompleted ? 'transfer-completed' : '';
      const statusDisplay = isCompleted ? 'none' : 'inline';

      const imgSrc = this._thumbnailUrl || imageUrl;
      const originalSrcAttr = this._thumbnailUrl ? `data-original-src="${imageUrl}"` : '';

      this.shadowRoot.innerHTML = `
        <style>
          ${this.getStyles()}
        </style>
        <div class="image-message file-request ${completedClass}" id="file-request-${id}"
             data-stored-filename="${fileName}"
             ${this._filePath ? `data-file-path="${this._filePath}"` : ''}>
          <img src=""
               alt="${fileName}"
               title="${fileInfo.replace(/\n/g, ' | ')}"
               data-retry-count="0"
               data-pending-url="${imgSrc}"
               ${originalSrcAttr}>
          <div class="image-error" style="display: none;">
            <span class="error-icon">🖼️</span>
            <span class="error-text">${window.i18n?.t ? window.i18n.t('chat.imageLoadFailed') : 'failed to load image'}</span>
            <span class="error-retry">${window.i18n?.t ? window.i18n.t('common.retry') : 'Click to retry'}</span>
          </div>
          <div class="image-status">
            <span class="file-status" id="status-${id}" style="display: ${statusDisplay}">${statusText}</span>
          </div>
          <div class="progress-container" style="display: ${progressDisplay}">
            <div class="progress-bar" id="progress-${id}" style="width: 0%">0%</div>
          </div>
          <div class="file-complete-actions">
          <button class="open-folder-btn" data-file-path="">${window.i18n?.t ? window.i18n.t('common.openFolder') : 'open folder'}</button>
          <button class="save-as-btn" data-file-path="">${window.i18n?.t ? window.i18n.t('common.saveAs') : 'save as'}</button>
        </div>
        </div>
      `;

      this.attachEventListeners();
      this._setupImageErrorHandler();
      
      setTimeout(() => {
        const img = this.shadowRoot.querySelector('img');
        if (img && img.dataset.pendingUrl) {
          this.logger?.debug?.(`[ImageFileDisplay] Initial image load: ${this._offer?.id}`);
          img.src = img.dataset.pendingUrl;
        }
      }, this._initialLoadDelay);
    } catch (error) {
      this.logger.error?.('[ImageFileDisplay] Render failed:', error);
    }
  }

  _setupImageErrorHandler() {
    const img = this.shadowRoot.querySelector('img');
    const errorDiv = this.shadowRoot.querySelector('.image-error');
    
    if (!img) return;

    img.addEventListener('error', async (e) => {
      if (!img.src || img.src === window.location.href) {
        return;
      }

      const originalSrc = img.dataset.originalSrc;
      if (originalSrc && img.src !== originalSrc && !img._fallbackAttempted) {
        img._fallbackAttempted = true;
        this.logger?.info?.(`[ImageFileDisplay] Thumbnail load failed，Fallback to original image: ${this._offer?.id}`);
        img.src = originalSrc;
        return;
      }

      const retryCount = parseInt(img.dataset.retryCount || '0');
      const errorType = this._getImageErrorType(e, img);
      
      if (retryCount < this._maxRetries) {
        this.logger?.debug?.(`[ImageFileDisplay] failed to load image，Preparing to retry: ${this._offer?.id}, error type: ${errorType}, Retry count: ${retryCount + 1}/${this._maxRetries}`);
      } else {
        this.logger?.error?.(`[ImageFileDisplay] failed to load image: ${this._offer?.id}, error type: ${errorType}, maximum retry count reached`);
      }

      if (retryCount < this._maxRetries) {
        img.dataset.retryCount = String(retryCount + 1);
        
        await new Promise(resolve => setTimeout(resolve, this._retryDelay));
        
        const retryUrl = img.dataset.originalSrc || this._imageUrl;
        if (retryUrl) {
          const newUrl = `${retryUrl.split('?')[0]}?t=${Date.now()}&retry=${retryCount + 1}`;
          this.logger?.debug?.(`[ImageFileDisplay] reload image: ${this._offer?.id}`);
          img.src = newUrl;
        }
      } else {
        img.style.display = 'none';
        if (errorDiv) {
          errorDiv.style.display = 'flex';
        }
        this.logger?.error?.(`[ImageFileDisplay] Image load ultimately failed: ${this._offer?.id}`);
      }
    });

    img.addEventListener('load', () => {
      this.logger?.info?.(`[ImageFileDisplay] Image loaded successfully: ${this._offer?.id}`);
      img.style.display = 'block';
      if (errorDiv) {
        errorDiv.style.display = 'none';
      }
    });
  }

  _getImageErrorType(event, img) {
    if (!img.src || img.src === window.location.href) {
      return 'EMPTY_SRC';
    }
    if (img.src.startsWith('http://127.0.0.1') || img.src.startsWith('http://localhost')) {
      return 'LOCAL_HTTP_ERROR';
    }
    if (event.target && event.target.naturalWidth === 0) {
      return 'LOAD_ERROR';
    }
    return 'UNKNOWN_ERROR';
  }

  updateProgress(progress, receivedSize, totalSize, transferSpeed) {
    if (this._transferCompleted) {
      return;
    }

    const id = this._offer?.id;
    if (!id) return;

    const progressBar = this.shadowRoot.querySelector(`#progress-${id}`);
    const statusText = this.shadowRoot.querySelector(`#status-${id}`);

    if (progressBar) {
      progressBar.style.width = `${progress}%`;
      progressBar.textContent = `${progress}%`;
    }

    if (statusText) {
      const speed = transferSpeed ? `(${this.formatFileSize(transferSpeed)}/s)` : '';
      statusText.textContent = `${window.i18n?.t ? window.i18n.t('chat.sendingProgress') : 'sending... {received} / {total}'}`.replace('{received}', this.formatFileSize(receivedSize)).replace('{total}', this.formatFileSize(totalSize)) + ` ${speed}`;
    }
  }

  setInitialProgress(receivedSize, totalSize, isInterrupted = true) {
    if (this._transferCompleted) {
      this.logger?.info?.(`[ImageFileDisplay] setInitialProgress: transfer completed，skip setting progress`);
      return;
    }

    const id = this._offer?.id;
    if (!id) return;

    const progressBar = this.shadowRoot.querySelector(`#progress-${id}`);
    const statusText = this.shadowRoot.querySelector(`#status-${id}`);

    const progress = totalSize > 0 ? Math.min(100, Math.round((receivedSize / totalSize) * 100)) : 0;

    if (progressBar) {
      progressBar.style.width = `${progress}%`;
      progressBar.textContent = `${progress}%`;
    }

    if (statusText) {
      const actionText = this._isSender ? (window.i18n?.t ? window.i18n.t('chat.sent') : 'sent') : (window.i18n?.t ? window.i18n.t('chat.received') : 'received');
      const continueText = this._isSender ? (window.i18n?.t ? window.i18n.t('chat.canResend') : 'resumable transfer') : (window.i18n?.t ? window.i18n.t('chat.askPeerResend') : 'ask peer to resend for resumable transfer');
      if (isInterrupted) {
        statusText.innerHTML = `${window.i18n?.t ? window.i18n.t('chat.transferInterrupted') : 'transfer interrupted'}(${actionText} ${this.formatFileSize(receivedSize)} / ${this.formatFileSize(totalSize)})<br>${continueText}`;
      } else {
        statusText.textContent = `${window.i18n?.t ? window.i18n.t('chat.sendingProgress') : 'sending... {received} / {total}'}`.replace('{received}', this.formatFileSize(receivedSize)).replace('{total}', this.formatFileSize(totalSize));
      }
    }

    this.logger?.info?.(`[ImageFileDisplay] initial progress set: ${progress}%, ${receivedSize}/${totalSize}`);
  }

  showComplete(filePath) {
    this._transferCompleted = true;
    this._filePath = filePath;

    const fileRequest = this.shadowRoot.querySelector('.file-request');
    if (fileRequest) {
      fileRequest.classList.add('transfer-completed');
      this.logger?.info?.(`[ImageFileDisplay] added transfer-completed class，current class name: ${fileRequest.className}`);
    }

    const progressContainer = this.shadowRoot.querySelector('.progress-container');
    if (progressContainer) {
      progressContainer.style.display = 'none';
    }

    const imageStatus = this.shadowRoot.querySelector('.image-status');
    if (imageStatus) {
      imageStatus.style.display = 'none';
    }

    const actionsContainer = this.shadowRoot.querySelector('.file-complete-actions');
    if (actionsContainer && filePath) {
      const buttons = actionsContainer.querySelectorAll('button');
      buttons.forEach(btn => btn.dataset.filePath = filePath);
    }
  }

  reloadImage() {
    const img = this.shadowRoot.querySelector('img');
    const errorDiv = this.shadowRoot.querySelector('.image-error');
    if (img && img.src) {
      const baseUrl = img.src.split('?')[0];
      img.src = `${baseUrl}?t=${Date.now()}`;
      img.style.display = 'block';
      if (errorDiv) {
        errorDiv.style.display = 'none';
      }
      this.logger?.info?.(`[ImageFileDisplay] reload image: ${img.src}`);
      return true;
    }
    return false;
  }

  attachEventListeners() {
    const img = this.shadowRoot.querySelector('img');
    if (img) {
      img.addEventListener('click', () => {
        const originalSrc = img.dataset.originalSrc || img.src;
        if (originalSrc) {
          window.open(originalSrc, '_blank');
        }
      });
    }

    this.shadowRoot.querySelectorAll('.open-folder-btn, .save-as-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const filePath = e.target.dataset.filePath;
        const action = e.target.classList.contains('open-folder-btn') ? 'open-folder' : 'save-as';
        this.dispatchEvent(new CustomEvent('file-action', {
          detail: { filePath, action },
          bubbles: true,
          composed: true
        }));
      });
    });

    const errorRetry = this.shadowRoot.querySelector('.error-retry');
    if (errorRetry) {
      errorRetry.addEventListener('click', () => {
        this.logger?.info?.(`[ImageFileDisplay] User clicked retry: ${this._offer?.id}`);
        this._retryCount = 0;
        const img = this.shadowRoot.querySelector('img');
        const errorDiv = this.shadowRoot.querySelector('.image-error');
        if (img) {
          img.dataset.retryCount = '0';
          img._fallbackAttempted = false;
          const retryUrl = this._thumbnailUrl || this._imageUrl;
          if (retryUrl) {
            img.src = `${retryUrl.split('?')[0]}?t=${Date.now()}&manual_retry=1`;
          }
          img.style.display = 'block';
          if (errorDiv) {
            errorDiv.style.display = 'none';
          }
        }
      });
    }

    const imageMessage = this.shadowRoot.querySelector('.image-message');
    if (imageMessage) {
      imageMessage.addEventListener('contextmenu', (e) => {
        this.showContextMenu(e);
      });
    }
  }

  getStyles() {
    return `
      :host {
        display: block;
      }
      .image-message {
        position: relative;
        display: inline-block;
        margin-top: 8px;
      }
      .image-message img {
        max-width: 200px;
        height: auto;
        border-radius: 4px;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        transition: transform 0.2s ease, box-shadow 0.2s ease;
        display: block;
      }
      .image-message img:hover {
        transform: scale(1.02);
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      }
      .image-status {
        margin-top: 4px;
        font-size: 12px;
      }
      .file-status {
        color: #2196F3;
        white-space: nowrap;
      }
      .progress-container {
        width: 100%;
        max-width: 200px;
        height: 4px;
        background: #e0e0e0;
        border-radius: 2px;
        overflow: hidden;
        margin-top: 4px;
      }
      .progress-bar {
        height: 100%;
        background: linear-gradient(90deg, #4CAF50, #8BC34A);
        transition: width 0.3s ease;
        font-size: 0;
      }
      .image-error {
        display: none;
        flex-direction: column;
        align-items: center;
        padding: 20px;
        background: #f5f5f5;
        border-radius: 4px;
        color: #666;
        min-width: 150px;
      }
      .error-icon {
        font-size: 32px;
        margin-bottom: 8px;
      }
      .error-text {
        font-size: 12px;
        margin-bottom: 4px;
      }
      .error-retry {
        font-size: 11px;
        color: #2196F3;
        cursor: pointer;
        text-decoration: underline;
        margin-top: 4px;
      }
      .error-retry:hover {
        color: #1976D2;
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
        background: #4CAF50;
      }
      .open-folder-btn:hover {
        background: #45a049;
      }
      .save-as-btn {
        background: #2196F3;
      }
      .save-as-btn:hover {
        background: #1976D2;
      }
    `;
  }
}

customElements.define(ImageFileDisplay.componentName, ImageFileDisplay);
