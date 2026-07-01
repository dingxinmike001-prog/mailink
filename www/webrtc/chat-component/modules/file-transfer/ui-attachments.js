/**
 * File transfer UI attachment/staging module
 * Handles displaying email attachments and updating staged file UI
 */

import { IMAGE_MIME_TYPES } from '../config.js';

export class AttachmentHandler {
  constructor(context) {
    this.context = context;
  }

  get logger() { return this.context.logger; }
  get utils() { return this.context.utils; }
  get electronAPI() { return window.electronAPI; }

  async showAttachment(file, from) {
    const chatDisplay = this.context.ui.chatDisplay;
    if (!chatDisplay) return;

    const msgContainer = document.createElement('div');
    msgContainer.className = 'message-container message-received';
    
    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'message-avatar avatar';
    avatarDiv.textContent = 'Peer';
    if (this.context.avatarManager) {
        this.context.avatarManager.getAvatar(from).then(avatar => {
             avatarDiv.innerHTML = this.context.avatarManager.buildAvatarHtml(avatar);
        }).catch(() => {});
    }

    const msgContent = document.createElement('div');
    msgContent.className = 'message-content';
    
    const isImage = IMAGE_MIME_TYPES.some(t => file.mimeType.toLowerCase().startsWith(t));

    let contentHtml = '';
    if (isImage && file.path) {
      let port = 8080;
      if (this.electronAPI && this.electronAPI.getHttpServerPort) {
        try {
          const result = await this.electronAPI.getHttpServerPort();
          if (result && result.success && result.port && result.port > 0) {
            port = result.port;
          }
        } catch (e) {}
      }
      
      const fileName = file.filename;
      const userId = this.context.myEmail || '';
      const imageUrl = `http://127.0.0.1:${port}/${userId}/files/recvs/${encodeURIComponent(fileName)}`;
      
      contentHtml = `
        <div class="image-message file-request" style="margin-top: 8px;">
          <img src="${imageUrl}"
               alt="${fileName}"
               style="max-width: 200px; height: auto; border-radius: 4px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.1);"
               onclick="window.open('${imageUrl}', '_blank');"
               onerror="this.style.display='none';">
        </div>`;
    } else {
         contentHtml = `
          <div class="file-attachment file-request" id="file-request-email-${Date.now()}">
              <div class="file-info">
                  <span class="file-icon">📎</span>
                  <div class="file-details">
                      <div class="file-name" title="${file.filename}">${file.filename}</div>
                      <div class="file-meta">
                          <span class="file-size">${this.utils.formatBytes(file.size)}</span>
                          <span class="file-actions-inline">
                              <button onclick="window.electronAPI.openFile('${file.path ? file.path.replace(/\\/g, '\\\\') : ''}')">open</button>
                              <button onclick="window.electronAPI.showItemInFolder('${file.path ? file.path.replace(/\\/g, '\\\\') : ''}')">locate</button>
                          </span>
                      </div>
                  </div>
              </div>
          </div>`;
    }

    msgContent.innerHTML = contentHtml;
    msgContainer.appendChild(avatarDiv);
    msgContainer.appendChild(msgContent);
    chatDisplay.appendChild(msgContainer);
    chatDisplay.scrollTop = chatDisplay.scrollHeight;
    
    if (isImage && file.path) {
      const transferId = `email-attachment-${Date.now()}`;
      msgContent.firstElementChild.id = `file-request-${transferId}`;
      setTimeout(() => {
        this.context.ui?.fileTransferUI?.showFileCompleteActions?.(transferId, file.path);
      }, 100);
    }
  }

  updateStagedFileUI(stagedFile, previewUrl, clearCallback) {
    const fileInfo = this.context.root.getElementById('fileInfo');
    
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }

    let newPreviewUrl = null;

