/**
 * Email Attachment Display Component
 * Used to display metadata information of email attachments (file name, size, type)
 * Supports clicking to download attachments, with a progress bar display
 * Click to open the file after download is complete
 */

export class EmailAttachmentDisplay extends HTMLElement {
  static get componentName() {
    return 'email-attachment-display';
  }

  static get supportedMimeTypes() {
    return ['*/*'];
  }

  // Initialize component state
  async init(attachment) {
    if (!attachment) return;
    this._attachment = attachment;
    
    // If the database shows it has been downloaded, we need to verify whether the physical file still exists and matches the size and hash value
    if (attachment.downloaded && attachment.localPath) {
      if (window.electronAPI && window.electronAPI.verifyAttachmentFile) {
        try {
          // Call the main process to verify the file
          const check = await window.electronAPI.verifyAttachmentFile({
            localPath: attachment.localPath,
            expectedSize: attachment.size, // This size is usually the decoded size, matching stats.size
            expectedHash: attachment.fileHash // Optional file hash value
          });
          
          if (!check.exists || !check.isReadable) {
            console.warn(`[EmailAttachmentDisplay] physical verification failed: exists=${check.exists}, isReadable=${check.isReadable}`);
            // If the physical file is missing or unreadable, fix the status
            this._isDownloaded = false;
            this._downloadedFilePath = null;
            // Notify backend data correction
            await this._updateDownloadStatusInDatabase(false);
          } else if (check.expectedHash && !check.hashMatches) {
            console.warn(`[EmailAttachmentDisplay] file content validation failed: hash value mismatch`);
            // The file has been tampered with or corrupted, marked as not downloaded
            this._isDownloaded = false;
            this._downloadedFilePath = null;
            await this._updateDownloadStatusInDatabase(false);
          } else {
            this._isDownloaded = true;
            this._downloadedFilePath = attachment.localPath;
            console.log(`[EmailAttachmentDisplay] file verification succeeded: ${attachment.filename}, size=${check.actualSize}, hash=${check.actualHash?.substring(0, 8)}...`);
          }
        } catch (e) {
          console.error('[EmailAttachmentDisplay] initialize physical verification error:', e);
          this._isDownloaded = true; // If an error occurs, conservatively keep the original state
        }
      } else {
        this._isDownloaded = true;
        this._downloadedFilePath = attachment.localPath;
      }
    } else {
      this._isDownloaded = false;
      this._downloadedFilePath = null;
    }
    
    this._isDownloading = false;
    this._downloadProgress = 0;
    this.render();
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._attachment = null;
    this._rendered = false;
    this._isDownloading = false;
    this._downloadProgress = 0;
    this._emailUid = null;
    this._username = null;
    this._imapConfig = null;
    this._emailDbId = null;  // Database ID (not IMAP UID)
    this._downloadedFilePath = null; // Path of the downloaded file
    this._isDownloaded = false; // Whether it has been downloaded
  }

  static get observedAttributes() {
    return ['attachment', 'email-uid', 'username', 'imap-config'];
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;

    if (name === 'attachment') {
      try {
        this._attachment = JSON.parse(newValue);
        console.warn('[EmailAttachmentDisplay] attachmentproperty already set:', this._attachment?.filename, 'downloaded:', this._attachment?.downloaded, 'localPath:', this._attachment?.localPath);
        // Initialize download status
        this._initDownloadStatusFromAttachment(this._attachment);
      } catch (e) {
        console.error('[EmailAttachmentDisplay] parseattachmentfailed:', e);
        this._attachment = null;
      }
      if (this._rendered) {
        this.render();
      }
    } else if (name === 'email-uid') {
      this._emailUid = newValue;
    } else if (name === 'username') {
      this._username = newValue;
    } else if (name === 'imap-config') {
      try {
        this._imapConfig = newValue ? JSON.parse(newValue) : null;
      } catch (e) {
        console.error('[EmailAttachmentDisplay] parseimap-configfailed:', e);
        this._imapConfig = null;
      }
    }
  }

  connectedCallback() {
    if (!this._rendered) {
      // If there is attachment data, initialize the download status first
      if (this._attachment) {
        console.log('[EmailAttachmentDisplay] connectedCallbackinitialize:', this._attachment?.filename, 'downloaded:', this._attachment?.downloaded);
        this._initDownloadStatusFromAttachment(this._attachment);
      }
      this.render();
      this._rendered = true;
    }
  }

