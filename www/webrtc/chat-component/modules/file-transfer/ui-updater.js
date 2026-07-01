/**
 * File transfer UI message update module
 * Handles updating existing messages to image/video display
 */

import { IMAGE_MIME_TYPES } from '../config.js';

export class UpdaterHandler {
  constructor(context) {
    this.context = context;
  }

  get logger() { return this.context.logger; }
  get utils() { return this.context.utils; }

  isTransferComplete(id) {
    return this.context.ui?.fileTransferUI?._completedTransfers?.has(id) || false;
  }

  async updateMessageToImageDisplayWithHtml(id, imageHtml, isSender = false, filePath = null) {
    if (!imageHtml) {
      this.logger.error(`[FileTransferUI] updateMessageToImageDisplayWithHtml: imageHtml is empty`);
      return false;
    }
    
    const shadowRoot = this.context.shadowRoot;
    if (!shadowRoot) {
      this.logger.error(`[FileTransferUI] updateMessageToImageDisplayWithHtml: shadowRoot does not exist`);
      return false;
    }
    
    const maxRetries = 5;
    const retryDelay = 200;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let container = shadowRoot.querySelector(`#file-request-${id}`);
      
      if (!container) {
        const normalComponents = shadowRoot.querySelectorAll('normal-file-display');
        for (const comp of normalComponents) {
          const innerId = comp.shadowRoot?.querySelector('[id^="file-request-"]')?.id;
          if (innerId === `file-request-${id}`) {
            container = comp;
            break;
          }
        }
      }
      
      if (!container) {
        const imageComponents = shadowRoot.querySelectorAll('image-file-display');
        for (const comp of imageComponents) {
          const innerId = comp.shadowRoot?.querySelector('[id^="file-request-"]')?.id;
          if (innerId === `file-request-${id}`) {
            container = comp;
            break;
          }
        }
      }
      
      if (!container) {
        const msgContainer = shadowRoot.querySelector(`#msg-container-${id}`);
        if (msgContainer) {
          container = msgContainer.querySelector(`#file-request-${id}`);
        }
      }
      
      if (!container) {
        const allFileRequests = shadowRoot.querySelectorAll('[id^="file-request-"]');
        for (const elem of allFileRequests) {
          if (elem.id === `file-request-${id}`) {
            container = elem;
            break;
          }
        }
      }
      
      if (container) {
        this.logger.info(`[FileTransferUI] attempt ${attempt} found container element, update with saved HTML`);
        
        const isWebComponent = container.tagName === 'NORMAL-FILE-DISPLAY' || container.tagName === 'IMAGE-FILE-DISPLAY';
        const containerRoot = isWebComponent ? container.shadowRoot : container;
        
        const progressContainer = containerRoot?.querySelector('.progress-container');
        const fileStatus = containerRoot?.querySelector('.file-status');
        const fileInfo = containerRoot?.querySelector('.file-info');
        const existingImage = containerRoot?.querySelector('.image-message');
        
        if (progressContainer) progressContainer.style.display = 'none';
        if (fileStatus) fileStatus.style.display = 'none';
        if (fileInfo) fileInfo.style.display = 'none';

        const msgContainer = shadowRoot.querySelector(`#msg-container-${id}`);
        const messageStatus =
          shadowRoot.querySelector(`#msg-status-${id}`) ||
          msgContainer?.querySelector('.message-status') ||
          shadowRoot.querySelector(`#status-${id}.message-status`);
        if (messageStatus) {
          messageStatus.remove();
        }

        if (isWebComponent) {
          const imageContainer = document.createElement('div');
          imageContainer.innerHTML = imageHtml;
          const imageElement = imageContainer.firstElementChild;
          
          if (imageElement) {
            container.parentNode.replaceChild(imageElement, container);
            this.logger.info(`[FileTransferUI] Web Component replace as imageHTML: ${id}`);
            return true;
          } else {
            this.logger.error(`[FileTransferUI] imageHtml parsing produced no valid element`);
            return false;
          }
        }

        if (existingImage) {
          existingImage.remove();
        }
        
        const imageContainer = document.createElement('div');
        imageContainer.innerHTML = imageHtml;
        
        const imageElement = imageContainer.firstElementChild;
        if (imageElement) {
          if (imageElement.id === container.id) {
            container.parentNode.replaceChild(imageElement, container);
            this.logger.info(`[FileTransferUI] image display replaced container: ${id}`);
            container = imageElement;
          } else {
            container.appendChild(imageElement);
            this.logger.info(`[FileTransferUI] image display update completed: ${id}`);
          }
          
          const actionsContainer = container.querySelector('.file-complete-actions');
          if (!actionsContainer && filePath) {
            this.logger.info(`[FileTransferUI] show file action buttons after image update: ${id}, filePath=${filePath}`);
            this.context.ui?.fileTransferUI?.showFileCompleteActions?.(id, filePath);
          }
          
          return true;
        } else {
          this.logger.error(`[FileTransferUI] imageHtml parsing produced no valid element`);
          return false;
        }
      }
      
      if (attempt < maxRetries) {
        this.logger.warn(`[FileTransferUI] attempt ${attempt} did not find container element, retry after ${retryDelay}ms`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
    
    this.logger.info(`[FileTransferUI] container element does not exist, skip update: #file-request-${id}`);
    return false;
  }

  async updateMessageToImageDisplay(id, offer, isSender, filePath = null) {
    const shadowRoot = this.context.shadowRoot;
    if (!shadowRoot) {
      this.logger.error(`[FileTransferUI] updateMessageToImageDisplay: shadowRoot does not exist`);
      return false;
    }

    if (!offer || typeof offer !== 'object') {
      this.logger.error(`[FileTransferUI] updateMessageToImageDisplay: offer invalid`);
      return false;
    }

    if (!offer.id) {
      offer.id = id;
    }

    const imgFileDisplays = shadowRoot.querySelectorAll('image-file-display');
    for (const comp of imgFileDisplays) {
      const compId = comp.shadowRoot?.querySelector('[id^="file-request-"]')?.id;
      if (compId === `file-request-${id}`) {
        this.logger.info(`[FileTransferUI] Web Component image component already exists, request it to reload image: ${id}`);
        if (typeof comp.reloadImage === 'function') {
           comp.reloadImage();
        } else {
           const img = comp.shadowRoot.querySelector('img');
           const errorDiv = comp.shadowRoot.querySelector('.image-error');
           if (img && img.src) {
               const baseUrl = img.src.split('?')[0];
               img.src = `${baseUrl}?t=${Date.now()}`;
               img.style.display = 'block';
               if (errorDiv) {
                 errorDiv.style.display = 'none';
               }
           }
        }
        
        if (filePath && typeof comp.showComplete === 'function') {
           comp.showComplete(filePath);
        }

        const msgContainer = shadowRoot.querySelector(`#msg-container-${id}`);
        if (msgContainer) {
          const statusSpan = msgContainer.querySelector('.message-status');
          if (statusSpan) statusSpan.remove();
        }
        
        return true;
      }
    }

    const existingComponent = shadowRoot.querySelector(`#file-request-${id}`);
    if (existingComponent) {
      const existingImg = existingComponent.querySelector('img');
      if (existingImg) {
        const loaded = existingImg.complete && existingImg.naturalWidth > 0;
        if (loaded) {
          this.logger.info(`[FileTransferUI] traditional HTML image already loaded, skip duplicate display: ${id}`);
          return true;
        }
        this.logger.warn(`[FileTransferUI] existing traditional HTML image did not load successfully, try force refresh: ${id}`);
        const currentSrc = existingImg.src.split('?')[0];
        existingImg.src = `${currentSrc}?t=${Date.now()}`;
        existingImg.style.display = 'block';
        return true;
      }
    }

    try {
      this.logger.info(`[FileTransferUI] updateMessageToImageDisplay: start creating component, id=${id}, isSender=${isSender}, filePath=${filePath}`);
      
      const { createImageComponent } = await import('../../../../components/file-display/index.js');
      const imageComponent = await createImageComponent(offer, isSender, this.context, filePath);
      this.logger.info(`[FileTransferUI] updateMessageToImageDisplay: component created, id=${id}`);
      
      let msgContainer = shadowRoot.querySelector(`#msg-container-${id}`);
      let retryCount = 0;
      const maxRetries = 15; // [FIX] Increase retry count to ensure historical messages are loaded
      
      while (!msgContainer && retryCount < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 200)); // [FIX] Increase wait time
        msgContainer = shadowRoot.querySelector(`#msg-container-${id}`);
        retryCount++;
        this.logger.info(`[FileTransferUI] retry finding message container: #msg-container-${id}, try ${retryCount}/${maxRetries}`);
      }
      
      if (!msgContainer) {
        this.logger.warn(`[FileTransferUI] message container does not exist, skipupdate: #msg-container-${id}. possible reason: history messages not yet loaded`);
        return false;
      }
      this.logger.info(`[FileTransferUI] found message container: #msg-container-${id}`);
      
      const msgContent = msgContainer.querySelector('.message-content');
      if (!msgContent) {
        this.logger.error(`[FileTransferUI] message content area not found`);
        return false;
      }
      this.logger.info(`[FileTransferUI] found message content area`);
      
      let msgText = msgContent.querySelector('.message-text');
      if (!msgText) {
        msgText = document.createElement('div');
        msgText.className = 'message-text';
        msgContent.insertBefore(msgText, msgContent.firstChild);
      }
      this.logger.info(`[FileTransferUI] message-text container ready`);

      const webComponents = msgContent.querySelectorAll('normal-file-display, image-file-display, video-file-display, audio-file-display') ||
                            msgText.querySelectorAll('normal-file-display, image-file-display, video-file-display, audio-file-display');
      webComponents.forEach(comp => {
        const innerId = comp.shadowRoot?.querySelector('[id^="file-request-"]')?.id;
        if (innerId === `file-request-${id}`) {
          comp.remove();
          this.logger.info(`[FileTransferUI] removed Web Component: ${comp.tagName}, id=${id}`);
        }
      });

      const oldNormalComponent = msgContent.querySelector(`#file-request-${id}`) ||
                                  msgText.querySelector(`#file-request-${id}`) ||
                                  msgContainer.querySelector(`#file-request-${id}`);
      if (oldNormalComponent) {
        oldNormalComponent.remove();
        this.logger.info(`[FileTransferUI] removed old component: ${id}`);
      }

      const existingImageComponent = msgContent.querySelector('image-file-display') ||
                                     msgText.querySelector('image-file-display');
      if (existingImageComponent) {
        const innerId = existingImageComponent.shadowRoot
          ?.querySelector('[id^="file-request-"]')
          ?.id;
        if (innerId === `file-request-${id}`) {
          const img = existingImageComponent.shadowRoot?.querySelector('img');
          const errorEl = existingImageComponent.shadowRoot?.querySelector('.image-error');
          const loaded = !!(img && img.complete && img.naturalWidth > 0 && img.style.display !== 'none');
          const failed = !!(img && img.complete && img.naturalWidth === 0) ||
                         !!(errorEl && errorEl.style.display !== 'none');

          if (loaded) {
            this.logger.info(`[FileTransferUI] image component already exists and loaded, skip adding: ${id}`);
            return true;
          }

          if (failed) {
            this.logger.warn(`[FileTransferUI] image component exists but load failed, prepare to re-render: ${id}`);
          } else {
            this.logger.warn(`[FileTransferUI] image component exists but not loaded, prepare to re-render: ${id}`);
          }

          existingImageComponent.remove();
        }
      }
      
      this.logger.info(`[FileTransferUI] prepare to add image component to message-text`);
      
      msgText.appendChild(imageComponent);
      this.logger.info(`[FileTransferUI] image component added to DOM`);
      
      if (filePath) {
        this.logger.info(`[FileTransferUI] prepare to show completed state, filePath=${filePath}`);
        imageComponent.showComplete(filePath);
        this.logger.info(`[FileTransferUI] completed state displayed`);
      }
      
      const statusSpan = msgContent.querySelector('.message-status');
      if (statusSpan) {
        statusSpan.remove();
      }
      
      this.logger.info(`[FileTransferUI] image display updated: ${id}`);
      return true;
      
    } catch (error) {
      this.logger.error(`[FileTransferUI] failed to create image component: ${id}`, error);
      const imageHtml = await this._renderImageDisplayLegacy(offer, isSender, filePath);
      return this.context.ui?.fileTransferUI?.updateMessageToImageDisplayWithHtml?.(id, imageHtml, isSender, filePath);
    }
  }

