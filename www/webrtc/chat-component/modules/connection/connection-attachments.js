
import { ConnectionSignaling } from './connection-signaling.js';
import { getThumbnailFileName, deriveThumbnailUrl } from '../../../../utils/thumbnail-utils.js';

export class ConnectionManager extends ConnectionSignaling {
  constructor(context) {
    super(context);
    this._cachedHttpPort = null;
  }

  async getHttpPort() {
    if (this._cachedHttpPort) {
      return this._cachedHttpPort;
    }
    
    let httpPort = 8080;
    if (window.electronAPI && window.electronAPI.getHttpServerPort) {
      try {
        const result = await window.electronAPI.getHttpServerPort();
        if (result && result.success && result.port && result.port > 0) {
          httpPort = result.port;
          this.log(`✅ HTTP service port fetched successfully: ${httpPort}`);
        } else {
          this.log(`⚠️ HTTP service port fetch failed: ${JSON.stringify(result)}, usedefaultport ${httpPort}`);
        }
      } catch(e) {
        this.log(`⚠️ exception getting HTTP server port: ${e.message}, usedefaultport ${httpPort}`);
      }
    } else {
      this.log(`⚠️ electronAPI.getHttpServerPort unavailable, using default port ${httpPort}`);
    }
    
    this._cachedHttpPort = httpPort;
    return httpPort;
  }

  generateImageHtml(imageUrl, filename, fileSize, msgId, options = {}) {
    const { fromEmail = '', toEmail = '', useFileRequestId = false, thumbnailUrl = '' } = options;
    const fileInfo = fromEmail && toEmail 
      ? `filename: ${filename}\nsize: ${fileSize}\nsender: ${fromEmail}\nreceiver: ${toEmail}\ntransfermethod: Email`
      : `filename: ${filename}\nsize: ${fileSize}`;
    
    const elementId = useFileRequestId ? `file-request-${msgId}` : `image-${msgId}`;
    const imgSrc = thumbnailUrl || imageUrl;
    
    return `
      <div class="image-message" id="${elementId}" style="margin-top: 8px;">
        <img src="${imgSrc}" 
             alt="${filename}"
             title="${fileInfo.replace(/\n/g, ' | ')}"
             style="max-width: 200px; height: auto; border-radius: 4px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.1);"
             data-original-src="${imageUrl}"
             data-filename="${filename}"
             onclick="window.open(this.dataset.originalSrc || this.src, '_blank');"
             onerror="if(this.dataset.originalSrc && this.src!==this.dataset.originalSrc && !this._fb){this._fb=1;this.src=this.dataset.originalSrc;}">
        <div class="image-error-message" style="display: none; font-size: 12px; color: #999; padding: 8px;">
          📧 transfermethod: Email (image load failed)
        </div>
      </div>
    `;
  }

  generateFileHtml(fileUrl, filename, fileSize, msgId, options = {}) {
    const { fromEmail = '', toEmail = '', contentType = '' } = options;
    const fileInfo = fromEmail && toEmail 
      ? `filename: ${filename}\nsize: ${fileSize}\nsender: ${fromEmail}\nreceiver: ${toEmail}\ntransfermethod: Email`
      : `filename: ${filename}\nsize: ${fileSize}`;

    // Select icon based on MIME type
    let icon = '📄';
    if (contentType.startsWith('video/')) icon = '🎬';
    else if (contentType.startsWith('audio/')) icon = '🎵';
    else if (contentType === 'application/pdf') icon = '📕';
    else if (contentType.includes('zip') || contentType.includes('rar') || contentType.includes('7z') || contentType.includes('tar') || contentType.includes('gz')) icon = '📦';

    return `
      <div class="file-request" id="file-request-${msgId}" style="margin-top: 8px; padding: 10px; border: 1px solid #e0e0e0; border-radius: 8px; background: #f9f9f9; max-width: 300px;">
        <div class="file-info" style="display: flex; align-items: center; gap: 8px;">
          <span class="file-icon" style="font-size: 24px;">${icon}</span>
          <div class="file-details" style="flex: 1; min-width: 0;">
            <div class="file-name" style="font-weight: bold; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${filename}">${filename}</div>
            <div class="file-meta" style="font-size: 12px; color: #999;">
              <span class="file-size">${fileSize}</span>
              <span style="margin-left: 6px;">📧 emailtransfer</span>
            </div>
          </div>
        </div>
        <div style="margin-top: 6px;">
          <a href="${fileUrl}" download="${filename}" style="color: #1a73e8; font-size: 12px; text-decoration: none;">downloadfile</a>
        </div>
      </div>
    `;
  }