  /**
   * Initialize download status from attachment data (internal method)
   */
  _initDownloadStatusFromAttachment(attachment) {
    if (attachment && attachment.downloaded && attachment.localPath) {
      console.log('[EmailAttachmentDisplay] detected downloaded attachment:', attachment.filename, 'path:', attachment.localPath);
      this._isDownloaded = true;
      this._downloadedFilePath = attachment.localPath;
    } else {
      console.log('[EmailAttachmentDisplay] attachment not downloaded:', attachment?.filename, 'downloaded:', attachment?.downloaded, 'localPath:', attachment?.localPath);
      this._isDownloaded = false;
      this._downloadedFilePath = null;
    }
  }

  setAttachment(attachment) {
    this._attachment = attachment;
    this.render();
  }

  setEmailContext(emailUid, username, imapConfig, emailDbId) {
    this._emailUid = emailUid;
    this._username = username;
    this._imapConfig = imapConfig;
    this._emailDbId = emailDbId; // Email ID in the database
  }

  /**
   * Initialize download status from attachment data
   * Used to check whether the attachment has been downloaded when the component is initialized
   */
  async initDownloadStatus(attachment) {
    console.warn('[EmailAttachmentDisplay] initDownloadStatuscalled:', attachment?.filename, 'downloaded:', attachment?.downloaded);
    this._initDownloadStatusFromAttachment(attachment);
    // Verify if the file exists
    if (this._isDownloaded) {
      await this._verifyFileExists();  // ✅ Improvement: Wait for async validation to complete
    }
    // Re-render to update the UI
    if (this._rendered) {
      this.render();
    }
  }

  /**
   * Verify whether the local file exists
   */
  async _verifyFileExists() {
    if (!this._downloadedFilePath) return;
    
    try {
      const result = await window.electronAPI.getFileStats(this._downloadedFilePath);
      if (!result || !result.exists) {
        // File does not exist, reset download status
        console.log('[EmailAttachmentDisplay] local file does not exist，reset download status:', this._downloadedFilePath);
        this._isDownloaded = false;
        this._downloadedFilePath = null;
        this.render();
      }
    } catch (error) {
      console.error('[EmailAttachmentDisplay] failed to verify file existence:', error);
    }
  }

  render() {
    if (!this._attachment) {
      return;
    }

    const { filename, contentType, size } = this._attachment;
    const fileSize = this._formatFileSize(size || 0);
    const icon = this._getFileIcon(contentType, filename);
    const fileType = this._getFileTypeName(contentType, filename);
    const isImageType = contentType && contentType.startsWith('image/');

    // Determine the prompt text based on the status
    let actionHint = '';
    if (this._isDownloaded) {
      actionHint = 'click to view file';
    } else if (this._isDownloading) {
      actionHint = 'downloading...';
    } else {
      actionHint = 'click to download';
    }

    // For image types that have been downloaded: display the thumbnail, otherwise display the icon
    const isImageDownloaded = isImageType && this._isDownloaded && this._downloadedFilePath;
    const iconOrThumbnail = isImageDownloaded 
      ? this._renderThumbnailHtml(filename)
      : `<div class="attachment-icon">${icon}</div>`;

    this.shadowRoot.innerHTML = `
      <style>
        ${this._getStyles()}
      </style>
      <div class="email-attachment-item ${this._isDownloading ? 'downloading' : ''} ${this._isDownloaded ? 'downloaded' : ''} ${isImageDownloaded ? 'has-thumbnail' : ''}" id="attachmentItem">
        ${iconOrThumbnail}
        <div class="attachment-details">
          <div class="attachment-filename" title="${filename || 'unnamed'}">${filename || 'unnamed'}</div>
          <div class="attachment-meta">
            <span class="attachment-type">${fileType}</span>
            <span class="attachment-separator">•</span>
            <span class="attachment-size">${fileSize}</span>
            ${this._isDownloaded ? '<span class="attachment-separator">•</span><span class="action-hint">downloaded，click to open</span>' : ''}
          </div>
          <div class="download-progress" id="progressContainer" style="display: none;">
            <div class="progress-bar">
              <div class="progress-fill" id="progressFill" style="width: 0%"></div>
            </div>
            <span class="progress-text" id="progressText">0%</span>
          </div>
        </div>
        <div class="download-status" id="downloadStatus"></div>
      </div>
    `;

    this._attachEventListeners();
  }

