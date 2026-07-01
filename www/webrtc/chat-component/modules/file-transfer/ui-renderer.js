/**
 * File transfer UI message rendering module
 * Handles rendering file requests, image, and video messages
 */

import { IMAGE_MIME_TYPES } from '../config.js';
import {
  createFileDisplayComponent,
  registerAllComponents,
} from '../../../../components/file-display/index.js';

export class RendererHandler {
  constructor(context) {
    this.context = context;
  }

  get logger() { return this.context.logger; }
  get utils() { return this.context.utils; }

  async _registerComponents() {
    try {
      await registerAllComponents();
      this.logger.info?.('[FileTransferUI] file display component registration succeeded');
    } catch (error) {
      this.logger.error?.('[FileTransferUI] file display component registration failed:', error);
    }
  }

  async renderFileRequestMessage(offer, isSender = false, autoAccepted = false) {
    try {
      const component = await createFileDisplayComponent(offer, isSender, this.context);
      
      if (autoAccepted && !isSender) {
        const statusEl = component.shadowRoot?.querySelector(`#status-${offer.id}`);
        if (statusEl) {
          statusEl.textContent = window.i18n?.t ? window.i18n.t('chat.acceptedTransferring') : 'Accepted, transferring...';
        }
        const actionsEl = component.shadowRoot?.querySelector('.file-actions');
        if (actionsEl) {
          actionsEl.style.display = 'none';
        }
      }
      
      return component;
    } catch (error) {
      this.logger.error?.('[FileTransferUI] failed to create file display component:', error);
      return this._renderFileRequestMessageLegacy(offer, isSender, autoAccepted);
    }
  }

  _renderFileRequestMessageLegacy(offer, isSender = false, autoAccepted = false) {
    const isImage = IMAGE_MIME_TYPES.includes(offer.mimeType);

    let icon = '📔';
    if (isImage) icon = '🖼️';

    const fileSize = this.utils.formatBytes(offer.size);
    
    let statusText = isSender ? (window.i18n?.t ? window.i18n.t('chat.waitingForConfirm') : 'Waiting for peer to accept...') : (window.i18n?.t ? window.i18n.t('chat.requestSendFile') : 'Request to send file');
    if (autoAccepted && !isSender) {
      statusText = window.i18n?.t ? window.i18n.t('chat.acceptedTransferring') : 'Accepted, transferring...';
    }
    
    const storedFileName = offer.storedFileName || offer.path?.split(/[/\\]/).pop() || offer.filename;
    const commonAttributes = `data-mime-type="${offer.mimeType}" data-file-size="${offer.size}" data-stored-filename="${storedFileName}"`;
    const senderAttributes = isSender ? `data-copied-path="${offer.path || ''}"` : '';
    const dataAttributes = `${commonAttributes} ${senderAttributes}`.trim();
    
    return `
      <div class="file-request" id="file-request-${offer.id}" ${dataAttributes}>
        <div class="file-info">
          <span class="file-icon">${icon}</span>
          <div class="file-details">
            <div class="file-name" title="${offer.filename}">${offer.filename}</div>
            <div class="file-meta">
              <span class="file-size">${fileSize}</span>
              <span class="file-status" id="status-${offer.id}">${statusText}</span>
            </div>
          </div>
        </div>
        <div class="progress-container">
          <div class="progress-bar" id="progress-${offer.id}" style="width: 0%">0%</div>
        </div>
        ${!isSender && !autoAccepted ? `
          <div class="file-actions">
            <button class="accept-btn" data-transfer-id="${offer.id}">${window.i18n?.t ? window.i18n.t('common.accept') : 'Accept'}</button>
            <button class="reject-btn" data-transfer-id="${offer.id}">${window.i18n?.t ? window.i18n.t('common.reject') : 'Reject'}</button>
          </div>
        ` : ''}
      </div>
    `;
  }

  async renderImageDisplay(offer, isSender, filePath = null) {
    try {
      const { createImageComponent } = await import('../../../../components/file-display/index.js');
      const component = await createImageComponent(offer, isSender, this.context, filePath);
      
      component.addEventListener('file-action', (e) => {
        const { transferId, action, filePath } = e.detail;
        this.context.ui?.fileTransferUI?.handleFileAction?.(transferId, action, filePath);
      });
      
      this.logger.info(`[FileTransferUI] renderImageDisplay: id=${offer.id}, isSender=${isSender}, filePath=${filePath}`);
      
      return component;
    } catch (error) {
      this.logger.error?.('[FileTransferUI] failed to create image display component:', error);
      return this._renderImageDisplayLegacy(offer, isSender, filePath);
    }
  }