  bindImageErrorHandlers(msgId, useFileRequestId = false) {
    setTimeout(() => {
      const elementId = useFileRequestId ? `file-request-${msgId}` : `image-${msgId}`;
      const imageElement = this.context.shadowRoot.querySelector(`#${elementId} img`);
      
      if (imageElement) {
        const imageSrc = imageElement.dataset.originalSrc;
        const imageFileName = imageElement.dataset.filename;
        
        imageElement.addEventListener('error', () => {
          imageElement.style.display = 'none';
          const errorMsg = imageElement.nextElementSibling;
          if (errorMsg && errorMsg.classList.contains('image-error-message')) {
            errorMsg.innerHTML = `📧 Transfer method: Email<br>
              <span style="color: #666;">filename: ${imageFileName}</span><br>
              <span style="color: #999; font-size: 11px;">Please check the developer tools console for detailed errors</span>`;
            errorMsg.style.display = 'block';
          }
          this.log(`❌ image load failed: ${imageFileName}`);
          this.log(`   URL: ${imageSrc}`);
        });
        
        imageElement.addEventListener('click', () => {
          window.open(imageElement.dataset.originalSrc, '_blank');
        });
      }
    }, 100);
  }

  async handleReceivedAttachments(fromEmail, attachments) {
    if (!attachments || attachments.length === 0) return {};

    const IMAGE_MIME_TYPES = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml'
    ];

    const attachmentMap = {};
    const processedFiles = [];
    
    const httpPort = await this.getHttpPort();

    const attachmentGroupHash = fromEmail + '_' + attachments.map(a => `${a.filename}_${a.content ? a.content.length : 0}`).sort().join('|');
    if (this.processedAttachmentHashes.has(attachmentGroupHash)) {
      this.log(`⏭️ attachment group already processed, skip duplicate write`);
      return {}; 
    }

    this.log(`📦 processing from ${fromEmail}  ${attachments.length}  attachments`);