  /**
   * Render thumbnail HTML (preferably display the thumbnail, show the original image after onerror)
   */
  _renderThumbnailHtml(filename) {
    // Generate thumbnail path (add _thumb.jpg after the original file name)
    const lastDot = filename.lastIndexOf('.');
    const thumbnailFilename = lastDot === -1 
      ? filename + '_thumb.jpg'
      : filename.substring(0, lastDot) + '_thumb.jpg';
    
    // Local file paths for thumbnails and original images
    const thumbnailPath = this._downloadedFilePath.replace(/\/[^\/]+$/, '/' + thumbnailFilename);
    const originalPath = this._downloadedFilePath;
    
    return `
      <div class="attachment-thumbnail">
        <img src="file://${thumbnailPath}" 
             data-original-src="file://${originalPath}"
             alt="${filename}"
             onclick="window.open(this.dataset.originalSrc || this.src, '_blank')"
             onerror="if(this.dataset.originalSrc && this.src!==this.dataset.originalSrc && !this._fb){this._fb=1;this.src=this.dataset.originalSrc;}">
      </div>
    `;
  }

  _attachEventListeners() {
    const item = this.shadowRoot.getElementById('attachmentItem');
    if (item) {
      item.addEventListener('click', () => {
        this._handleClick().catch(error => {
          console.error('[EmailAttachmentDisplay] handle click failed:', error);
        });
      });
    }
  }

  async _handleClick() {
    // If currently downloading, do not handle clicks
    if (this._isDownloading) {
      return;
    }

    // If already downloaded, open the file directly
    if (this._isDownloaded && this._downloadedFilePath) {
      try {
        await this._openFile();
      } catch (error) {
        console.error('[EmailAttachmentDisplay] failed to open file:', error);
        this._showError('failed to open file');
      }
      return;
    }

    // Not downloaded, execute download
    if (!this._emailUid || !this._username || !this._imapConfig) {
      console.error('[EmailAttachmentDisplay] missing required download parameters');
      this._showError('unable to download：missing email information');
      return;
    }

    try {
      await this._downloadAttachment();
    } catch (error) {
      console.error('[EmailAttachmentDisplay] download failed:', error);
      this._showError('download failed');
    }
  }

  async _openFile() {
    if (!this._downloadedFilePath) {
      throw new Error('file path does not exist');
    }

    console.log('[EmailAttachmentDisplay] open file:', this._downloadedFilePath);

    const contentType = this._attachment?.contentType || '';
    const isImageType = contentType.startsWith('image/');

    if (isImageType) {
      const filename = this._attachment?.filename || 'preview';
      const result = await window.electronAPI.openImagePreviewWindow(this._downloadedFilePath, filename);
      if (!result || !result.success) {
        throw new Error(result?.error || 'failed to open image preview window');
      }
    } else {
      const result = await window.electronAPI.openFile(this._downloadedFilePath);
      if (!result || !result.success) {
        throw new Error(result?.error || 'failed to open file');
      }
    }
  }

  /**
   * Update the download status of attachments in the database
   * @param {boolean} downloaded - Whether it has been downloaded, default is true
   */
  async _updateDownloadStatusInDatabase(downloaded = true) {
    if (!this._emailDbId || !this._username || !this._attachment) {
      console.warn('[EmailAttachmentDisplay] missing required parameter，unable to update database');
      return false;
    }

    try {
      // If the download is complete, calculate the file hash
      let fileHash = null;
      if (downloaded && this._downloadedFilePath && window.electronAPI.calculateFileHash) {
        try {
          const hashResult = await window.electronAPI.calculateFileHash({
            filePath: this._downloadedFilePath
          });
          if (hashResult && hashResult.success) {
            fileHash = hashResult.hash;
            console.log(`[EmailAttachmentDisplay] file hash calculation completed: ${fileHash.substring(0, 16)}...`);
          }
        } catch (hashError) {
          console.warn(`[EmailAttachmentDisplay] hash calculation failed: ${hashError.message}`);
          // continue process，hash value is optional
        }
      }

      const result = await window.electronAPI.updateAttachmentStatus({
        username: this._username,
        emailId: this._emailDbId,
        filename: this._attachment.filename,
        downloaded: downloaded,
        localPath: this._downloadedFilePath,
        fileHash: fileHash  // Pass the file hash value
      });

      if (result && result.success) {
        console.log('[EmailAttachmentDisplay] database update succeeded:', this._attachment.filename);
        return true;
      } else {
        console.warn('[EmailAttachmentDisplay] database update failed:', result?.error);
        return false;
      }
    } catch (error) {
      console.error('[EmailAttachmentDisplay] Failed to update database:', error);
      return false;
    }
  }

