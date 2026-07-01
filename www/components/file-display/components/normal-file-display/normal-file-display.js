/**
 * General file display component
 * Used to display file types that are not images or videos
 */

import { FileDisplayBase } from '../../base/file-display-base.js';

export class NormalFileDisplay extends FileDisplayBase {
  static get componentName() {
    return 'normal-file-display';
  }

  static get supportedMimeTypes() {
    return ['*/*']; // Support all types as a fallback
  }

  render() {
    if (!this._offer) {
      this.logger?.info?.('[NormalFileDisplay] render: _offer is empty，skip rendering');
      return;
    }

    this.logger?.info?.(`[NormalFileDisplay] render: Start rendering, id=${this._offer.id}, isSender=${this._isSender}, _transferCompleted=${this._transferCompleted}, _filePath=${this._filePath}`);

    const { id, filename, size, mimeType } = this._offer;
    const fileSize = this.formatFileSize(size);
    const icon = this.getFileIcon(mimeType);
    
    // Determine displayed content based on transmission status
    const isCompleted = this._transferCompleted;
    const statusText = isCompleted 
      ? '' 
      : (this._isSender ? 'waiting for peer to accept...' : 'request to send file');
    const progressDisplay = isCompleted ? 'none' : 'block';
    const completedClass = isCompleted ? 'transfer-completed' : '';
    const statusDisplay = isCompleted ? 'none' : 'inline';

    const storedFileName = this._offer.storedFileName ||
                          this._offer.path?.split(/[\\/]/).pop() ||
                          filename;

    this.shadowRoot.innerHTML = `
      <style>
        ${this.getStyles()}
      </style>
      <div class="file-request ${completedClass}" id="file-request-${id}"
           data-mime-type="${mimeType}"
           data-file-size="${size}"
           data-stored-filename="${storedFileName}"
           data-file-path="${this._filePath || ''}">
        <div class="file-info">
          <span class="file-icon">${icon}</span>
          <div class="file-details">
            <div class="file-name" title="${filename}">${filename}</div>
            <div class="file-meta">
              <span class="file-size">${fileSize}</span>
              <span class="file-status" id="status-${id}" style="display: ${statusDisplay}">${statusText}</span>
            </div>
          </div>
        </div>
        <div class="progress-container" style="display: ${progressDisplay}">
          <div class="progress-bar" id="progress-${id}" style="width: 0%">0%</div>
        </div>
        ${!this._isSender && !isCompleted ? `
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

    this.attachEventListeners();
  }