    for (const att of attachments) {
      try {
        const { filename, content, contentType } = att;

        if (!content) {
          this.log(`⚠️ attachment ${filename} content empty, skip`);
          continue;
        }

        if (window.electronAPI && window.electronAPI.saveReceivedFile) {
          this.log(`💾 processing attachment: ${filename} (${contentType})`);
          const userId = this.context.myEmail;
          const result = await window.electronAPI.saveReceivedFile(filename, content, userId);

          if (result.success) {
            this.log(`✅ attachment processed successfully: ${result.filePath}`);

            const fileName = result.filePath.split(/[/\\]/).pop();
            const localImagePath = `http://127.0.0.1:${httpPort}/${userId}/files/recvs/${fileName}`;
            const fileSize = this.context.utils.formatBytes(content.length || 0);
            
            attachmentMap[filename] = localImagePath;
            processedFiles.push(filename);

            if (IMAGE_MIME_TYPES.includes(contentType)) {
              this.log(`🖼️ image attachment ready, prepare to display: ${localImagePath}`);
              
              // Fix: ensure CID is not empty; generate random ID if att.cid is empty string
              const msgId = (att.cid && String(att.cid).trim() !== '') ? att.cid : `email-attachment-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
              this.log(`📧 image attachment CID: ${msgId}, original CID: ${att.cid}`);
              
              if (this.context.displayedMessageIds && this.context.displayedMessageIds.has(msgId)) {
                this.log(`⏭️ image already displayed, skip duplicate display: ${msgId}`);
                continue;
              }

              let thumbnailUrl = '';
              if (result.filePath && window.electronAPI?.generateThumbnail) {
                try {
                  const thumbResult = await window.electronAPI.generateThumbnail(result.filePath, 200);
                  if (thumbResult?.success && !thumbResult.skipped && thumbResult.thumbnailFileName) {
                    thumbnailUrl = `http://127.0.0.1:${httpPort}/${userId}/files/recvs/${encodeURIComponent(thumbResult.thumbnailFileName)}`;
                  }
                } catch (e) {
                  this.log(`⚠️ thumbnail generation failed (non-fatal): ${e.message}`);
                }
              }
              
              const imageHtml = this.generateImageHtml(localImagePath, filename, fileSize, msgId, {
                fromEmail: fromEmail,
                toEmail: this.context.myEmail,
                thumbnailUrl
              });
              
              await this.context.uiRenderer.displayMessage('peer', imageHtml, msgId, Date.now(), fromEmail, 100);
              this.log(`✅ email image displayed: ${msgId}`);
              
              this.bindImageErrorHandlers(msgId);
              
              if (window.electronAPI && window.electronAPI.saveChatMessage) {
                try {
                  await window.electronAPI.saveChatMessage({
                    fromer: fromEmail,
                    toer: this.context.myEmail || '',
                    content: imageHtml,
                    type: 2,
                    status: 100,
                    msgid: msgId
                  });
                  this.log(`✅ email image saved to database: ${msgId}`);
                } catch (error) {
                  this.log(`⚠️ failed to save email image to database: ${error.message}`);
                }
              }
              
              this.context.element.dispatchEvent(new CustomEvent('update-contact-last-message', {
                detail: { email: fromEmail, message: '[Image]' },
                bubbles: true,
                composed: true
              }));

              if (this.isConnected()) {
                if (msgId) {
                  this.sendImageAck(msgId, fromEmail);
                  this.log(`📧 email image received, sending ACK confirmation: ${msgId}`);
                }
              }
            } else {
              // Non-image files: display file message in chat
              this.log(`📎 file attachment ready, prepare to display: ${localImagePath}`);
              
              // Fix: ensure CID is not empty; generate random ID if att.cid is empty string
              const msgId = (att.cid && String(att.cid).trim() !== '') ? att.cid : `email-file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
              this.log(`📧 fileattachment CID: ${msgId}, original CID: ${att.cid}`);
              
              if (this.context.displayedMessageIds && this.context.displayedMessageIds.has(msgId)) {
                this.log(`⏭️ file already displayed, skip duplicate display: ${msgId}`);
                continue;
              }
              
              const fileHtml = this.generateFileHtml(localImagePath, filename, fileSize, msgId, {
                fromEmail: fromEmail,
                toEmail: this.context.myEmail,
                contentType: contentType
              });
              
              await this.context.uiRenderer.displayMessage('peer', fileHtml, msgId, Date.now(), fromEmail, 100);
              this.log(`✅ email file displayed: ${msgId}`);
              
              if (window.electronAPI && window.electronAPI.saveChatMessage) {
                try {
                  await window.electronAPI.saveChatMessage({
                    fromer: fromEmail,
                    toer: this.context.myEmail || '',
                    content: fileHtml,
                    type: 1,
                    status: 100,
                    msgid: msgId
                  });
                  this.log(`✅ email file saved to database: ${msgId}`);
                } catch (error) {
                  this.log(`⚠️ failed to save email file to database: ${error.message}`);
                }
              }
              
              this.context.element.dispatchEvent(new CustomEvent('update-contact-last-message', {
                detail: { email: fromEmail, message: `📎 ${filename}` },
                bubbles: true,
                composed: true
              }));

              if (this.isConnected()) {
                if (msgId) {
                  this.sendImageAck(msgId, fromEmail);
                  this.log(`📧 email file received, sending ACK confirmation: ${msgId}`);
                }
              }
            }
          } else {
            this.log(`❌ failed to process attachment: ${result.error}`);
          }
        }
      } catch (err) {
        this.context.logger.error(`failed to process attachment: ${err.message}`);
      }
    }

    if (processedFiles.length > 0) {
      this.processedAttachmentHashes.add(attachmentGroupHash);
    }

    return attachmentMap;
  }

  isConnected() {
    if (this.pc && this.pc.connectionState === 'connected') {
      return true;
    }
    if (this.context.dataChannelManager && typeof this.context.dataChannelManager.isOpen === 'function') {
      return this.context.dataChannelManager.isOpen();
    }
    return false;
  }

  sendImageAck(msgId, toEmail) {
    if (!msgId) return;

    if (!this.isConnected()) {
      this.log(`⚠️ WebRTC not connected, cannot send ACK: ${msgId}`);
      return;
    }

    if (this.context.connection && this.context.connection.sendData) {
      const ackMsg = { type: 'ack', id: msgId };
      const sent = this.context.connection.sendData(ackMsg);
      if (sent) {
        this.log(`✅ image ACK confirmation sent: ${msgId} -> ${toEmail}`);
      } else {
        this.log(`⚠️ send ACK failed: ${msgId}`);
      }
    } else {
      this.log(`⚠️ cannot send ACK, connection.sendData unavailable: ${msgId}`);
    }
  }
  
  async handleEmailAttachmentsWithMetadata(fromEmail, attachments, emailImageMetadata = null) {
    // Removed image-in-signaling-mail feature; use handleReceivedAttachments uniformly
    return await this.handleReceivedAttachments(fromEmail, attachments);
  }

  async waitForFileWriteComplete(filePath, expectedSize, maxWaitTime = 30000) {
    const startTime = Date.now();
    const checkInterval = 100;
    
    while (Date.now() - startTime < maxWaitTime) {
      try {
        if (window.electronAPI && window.electronAPI.getFileStats) {
          const stats = await window.electronAPI.getFileStats(filePath);
          if (stats && stats.size >= expectedSize) {
            this.log(`✅ file write completed: ${filePath}, size: ${stats.size}`);
            return true;
          }
        }
      } catch (e) {
      }
      
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
    
    this.log(`⚠️ waiting for file write timeout: ${filePath}`);
    return false;
  }

  async renderSignalingEmailImageDisplay(filePath, imgAtt, fromEmail, msgId) {
    const httpPort = await this.getHttpPort();
    const fileName = filePath.split(/[/\\]/).pop();
    const userId = this.context.myEmail || '';
    const imageUrl = `http://127.0.0.1:${httpPort}/${userId}/files/recvs/${fileName}`;
    const fileSize = this.context.utils.formatBytes(imgAtt.size || 0);
    
    this.log(`🖼️ renderSignalingEmailImageDisplay: port=${httpPort}, image URL=${imageUrl}`);
    
    return this.generateImageHtml(imageUrl, imgAtt.filename, fileSize, msgId, {
      fromEmail: fromEmail,
      toEmail: this.context.myEmail,
      useFileRequestId: true
    });
  }
}