  async _downloadAttachment() {
    this._isDownloading = true;
    this._downloadProgress = 0;
    this._updateDownloadUI('downloading');

    // Set progress listener
    const progressHandler = (event, data) => {
      // Check if it is the attachment we are currently downloading
      if (data && 
          data.username === this._username && 
          data.emailUid === this._emailUid && 
          data.filename === this._attachment.filename) {
        this._downloadProgress = data.percentage;
        this._updateProgressBar(data.percentage);
      }
    };

    // Register progress listener
    if (window.electronAPI.onDownloadProgress) {
      window.electronAPI.onDownloadProgress(progressHandler);
    }

    try {
      const { filename, contentType, size } = this._attachment;

      const result = await window.electronAPI.downloadEmailAttachment({
        username: this._username,
        emailUid: this._emailUid,
        filename: filename,
        contentType: contentType,
        size: size,
        imapConfig: this._imapConfig
      });

      // Remove progress listener
      if (window.electronAPI.offDownloadProgress) {
        window.electronAPI.offDownloadProgress(progressHandler);
      }

      if (result && result.success) {
        // Save the path of the downloaded file
        this._downloadedFilePath = result.savePath;
        this._isDownloaded = true;
        this._isDownloading = false;
        this._downloadProgress = 100;
        this._updateDownloadUI('completed', 100);
        this._showSuccess(result.savePath);
        
        // Update the download status in the database
        await this._updateDownloadStatusInDatabase();
        
        // Image type: generate thumbnail
        const isImageType = this._attachment?.contentType?.startsWith('image/');
        if (isImageType && window.electronAPI?.generateThumbnail) {
          try {
            await window.electronAPI.generateThumbnail(this._downloadedFilePath, 200);
            console.log('[EmailAttachmentDisplay] Thumbnail generated successfully:', this._attachment.filename);
          } catch (err) {
            console.warn('[EmailAttachmentDisplay] thumbnail generation failed(Non-fatal):', err?.message);
          }
        }
        
        // Re-render to update the UI state
        this.render();
      } else {
        throw new Error(result?.error || 'download failed');
      }
    } catch (error) {
      // Remove progress listener
      if (window.electronAPI.offDownloadProgress) {
        window.electronAPI.offDownloadProgress(progressHandler);
      }
      this._isDownloading = false;
      
      // Analyze error types and display user-friendly error messages
      const errorMessage = error.message || String(error);
      const friendlyMessage = this._getFriendlyErrorMessage(errorMessage);
      this._updateDownloadUI('error');
      this._showError(friendlyMessage);
      
      // No longer throwing an error, because the error message has already been displayed
      console.error('[EmailAttachmentDisplay] download failed:', errorMessage);
    }
  }

  /**
   * Convert technical errors into user-friendly error messages
   */
  _getFriendlyErrorMessage(errorMessage) {
    if (!errorMessage) return 'download failed';

    const lowerMsg = errorMessage.toLowerCase();

    // The email was deleted or moved
    if (lowerMsg.includes('Deleted on server') ||
        lowerMsg.includes('Email deleted') ||
        (lowerMsg.includes('uid') && lowerMsg.includes('not found'))) {
      return 'Email deleted or moved on server';
    }

    // Attachment does not exist
    if (lowerMsg.includes('Attachment not found') || lowerMsg.includes('No attachment found')) {
      return 'Attachment does not exist or has been deleted';
    }

    // File is in use
    if (lowerMsg.includes('ebusy') ||
        lowerMsg.includes('resource busy') ||
        lowerMsg.includes('In use') ||
        lowerMsg.includes('lock') ||
        lowerMsg.includes('Currently in use')) {
      return 'File is in use，Please close other programs and retry';
    }

    // Insufficient disk space
    if (lowerMsg.includes('enospc') ||
        lowerMsg.includes('no space') ||
        lowerMsg.includes('Disk full') ||
        lowerMsg.includes('Insufficient space')) {
      return 'Insufficient disk space，Please free up disk space and retry';
    }

    // Insufficient permissions
    if (lowerMsg.includes('eacces') ||
        lowerMsg.includes('permission denied') ||
        lowerMsg.includes('Access denied') ||
        lowerMsg.includes('No permission')) {
      return 'No permission to save file，Please check folder permissions';
    }

    // Network/Connection Error
    if (lowerMsg.includes('Connection') || lowerMsg.includes('Network') || lowerMsg.includes('timeout')) {
      return 'Network connection failed，Please check network and retry';
    }

    // Authentication error
    if (lowerMsg.includes('Authentication') || lowerMsg.includes('Login') || lowerMsg.includes('auth')) {
      return 'Email login failed，Please check account settings';
    }

    // Timeout
    if (lowerMsg.includes('Timeout')) {
      return 'Download timeout，Please retry later';
    }

    // Return the original error (truncate overly long messages)
    return errorMessage.length > 50 ? errorMessage.substring(0, 50) + '...' : errorMessage;
  }