    if (stagedFile) {
      const mimeType = (stagedFile.type || '').toLowerCase();
      const isImage = IMAGE_MIME_TYPES.some(type => mimeType.startsWith(type));

      if (fileInfo) {
        let previewHtml = '';
        if (isImage) {
          newPreviewUrl = URL.createObjectURL(stagedFile);
          previewHtml = `<img src="${newPreviewUrl}" title="Click to view original image" style="max-width: 200px; max-height: 300px; border-radius: 4px; margin-right: 8px; border: 1px solid #ddd; cursor: pointer;" onclick="window.open(this.src, '_blank')" >`;
        }

        fileInfo.innerHTML = `
          <div style="display: flex; flex-direction: column; align-items: flex-start; background: #f8f9fa; padding: 6px; border-radius: 4px; border: 1px dashed #ccc; margin-bottom: 5px; position: relative;">
            ${isImage ? `
            <div style="position: relative; display: inline-block;">
              ${previewHtml}
              <button id="clearStagedFileBtn" style="position: absolute; top: -8px; right: -8px; width: 20px; height: 20px; padding: 0; font-size: 12px; background: #ff4d4d; color: white; border: none; border-radius: 50%; cursor: pointer; box-shadow: 0 2px 4px rgba(0,0,0,0.2); display: flex; align-items: center; justify-content: center; z-index: 10;">✕</button>
            </div>
            ` : previewHtml}
            <div style="display: flex; align-items: center; width: 100%; margin-top: ${isImage ? '8px' : '0'};">
              <span style="margin-right: 8px; flex-grow: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: #666;">
                ${isImage ? '🖼️' : '📎'} ${stagedFile.name} (${this.utils.formatBytes(stagedFile.size)})
              </span>
              ${!isImage ? `<button id="clearStagedFileBtn" style="padding: 2px 8px; font-size: 11px; background: #999; color: white; border: none; border-radius: 3px; cursor: pointer;">✕</button>` : ''}
            </div>
          </div>
        `;
        
        const clearBtn = fileInfo.querySelector('#clearStagedFileBtn');
        if(clearBtn) clearBtn.onclick = clearCallback;
      }
    } else {
      if (fileInfo) fileInfo.innerHTML = '';
    }

    return newPreviewUrl;
  }

  removeMessageFromUI(msgId) {
    try {
      this.logger.info(`[FileTransferUI] from UIremovemessage: ${msgId}`);

      const shadowRoot = this.context.shadowRoot;
      let msgContainer = shadowRoot ? shadowRoot.querySelector(`#msg-container-${msgId}`) : null;
      if (!msgContainer) {
        msgContainer = this.context.root.querySelector(`#msg-container-${msgId}`);
      }
      if (msgContainer) {
        msgContainer.remove();
        this.logger.info(`[FileTransferUI] from UIremovemessage: ${msgId}`);
      }

      let fileRequestEl = shadowRoot ? shadowRoot.querySelector(`#file-request-${msgId}`) : null;
      if (!fileRequestEl) {
        fileRequestEl = this.context.root.querySelector(`#file-request-${msgId}`);
      }
      if (fileRequestEl && fileRequestEl.closest('.message-container')) {
        fileRequestEl.closest('.message-container').remove();
        this.logger.info(`[FileTransferUI] from UIremovefilerequest: ${msgId}`);
      }
    } catch (error) {
      this.logger.error(`[FileTransferUI] from UIremovemessagefailed: ${msgId}`, error);
    }
  }

  isMessageDisplayed(msgId) {
    const shadowRoot = this.context.shadowRoot;
    if (!shadowRoot || !msgId) return false;
    
    const msgContainer = shadowRoot.querySelector(`#msg-container-${msgId}`);
    if (msgContainer) return true;
    
    const fileRequest = shadowRoot.querySelector(`#file-request-${msgId}`);
    if (fileRequest) return true;
    
    const imageMessage = shadowRoot.querySelector(`.image-message[id="image-${msgId}"]`);
    if (imageMessage) return true;
    
    return false;
  }
}