  async _renderImageDisplayLegacy(offer, isSender, filePath = null) {
    let port = 8080;
    if (window.electronAPI && window.electronAPI.getHttpServerPort) {
      try {
        const result = await window.electronAPI.getHttpServerPort();
        if (result && result.success && result.port && result.port > 0) {
          port = result.port;
        }
      } catch (e) {}
    }
    
    const fileName = offer.storedFileName || offer.filename;
    const directory = isSender ? 'sends' : 'recvs';
    const imageUrl = `http://127.0.0.1:${port}/${directory}/${encodeURIComponent(fileName)}`;
    
    const fileSize = this.utils.formatBytes(offer.size);
    const senderEmail = isSender ? this.context.myEmail : this.context.targetEmail;
    const receiverEmail = isSender ? this.context.targetEmail : this.context.myEmail;
    const fileInfo = `filename: ${offer.filename}\nsize: ${fileSize}\nsender: ${senderEmail}\nreceiver: ${receiverEmail}\ntransfermethod: WebRTC`;
    
    const storedFileNameValue = offer.storedFileName || offer.filename;
    const filePathAttr = filePath ? ` data-file-path="${filePath}"` : '';
    
    return `
      <div class="image-message file-request" id="file-request-${offer.id}" data-stored-filename="${storedFileNameValue}"${filePathAttr} style="margin-top: 8px;">
        <img src="${imageUrl}"
             alt="${fileName}"
             title="${fileInfo.replace(/\n/g, ' | ')}"
             style="max-width: 200px; height: auto; border-radius: 4px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.1);"
             onclick="window.open('${imageUrl}', '_blank');"
             onerror="this.style.display='none';">
      </div>
    `;
  }

  updateVideoPlayStatus(transferId, canPlay, percent, receivedSize) {
    const shadowRoot = this.context.shadowRoot;
    if (!shadowRoot) return;

    const statusEl = shadowRoot.querySelector(`#video-container-${transferId} .stream-status`);
    const progressEl = shadowRoot.querySelector(`#stream-progress-${transferId}`);

    if (statusEl) {
      if (canPlay) {
        statusEl.textContent = `Can play (${Math.round(percent)}%)`;
        statusEl.classList.add('playable');
      } else {
        statusEl.textContent = `Buffering... ${Math.round(percent)}%`;
      }
    }

    if (progressEl) {
      progressEl.style.width = `${Math.min(100, percent)}%`;
    }
  }
}