  /**
   * Update progress bar display
   */
  _updateProgressBar(progress) {
    const progressFill = this.shadowRoot.getElementById('progressFill');
    const progressText = this.shadowRoot.getElementById('progressText');
    
    if (progressFill && progressText) {
      progressFill.style.width = `${progress}%`;
      progressText.textContent = `${Math.round(progress)}%`;
    }
  }

  _updateDownloadUI(status, progress = 0) {
    const progressContainer = this.shadowRoot.getElementById('progressContainer');
    const progressFill = this.shadowRoot.getElementById('progressFill');
    const progressText = this.shadowRoot.getElementById('progressText');
    const downloadStatus = this.shadowRoot.getElementById('downloadStatus');
    const item = this.shadowRoot.getElementById('attachmentItem');

    if (!progressContainer || !progressFill || !progressText || !downloadStatus || !item) return;

    switch (status) {
      case 'downloading':
        progressContainer.style.display = 'flex';
        progressFill.style.width = `${progress}%`;
        progressText.textContent = `${progress}%`;
        downloadStatus.innerHTML = '<span class="status-icon downloading-icon">⏳</span>';
        item.classList.add('downloading');
        item.classList.remove('downloaded');
        break;
      case 'completed':
        progressContainer.style.display = 'none';
        downloadStatus.innerHTML = '<span class="status-icon completed-icon">✅</span>';
        item.classList.remove('downloading');
        item.classList.add('downloaded');
        setTimeout(() => {
          downloadStatus.innerHTML = '';
        }, 3000);
        break;
      case 'error':
        progressContainer.style.display = 'none';
        downloadStatus.innerHTML = '<span class="status-icon error-icon">❌</span>';
        item.classList.remove('downloading');
        item.classList.add('error');
        setTimeout(() => {
          downloadStatus.innerHTML = '';
          item.classList.remove('error');
        }, 3000);
        break;
    }
  }

  updateProgress(progress) {
    this._downloadProgress = progress;
    const progressFill = this.shadowRoot.getElementById('progressFill');
    const progressText = this.shadowRoot.getElementById('progressText');
    if (progressFill && progressText) {
      progressFill.style.width = `${progress}%`;
      progressText.textContent = `${Math.round(progress)}%`;
    }
  }

  _showSuccess(savePath) {
    const downloadStatus = this.shadowRoot.getElementById('downloadStatus');
    if (downloadStatus) {
      downloadStatus.innerHTML = `<span class="status-icon completed-icon" title="Saved to: ${savePath}">✅</span>`;
    }
  }

  _showError(message) {
    const downloadStatus = this.shadowRoot.getElementById('downloadStatus');
    const item = this.shadowRoot.getElementById('attachmentItem');
    
    if (downloadStatus) {
      downloadStatus.innerHTML = `<span class="status-icon error-icon" title="${message}">❌</span>`;
    }
    
    // Add error state style
    if (item) {
      item.classList.add('error');
    }
    
    // Display error message text (below the file name)
    const attachmentMeta = this.shadowRoot.querySelector('.attachment-meta');
    if (attachmentMeta && !attachmentMeta.querySelector('.error-message')) {
      const errorSpan = document.createElement('span');
      errorSpan.className = 'error-message';
      errorSpan.textContent = message;
      attachmentMeta.appendChild(errorSpan);
      
      // Clear error message after 5 seconds
      setTimeout(() => {
        if (errorSpan.parentNode) {
          errorSpan.parentNode.removeChild(errorSpan);
        }
        if (item) {
          item.classList.remove('error');
        }
        if (downloadStatus) {
          downloadStatus.innerHTML = '';
        }
      }, 5000);
    }
  }