  async _renderImageDisplayLegacy(offer, isSender, filePath = null) {
    let port = 8080;
    if (window.electronAPI && window.electronAPI.getHttpServerPort) {
      try {
        const result = await window.electronAPI.getHttpServerPort();
        if (result && result.success && result.port && result.port > 0) {
          port = result.port;
          this.logger.info(`[FileTransferUI] renderImageDisplay dynamicgetport: ${port}`);
        }
      } catch (e) {
        this.logger.warn(`[FileTransferUI] exception getting port: ${e.message}`);
      }
    }
    
    const fileName = offer.storedFileName || offer.filename;
    let directory = 'sends';
    
    if (!isSender) {
      directory = 'recvs';
    }
    
    const userId = this.context.myEmail || '';
    const imageUrl = `http://127.0.0.1:${port}/${userId}/files/${directory}/${encodeURIComponent(fileName)}`;
    
    // Generate thumbnail URL (prefer showing thumbnail)
    const { getThumbnailFileName } = await import('../../../../utils/thumbnail-utils.js');
    const thumbnailFileName = getThumbnailFileName(fileName);
    const thumbnailUrl = `http://127.0.0.1:${port}/${userId}/files/${directory}/${encodeURIComponent(thumbnailFileName)}`;
    
    this.logger.info(`[FileTransferUI] renderImageDisplay: id=${offer.id}, isSender=${isSender}, directory=${directory}, filePath=${filePath}`);
    
    const fileSize = this.utils.formatBytes(offer.size);
    const senderEmail = isSender ? this.context.myEmail : this.context.targetEmail;
    const receiverEmail = isSender ? this.context.targetEmail : this.context.myEmail;
    const fileInfo = `${window.i18n?.t ? window.i18n.t('common.fileName') : 'filename'}: ${offer.filename}\n${window.i18n?.t ? window.i18n.t('common.fileSize') : 'size'}: ${fileSize}\n${window.i18n?.t ? window.i18n.t('common.sender') : 'sender'}: ${senderEmail}\n${window.i18n?.t ? window.i18n.t('common.receiver') : 'receiver'}: ${receiverEmail}\n${window.i18n?.t ? window.i18n.t('common.transferMethod') : 'transfermethod'}: WebRTC`;
    
    const storedFileNameValue = offer.storedFileName || offer.filename;
    const filePathAttr = filePath ? ` data-file-path="${filePath}"` : '';
    
    // Prefer showing thumbnail; click to open original image
    return `
      <div class="image-message file-request" id="file-request-${offer.id}" data-stored-filename="${storedFileNameValue}"${filePathAttr} style="margin-top: 8px;">
        <img src="${thumbnailUrl}"
             data-original-src="${imageUrl}"
             alt="${fileName}"
             title="${fileInfo.replace(/\n/g, ' | ')}"
             style="max-width: 200px; height: auto; border-radius: 4px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.1);"
             onclick="window.open(this.dataset.originalSrc || this.src, '_blank');"
             onerror="if(this.dataset.originalSrc && this.src!==this.dataset.originalSrc && !this._fb){this._fb=1;this.src=this.dataset.originalSrc;}">
      </div>
    `;
  }

  async renderStreamingVideoMessage(offer, isSender = false) {
    try {
      const { createVideoComponent } = await import('../../../../components/file-display/index.js');
      const component = await createVideoComponent(offer, isSender, this.context);
      
      component.addEventListener('file-action', (e) => {
        const { transferId, action, filePath } = e.detail;
        this.context.ui?.fileTransferUI?.handleFileAction?.(transferId, action, filePath);
      });
      
      this.logger.info(`[FileTransferUI] renderStreamingVideoMessage: id=${offer.id}, isSender=${isSender}`);
      
      return component;
    } catch (error) {
      this.logger.error?.('[FileTransferUI] failed to create video display component:', error);
      return this._renderStreamingVideoMessageLegacy(offer, isSender);
    }
  }

  _renderStreamingVideoMessageLegacy(offer, isSender = false) {
    const fileSize = this.utils?.formatBytes(offer.size) || `${offer.size} bytes`;
    const directory = isSender ? 'sends' : 'recvs';
    
    return `
      <div class="streaming-video-message file-request" id="file-request-${offer.id}">
        <div class="video-container" id="video-container-${offer.id}">
          <video 
            controls 
            preload="metadata"
            style="max-width: 100%; width: 400px; border-radius: 8px; background: #000;"
            poster="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='225' viewBox='0 0 400 225'%3E%3Crect fill='%23333' width='400' height='225'/%3E%3Ctext fill='%23666' font-family='sans-serif' font-size='20' dy='10.5' font-weight='bold' x='50%25' y='50%25' text-anchor='middle'%3E${window.i18n?.t ? window.i18n.t('chat.videoLoading') : 'Video loading...'}%3C/text%3E%3C/svg%3E"
          >
            <p>${window.i18n?.t ? window.i18n.t('chat.browserNotSupportVideo') : 'Your browser does not support video playback'}</p>
          </video>
          <div class="video-overlay">
            <span class="stream-status">${isSender ? (window.i18n?.t ? window.i18n.t('chat.waitingSend') : 'waitsend...') : (window.i18n?.t ? window.i18n.t('chat.waitingReceiveData') : 'Waiting to receive data...')}</span>
            <span class="file-name" title="${offer.filename}">${offer.filename}</span>
            <span class="file-size">${fileSize}</span>
          </div>
          <div class="stream-progress-container">
            <div class="stream-progress" id="stream-progress-${offer.id}" style="width: 0%"></div>
          </div>
        </div>
      </div>
    `;
  }

  async renderFileComponentFromHistory(offer, isSender, filePath = null) {
    try {
      const component = await createFileDisplayComponent(
        offer,
        isSender,
        this.context,
        filePath
      );
      
      this.logger.info?.(`[FileTransferUI] create file component from history: ${offer.id}, type=${offer.mimeType}`);
      return component;
    } catch (error) {
      this.logger.error?.('[FileTransferUI] failed to create history file component:', error);
      return this._createFallbackHtml(offer, isSender);
    }
  }

  _createFallbackHtml(offer, isSender) {
    const div = document.createElement('div');
    div.className = 'file-request';
    div.id = `file-request-${offer.id}`;
    div.innerHTML = `
      <div class="file-info">
        <span class="file-icon">📄</span>
        <div class="file-details">
          <div class="file-name">${offer.filename}</div>
        </div>
      </div>
    `;
    return div;
  }
}