  getFileIcon(mimeType) {
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
      'application/zip': '📦',
      'application/x-rar-compressed': '📦',
      'application/x-7z-compressed': '📦',
      'application/x-tar': '📦',
      'application/gzip': '📦',
    };
    return iconMap[mimeType] || '📔';
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
      statusText.textContent = `transferring... ${this.formatFileSize(receivedSize)} / ${this.formatFileSize(totalSize)} ${speed}`;
    }
  }

  /**
   * Set initial progress status (used to restore incomplete transfers when loading historical messages)
   * @param {number} receivedSize - Number of bytes received
   * @param {number} totalSize - Total number of bytes
   * @param {boolean} isInterrupted - Whether the transfer was interrupted
   */
  setInitialProgress(receivedSize, totalSize, isInterrupted = true) {
    if (this._transferCompleted) {
      this.logger?.info?.(`[NormalFileDisplay] setInitialProgress: transfer completed，skip setting progress`);
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
      const actionText = this._isSender ? 'sent' : 'received';
      const continueText = this._isSender ? 'resumable transfer' : 'ask peer to resend for resumable transfer';
      if (isInterrupted) {
        statusText.innerHTML = `transfer interrupted(${actionText} ${this.formatFileSize(receivedSize)} / ${this.formatFileSize(totalSize)})<br>${continueText}`;
      } else {
        statusText.textContent = `transferring... ${this.formatFileSize(receivedSize)} / ${this.formatFileSize(totalSize)}`;
      }
    }

    this.logger?.info?.(`[NormalFileDisplay] initial progress set: ${progress}%, ${receivedSize}/${totalSize}`);
    
    // Hide accept/reject buttons
    const fileActions = this.shadowRoot.querySelector('.file-actions');
    if (fileActions) {
      fileActions.style.display = 'none';
    }
  }

  showComplete(filePath) {
    this._transferCompleted = true;
    this._filePath = filePath; // Set the file path for the right-click menu
    
    const fileRequest = this.shadowRoot.querySelector('.file-request');
    if (fileRequest) {
      fileRequest.classList.add('transfer-completed');
      this.logger?.info?.(`[NormalFileDisplay] added transfer-completed class，current class name: ${fileRequest.className}`);
    }
    
    // Update the filename to the original filename
    if (this._offer && this._offer.filename) {
      const fileNameEl = this.shadowRoot.querySelector('.file-name');
      if (fileNameEl) {
        fileNameEl.textContent = this._offer.filename;
        fileNameEl.title = this._offer.filename;
      }
    }
    
    // Hide the progress bar and status text
    const progressContainer = this.shadowRoot.querySelector('.progress-container');
    if (progressContainer) {
      progressContainer.style.display = 'none';
    }
    
    const fileStatus = this.shadowRoot.querySelector('.file-status');
    if (fileStatus) {
      fileStatus.style.display = 'none';
    }
    
    // Hide accept/reject buttons
    const fileActions = this.shadowRoot.querySelector('.file-actions');
    if (fileActions) {
      fileActions.style.display = 'none';
    }
    
    const actionsContainer = this.shadowRoot.querySelector('.file-complete-actions');
    if (actionsContainer) {
      this.logger?.info?.(`[NormalFileDisplay] found file-complete-actions container`);
      // Do not display the action button directly, let the CSS hover effect control the display
      // Only set the filePath property
      if (filePath) {
        const buttons = actionsContainer.querySelectorAll('button');
        buttons.forEach(btn => {
          btn.dataset.filePath = filePath;
          this.logger?.info?.(`[NormalFileDisplay] Settings button data-file-path: ${filePath}`);
        });
      }
    } else {
      this.logger?.warn?.(`[NormalFileDisplay] not found file-complete-actions container`);
    }
  }

  attachEventListeners() {
    // Accept/Reject button event
    const acceptBtns = this.shadowRoot.querySelectorAll('.accept-btn');
    const rejectBtns = this.shadowRoot.querySelectorAll('.reject-btn');
    
    this.logger?.info?.(`[NormalFileDisplay] attachEventListeners: found ${acceptBtns.length} accept button(s), ${rejectBtns.length} reject button(s)`);
    
    this.shadowRoot.querySelectorAll('.accept-btn, .reject-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        const transferId = e.target.dataset.transferId;
        const action = e.target.classList.contains('accept-btn') ? 'accept' : 'reject';
        
        this.logger?.info?.(`[NormalFileDisplay] button ${action} clicked, transferId=${transferId}`);
        
        // Disable the button to prevent repeated clicks and provide visual feedback
        e.target.disabled = true;
        e.target.style.opacity = '0.5';
        e.target.style.cursor = 'not-allowed';
        
        this.dispatchEvent(new CustomEvent('file-action', {
          detail: { transferId, action },
          bubbles: true,
          composed: true
        }));
      });
    });

    // Open folder / Save As button event
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

    // Right-click menu event
    const fileRequest = this.shadowRoot.querySelector('.file-request');
    if (fileRequest) {
      fileRequest.addEventListener('contextmenu', (e) => {
        this.showContextMenu(e);
      });

      // Left-click to open the file (only after the transfer is complete)
      fileRequest.addEventListener('click', (e) => {
        // Exclude button click
        if (e.target.tagName === 'BUTTON') return;
        
        // Can only be opened after the transfer is complete
        if (!this._transferCompleted || !this._filePath) {
          this.logger?.info?.(`[NormalFileDisplay] Transfer incomplete or file path empty on click，Do not open file`);
          return;
        }
        
        this.handleOpenFile(this._filePath);
      });
    }
  }

  async handleOpenFile(filePath) {
    try {
      this.logger?.info?.(`[NormalFileDisplay] handleOpenFile: filePath=${filePath}`);

      if (!this.electronAPI || !this.electronAPI.openFile) {
        this.logger?.warn?.('[NormalFileDisplay] openFile API unavailable');
        return;
      }

      const result = await this.electronAPI.openFile(filePath);
      this.logger?.info?.(`[NormalFileDisplay] openFile result:`, result);
    } catch (error) {
      this.logger?.error?.(`[NormalFileDisplay] failed to open file:`, error);
    }
  }

  getStyles() {
    return `
      :host {
        display: block;
      }
      .file-request {
        background: #f5f5f5;
        border-radius: 8px;
        padding: 12px;
        margin: 8px 0;
        min-width: 280px;
        max-width: 400px;
      }
      .file-request.transfer-completed {
        cursor: pointer;
      }
      .file-request.transfer-completed:hover {
        background: #ebebeb;
      }
      .file-info {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        margin-bottom: 8px;
      }
      .file-icon {
        font-size: 24px;
        flex-shrink: 0;
        line-height: 1;
      }
      .file-details {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .file-name {
        font-size: 14px;
        font-weight: 500;
        color: #333;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        line-height: 1.3;
      }
      .file-meta {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        color: #666;
        line-height: 1.2;
      }
      .file-size {
        color: #888;
        white-space: nowrap;
      }
      .file-status {
        color: #2196F3;
        white-space: nowrap;
      }
      .progress-container {
        width: 100%;
        height: 4px;
        background: #e0e0e0;
        border-radius: 2px;
        overflow: hidden;
        margin-top: 8px;
      }
      .progress-bar {
        height: 100%;
        background: linear-gradient(90deg, #4CAF50, #8BC34A);
        transition: width 0.3s ease;
        font-size: 0;
      }
      .file-actions {
        display: flex;
        gap: 8px;
        margin-top: 8px;
      }
      .file-actions button {
        padding: 6px 16px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
      }
      .accept-btn {
        background: #4CAF50;
        color: white;
      }
      .accept-btn:hover {
        background: #45a049;
      }
      .reject-btn {
        background: #f44336;
        color: white;
      }
      .reject-btn:hover {
        background: #da190b;
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

customElements.define(NormalFileDisplay.componentName, NormalFileDisplay);