  _formatFileSize(bytes) {
    if (!bytes || bytes === 0) return 'unknown size';
    
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const size = bytes / Math.pow(1024, i);
    
    if (i === 0) {
      return `${bytes} B`;
    }
    return `${size.toFixed(2)} ${sizes[i]}`;
  }

  _getFileIcon(contentType, filename) {
    if (!contentType && filename) {
      contentType = this._getMimeTypeFromFilename(filename);
    }

    const iconMap = {
      'application/pdf': '📕',
      'application/msword': '📘',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '📘',
      'application/vnd.ms-excel': '📗',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '📗',
      'application/vnd.ms-powerpoint': '📙',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': '📙',
      'text/plain': '📄',
      'text/html': '🌐',
      'text/csv': '📊',
      'application/zip': '📦',
      'application/x-rar-compressed': '📦',
      'application/x-7z-compressed': '📦',
      'application/x-tar': '📦',
      'application/gzip': '📦',
      'application/json': '📋',
      'application/xml': '📋',
      'image/jpeg': '🖼️',
      'image/png': '🖼️',
      'image/gif': '🖼️',
      'image/webp': '🖼️',
      'image/bmp': '🖼️',
      'image/svg+xml': '🖼️',
      'audio/mpeg': '🎵',
      'audio/wav': '🎵',
      'audio/ogg': '🎵',
      'audio/aac': '🎵',
      'video/mp4': '🎬',
      'video/avi': '🎬',
      'video/quicktime': '🎬',
      'video/x-msvideo': '🎬',
      'video/webm': '🎬',
    };

    if (contentType && iconMap[contentType]) {
      return iconMap[contentType];
    }

    if (contentType && contentType.startsWith('image/')) return '🖼️';
    if (contentType && contentType.startsWith('audio/')) return '🎵';
    if (contentType && contentType.startsWith('video/')) return '🎬';
    if (contentType && contentType.startsWith('text/')) return '📄';

    return '📎';
  }

  _getFileTypeName(contentType, filename) {
    if (!contentType && filename) {
      contentType = this._getMimeTypeFromFilename(filename);
    }

    const typeMap = {
      'application/pdf': 'PDF document',
      'application/msword': 'Word document',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word document',
      'application/vnd.ms-excel': 'Excel spreadsheet',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel spreadsheet',
      'application/vnd.ms-powerpoint': 'PowerPoint demo',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint demo',
      'text/plain': 'Text file',
      'text/html': 'HTML file',
      'text/csv': 'CSV spreadsheet',
      'application/zip': 'ZIP archive',
      'application/x-rar-compressed': 'RAR archive',
      'application/x-7z-compressed': '7Z archive',
      'application/json': 'JSON file',
      'application/xml': 'XML file',
      'image/jpeg': 'JPEG image',
      'image/png': 'PNG image',
      'image/gif': 'GIF image',
      'image/webp': 'WebP image',
      'image/svg+xml': 'SVG image',
      'audio/mpeg': 'MP3 audio',
      'audio/wav': 'WAV audio',
      'video/mp4': 'MP4 video',
      'video/avi': 'AVI video',
      'video/quicktime': 'MOV video',
      'video/webm': 'WebM video',
    };

    if (contentType && typeMap[contentType]) {
      return typeMap[contentType];
    }

    if (contentType) {
      if (contentType.startsWith('image/')) return 'image';
      if (contentType.startsWith('audio/')) return 'audio';
      if (contentType.startsWith('video/')) return 'video';
      if (contentType.startsWith('text/')) return 'Text';
    }

    const ext = filename ? filename.split('.').pop()?.toUpperCase() : '';
    return ext ? `${ext} file` : 'attachment';
  }

  _getMimeTypeFromFilename(filename) {
    if (!filename) return 'application/octet-stream';
    const ext = filename.split('.').pop()?.toLowerCase();
    const mimeMap = {
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'webp': 'image/webp',
      'svg': 'image/svg+xml',
      'bmp': 'image/bmp',
      'pdf': 'application/pdf',
      'txt': 'text/plain',
      'html': 'text/html',
      'htm': 'text/html',
      'csv': 'text/csv',
      'json': 'application/json',
      'xml': 'application/xml',
      'doc': 'application/msword',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'xls': 'application/vnd.ms-excel',
      'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'ppt': 'application/vnd.ms-powerpoint',
      'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'zip': 'application/zip',
      'rar': 'application/x-rar-compressed',
      '7z': 'application/x-7z-compressed',
      'tar': 'application/x-tar',
      'gz': 'application/gzip',
      'mp3': 'audio/mpeg',
      'wav': 'audio/wav',
      'ogg': 'audio/ogg',
      'aac': 'audio/aac',
      'mp4': 'video/mp4',
      'avi': 'video/avi',
      'mov': 'video/quicktime',
      'webm': 'video/webm',
    };
    return mimeMap[ext] || 'application/octet-stream';
  }

  _getStyles() {
    return `
      :host {
        display: block;
      }
      .email-attachment-item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        background: linear-gradient(135deg, #f8f9fa 0%, #ffffff 100%);
        border: 1px solid #e9ecef;
        border-radius: 8px;
        margin: 6px 0;
        transition: all 0.2s ease;
        cursor: pointer;
        position: relative;
      }
      .email-attachment-item:hover {
        background: linear-gradient(135deg, #e8f4fd 0%, #f0f7ff 100%);
        border-color: #1890ff;
        box-shadow: 0 2px 8px rgba(24, 144, 255, 0.15);
      }
      .email-attachment-item.downloading {
        cursor: wait;
        opacity: 0.8;
      }
      .email-attachment-item.downloaded {
        border-color: #52c41a;
        background: linear-gradient(135deg, #f6ffed 0%, #ffffff 100%);
      }
      .email-attachment-item.downloaded:hover {
        background: linear-gradient(135deg, #d9f7be 0%, #f6ffed 100%);
        border-color: #73d13d;
        box-shadow: 0 2px 8px rgba(82, 196, 26, 0.15);
      }
      .email-attachment-item.error {
        border-color: #ff4d4f;
        background: linear-gradient(135deg, #fff2f0 0%, #ffffff 100%);
      }
      .attachment-icon {
        font-size: 28px;
        flex-shrink: 0;
        width: 36px;
        height: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #fff;
        border-radius: 6px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
      }
      .attachment-thumbnail {
        flex-shrink: 0;
        width: 48px;
        height: 48px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #fff;
        border-radius: 6px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
        overflow: hidden;
      }
      .attachment-thumbnail img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        cursor: pointer;
        transition: transform 0.2s ease;
      }
      .attachment-thumbnail img:hover {
        transform: scale(1.05);
      }
      .attachment-details {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .attachment-filename {
        font-size: 14px;
        font-weight: 500;
        color: #1890ff;
        text-decoration: underline;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        line-height: 1.4;
        cursor: pointer;
      }
      .email-attachment-item.downloaded .attachment-filename {
        color: #52c41a;
      }
      .email-attachment-item.downloaded .attachment-filename:hover {
        color: #73d13d;
      }
      .attachment-filename:hover {
        color: #40a9ff;
      }
      .attachment-meta {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: #6c757d;
        line-height: 1.2;
      }
      .attachment-type {
        color: #495057;
      }
      .attachment-separator {
        color: #adb5bd;
      }
      .attachment-size {
        color: #868e96;
      }
      .action-hint {
        color: #52c41a;
        font-weight: 500;
      }
      .download-progress {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 4px;
      }
      .progress-bar {
        flex: 1;
        height: 4px;
        background: #e9ecef;
        border-radius: 2px;
        overflow: hidden;
      }
      .progress-fill {
        height: 100%;
        background: linear-gradient(90deg, #1890ff, #40a9ff);
        border-radius: 2px;
        transition: width 0.3s ease;
      }
      .progress-text {
        font-size: 11px;
        color: #1890ff;
        min-width: 35px;
        text-align: right;
      }
      .download-status {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
      }
      .status-icon {
        font-size: 16px;
      }
      .downloading-icon {
        animation: spin 1s linear infinite;
      }
      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      .completed-icon {
        color: #52c41a;
      }
      .error-icon {
        color: #ff4d4f;
      }
      .error-message {
        color: #ff4d4f;
        font-size: 12px;
        margin-left: 6px;
        font-weight: 500;
        animation: fadeIn 0.3s ease;
      }
      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(-5px); }
        to { opacity: 1; transform: translateY(0); }
      }
    `;
  }
}

if (!customElements.get('email-attachment-display')) {
  customElements.define('email-attachment-display', EmailAttachmentDisplay);
}

export default EmailAttachmentDisplay;
