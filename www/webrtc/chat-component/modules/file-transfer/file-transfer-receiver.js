/**
 * File transfer receiver module
 * Handles receiving file offer, chunk processing, write queue, and transfer completion
 */

import { IMAGE_MIME_TYPES } from '../config.js';
import { getThumbnailFileName, deriveThumbnailUrl } from '../../../../utils/thumbnail-utils.js';
import { debugConfigCache } from '../../../../utils/common.js';

// Audio file MIME types
const AUDIO_MIME_TYPES = [
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/mp3'
];
import { MP4StreamingReceiver } from '../mp4-streaming/mp4-streaming-receiver.js';
import { markMessageAsCompleted } from '../../../../utils/status.js';
import { generateFileId } from '../../../../utils/common.js';
import { BaseTransferReceiver } from './base-transfer-receiver.js';
import { _triggerTrayFlash, _playNotificationSound, _notifyUnreadIncrement } from '../chat-message.js';
import { checkFileSecurity, getSecurityWarningMessage } from '../../../../../shared/security/file-security.js';

export class FileTransferReceiver extends BaseTransferReceiver {
  constructor(context, uiManager, stateManager) {
    super(context, uiManager, stateManager);
    
    // Receiving-related state
    this.progressSnapshots = new Map();
    
    // Silent receive mode
    this.silentReceiveMode = false;
    this.silentReceiveId = null;
    
    // Transport configuration
    this.transferSpeed = 0;
    
    // MP4 streaming receiver
    this.mp4StreamingReceiver = new MP4StreamingReceiver(context, uiManager);
  }



  /**
   * Initialize file receive
   */
  async initFileReceiving(offer, offset = 0, autoAccepted = false) {
    if (!this.fileChunks.has(offer.id)) {
      this.fileChunks.set(offer.id, {
        totalSize: offer.size,
        receivedSize: offset
      });
      this.logger.info(`[FileTransferReceiver] receiver initialized: ${offer.id}, offset=${offset}`);
    }

    if (!this.fileOffers.has(offer.id)) {
      // [FIX] Don't directly use storedFileName from sender; it's the sender's local sends directory file name
      // Receiver should use its own recvs directory; storedFileName will be set after finalizeStreamFile
      this.fileOffers.set(offer.id, {
        filename: offer.filename,
        size: offer.size,
        mimeType: offer.mimeType,
        storedFileName: null  // Initialize to null, waiting for local generation
      });
    }

    const existingRequest = this.context.root?.querySelector(`#file-request-${offer.id}`);
    if (!existingRequest && this.context.uiRenderer?.displayMessage) {
      try {
        const htmlMessage = await this.uiManager.renderFileRequestMessage(offer, false, autoAccepted);
        this.context.uiRenderer.displayMessage('peer', htmlMessage, offer.id, Date.now(), this.context.targetEmail, 100);
      } catch (error) {
        this.logger.error?.(`[FileTransferReceiver] failed to render file request message: ${error.message}`);
      }
    }

    if (autoAccepted) {
      const requestEl = this.context.root?.querySelector(`#file-request-${offer.id}`);
      if (requestEl) {
        const progressContainer = requestEl.querySelector('.progress-container');
        const fileActions = requestEl.querySelector('.file-actions');
        if (progressContainer) progressContainer.style.display = 'block';
        if (fileActions) fileActions.style.display = 'none';
      }
    }

    if (offset > 0) {
      const progress = Math.min(100, Math.round((offset / offer.size) * 100));
      setTimeout(() => {
        this.uiManager.updateProgressDisplay(offer.id, progress, offset, offer.size, this.transferSpeed);
      }, 100);
    }
    
    this.saveState();
  }

  /**
   * Save state
   */
  saveState() {
    this.stateManager.saveTransferState(this.fileChunks, this.fileOffers, new Map(), this.progressSnapshots);
  }

  /**
   * Handle file offer
   */
  async handleFileOffer(offer) {
    this.logger.info(`[FileTransferReceiver] receivedfilerequest: ${offer.id} ${offer.filename}, size: ${offer.size} bytes`);

    // Security verification: check if it is a dangerous file
    const securityCheck = checkFileSecurity({
      name: offer.filename,
      type: offer.mimeType,
      size: offer.size
    });

    if (securityCheck.isDangerous) {
      this.logger.warn(`[FileTransferReceiver] blocked dangerous filerequest: ${offer.filename}, reason: ${securityCheck.reasons.join(', ')}`);

      // Send reject message
      const rejectMsg = {
        type: 'file-reject',
        id: offer.id,
        reason: 'SECURITY_VIOLATION',
        message: window.i18n?.t ? window.i18n.t('chat.fileBlocked') : 'block: forbiddenreceivecan/mayexecutefile'
      };
      this.connection.sendData(rejectMsg);

      // Show security warning
      const warningHtml = `<div class="file-request security-warning" id="file-request-${offer.id}">
        <div class="file-info">
          <span class="file-icon">⚠️</span>
          <div class="file-details">
            <div class="file-name">${offer.filename}</div>
            <div class="file-meta">
              <span class="file-status" style="color: #ff4444;">${window.i18n?.t ? window.i18n.t('chat.fileBlocked') : 'block: forbiddenreceivecan/mayexecutefile'}</span>
            </div>
          </div>
        </div>
      </div>`;
      this.context.uiRenderer.displayMessage('system', warningHtml, offer.id, Date.now(), 'system', 100);
      return;
    }

    // Check if it is MP4 streaming
    if (this.mp4StreamingReceiver.isMP4StreamOffer(offer)) {
      this.logger.info(`[FileTransferReceiver] detected MP4 streaming request: ${offer.id}`);
      await this.mp4StreamingReceiver.handleMP4StreamOffer(offer);
      return;
    }

    // Plan 3: check if message has been fully received (status=100)
    // If already received via email or previous WebRTC transfer, send ACK and skip
    const alreadyReceived = await this.checkMessageAlreadyReceivedDB(offer.id);
    if (alreadyReceived) {
      this.logger.info(`[FileTransferReceiver] messagecompletereceive, send ACK confirmation: ${offer.id}`);
      this.sendAck(offer.id);
      return;
    }

    // Check if the message already exists (received via email but possibly incomplete)
    const existingMsg = await this.checkExistingMessageDB(offer.id);
    if (existingMsg) {
      this.logger.info(`[FileTransferReceiver] messagevia emailreceive, send ACK confirmation: ${offer.id}`);
      this.sendAck(offer.id);

      // If file size is 0, it's a duplicate empty file; do not receive data
      if (offer.size === 0) {
        this.logger.warn(`[FileTransferReceiver] file size is 0, skip receiving: ${offer.id}`);
        return;
      }

      // Otherwise silently receive WebRTC data (possibly for resume or completion)
      // [FIX] Do not save sender's storedFileName; use locally generated one
      this.fileOffers.set(offer.id, {
        ...offer,
        storedFileName: null
      });
      setTimeout(() => this.acceptFileSilently(offer.id), 100);
      return;
    }

    // [FIX] Do not save sender's storedFileName; use locally generated one
    this.fileOffers.set(offer.id, {
      ...offer,
      storedFileName: null
    });

    const isImage = IMAGE_MIME_TYPES.includes(offer.mimeType);
    const autoAccepted = isImage;

    // Trigger new message notification (tray flash, sound, unread count)
    _triggerTrayFlash(this.context);
    _playNotificationSound(this.context);

    const messageComponent = await this.uiManager.renderFileRequestMessage(offer, false, autoAccepted);

    // Pass component object directly to displayMessage for proper handling
    this.context.uiRenderer.displayMessage('peer', messageComponent, offer.id, Date.now(), this.context.targetEmail, 100);

    // Get HTML string for storage and events
    let htmlMessage;
    if (messageComponent instanceof HTMLElement) {
      htmlMessage = messageComponent.outerHTML;
    } else {
      htmlMessage = messageComponent;
    }

    document.dispatchEvent(new CustomEvent('updateContactLastMessage', {
        detail: {
            email: this.context.targetEmail,
            message: htmlMessage
        }
    }));

    // Trigger unread message count increase (red badge notification)
    _notifyUnreadIncrement(this.context, new Set(), this.context.targetEmail, offer.id);

    if (this.electronAPI && this.electronAPI.saveChatMessage) {
        this.electronAPI.saveChatMessage({
            fromer: this.context.targetEmail || 'unknown',
            toer: this.context.myEmail || '',
            content: htmlMessage,
            type: 2,
            status: 100,
            msgid: offer.id
        });
    }

    if (isImage) {
      setTimeout(() => this.acceptFile(offer.id), 100);
    }
  }



  /**
   * Silently accept file transfer
   */
  async acceptFileSilently(transferId) {
    const offer = this.fileOffers.get(transferId);
    if (!offer) {
      this.logger.warn(`[FileTransferReceiver] acceptFileSilently: findnot to  offer ${transferId}`);
      return;
    }

    this.logger.info(`[FileTransferReceiver] silently accept file transfer: ${offer.filename}, id: ${offer.id}`);

    const acceptMsg = {
      type: 'file-accept',
      id: offer.id,
      offset: 0,
      supportsBinary: true
    };

    this.connection.sendData(acceptMsg);
    this.logger.info(`[FileTransferReceiver] silently accept file transfer request sent: ${offer.filename}`);

    await this.initFileReceiving(offer, 0, true);

    this.silentReceiveMode = true;
    this.silentReceiveId = offer.id;
  }

  /**
   * Accept file
   */
  async acceptFile(transferId) {
    this.logger.info(`[FileTransferReceiver] acceptFile called: transferId=${transferId}`);
    
    const offer = this.fileOffers.get(transferId);
    if (!offer) {
      this.logger.error(`[FileTransferReceiver] acceptFile failed: corresponding offer not found, transferId=${transferId}`);
      this.logger.info(`[FileTransferReceiver] all IDs in current fileOffers: ${Array.from(this.fileOffers.keys()).join(', ')}`);
      return;
    }

    this.logger.info(`[FileTransferReceiver] prepare to accept file: ${offer.filename}, id=${offer.id}`);

    let offset = 0;

    if (this.electronAPI && this.electronAPI.getTransferMetadata && !IMAGE_MIME_TYPES.includes(offer.mimeType)) {
        const result = await this.findResumeOffset(offer);
        offset = result.offset;
    }

    const acceptMsg = {
        type: 'file-accept',
        id: offer.id,
        offset: offset,
        protocolVersion: 2,
        supportsBinary: true
    };

    this.connection.sendData(acceptMsg);
    this.uiManager.updateFileRequestStatus(offer.id, offset > 0 ? `${window.i18n?.t ? window.i18n.t('chat.continueTransfer') : 'continuetransfer (from  {size} start)...'}`.replace('{size}', this.utils.formatBytes(offset)) : (window.i18n?.t ? window.i18n.t('chat.acceptedTransferring') : 'Accepted, transferring...'));
    this.uiManager.hideAcceptRejectButtons(offer.id);
    const isImage = IMAGE_MIME_TYPES.includes(offer.mimeType);

    await this.initFileReceiving(offer, offset, true);
    
    if (!isImage) {
      this.uiManager.showTransferProgress(offer.filename, offer.size, offer.id, true, this.context.targetEmail);
    }
  }

  /**
   * Reject file
   */
  rejectFile(transferId) {
    this.logger.info(`[FileTransferReceiver] rejectFile called: transferId=${transferId}`);
    const offer = this.fileOffers.get(transferId);
    if (!offer) {
      this.logger.warn(`[FileTransferReceiver] rejectFile: corresponding offer not found, transferId=${transferId}`);
      return;
    }

    const rejectMsg = {
        type: 'file-reject',
        id: offer.id
    };

    this.connection.sendData(rejectMsg);
    this.uiManager.updateFileRequestStatus(offer.id, window.i18n?.t ? window.i18n.t('chat.transferInterrupted') : 'Rejected');
    this.uiManager.hideAcceptRejectButtons(offer.id);
  }

  /**
   * Process file data
   */
  handleFileData(data) {
    // Check if it's MP4 streaming data
    if (data.isMP4Stream || this.mp4StreamingReceiver.fileOffers.has(data.id)) {
      this.mp4StreamingReceiver.handleMP4Data(data);
      return;
    }

    // Use cached debug flag to avoid frequent localStorage reads
    const trace = debugConfigCache.isEnabled('MAILINK_FILE_TRANSFER_TRACE', '1');

    const dataSize =
      data && data.data
        ? (typeof data.data === 'string' ? data.data.length : (data.data.byteLength || data.data.size || 0))
        : 0;

    if (trace) {
      this.logger.info(`[FileTransferReceiver] handleFileData: id=${data.id}, offset=${data.offset}, size=${dataSize}`);
    }
    
    if (!this.fileChunks.has(data.id)) {
        this.logger.warn(`[FileTransferReceiver] fileChunks in progressNot found ${data.id}, tryinitialize...`);
        const offer = this.fileOffers.get(data.id);
        if (!offer) {
            this.logger.error(`[FileTransferReceiver] offerdoes not exist: ${data.id}`);
            return;
        }
        if (!data) {
            this.logger.error(`[FileTransferReceiver] filedatainvalid: ${data.id}`);
            return;
        }

        this.logger.info(`[FileTransferReceiver] receiver initialized: ${data.id}, offset=${data.offset || 0}`);
        
        this.fileChunks.set(data.id, {
            totalSize: offer.size,
            receivedSize: data.offset || 0
        });
    }
    
    const fileData = this.fileChunks.get(data.id);
    const offer = this.fileOffers.get(data.id);
    
    if (!offer) {
        this.logger.error(`[FileTransferReceiver] offerdoes not exist: ${data.id}`);
        return;
    }
    
    if (trace) {
      this.logger.info(`[FileTransferReceiver] processfiledata: receivedSize=${fileData.receivedSize}/${offer.size}`);
    }
    
    if (this.electronAPI && this.electronAPI.streamWriteFileChunk) {
      const queue = this.recvWriteQueues.get(data.id) || [];
      queue.push({
        id: data.id,
        offer,
        fileData,
        chunk: data.data,
        offset: data.offset,
        totalSize: data.totalSize,
        userId: this.context.myEmail,
        trace
      });
      this.recvWriteQueues.set(data.id, queue);
      this.drainRecvWriteQueue(data.id);
      
      this.saveState();
    } else {
      this.logger.error(`[FileTransferReceiver] electronAPI.streamWriteFileChunkdoes not exist!`);
    }
  }



  /**
   * Write single receive chunk
   */
  async writeOneRecvChunk(item) {
    const { id, offer, fileData, chunk, offset, totalSize, userId, trace } = item;
    
    let finalChunk = chunk;
    let originalChunkSize = chunk?.byteLength || chunk?.length || 0;
    
    if (typeof chunk === 'string' && chunk.length > 0) {
      try {
        const binaryString = window.atob(chunk);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        finalChunk = bytes;
        originalChunkSize = bytes.length;
      } catch (e) {
        this.logger.warn(`[FileTransferReceiver] Base64decodefailed, useoriginaldata: ${e.message}`);
        finalChunk = chunk;
      }
    }
    
    if (trace) {
      this.logger.info(`[FileTransferReceiver] callstreamWriteFileChunk: id=${id}, offset=${offset}, size=${originalChunkSize}`);
    }

    try {
      const result = await this.electronAPI.streamWriteFileChunk(
        offer.filename,
        finalChunk,
        offset,
        totalSize,
        id,
        userId,
        false,  // flush
        offer.storedFileName  // Pass the redirected storage name to reuse old files for resume
      );

      if (trace) {
        this.logger.info(`[FileTransferReceiver] streamWriteFileChunksucceeded: offset=${offset}`);
      }

      if (!result || !result.success) {
        this.logger.error(`[FileTransferReceiver] streamWriteFileChunkwrite failed: id=${id}, offset=${offset}`);
        throw new Error(`filewrite failed: ${result?.error || 'not knowerror'}`);
      }

      const writtenBytes = result && typeof result.writtenBytes === 'number' ? result.writtenBytes : 0;
      const endOffset = result && typeof result.endOffset === 'number'
        ? result.endOffset
        : (typeof offset === 'number' ? offset + writtenBytes : 0);

      if (result && result.storedFileName) {
        offer.storedFileName = result.storedFileName;
      }

      const currentSize = fileData.receivedSize || 0;
      const newReceivedSize = Math.max(currentSize, endOffset);
      
      if (writtenBytes !== originalChunkSize) {
        this.logger.warn(`[FileTransferReceiver] writedatasizenot match: expected=${originalChunkSize}, actualwrite=${writtenBytes}`);
      }
      
      fileData.receivedSize = newReceivedSize;

      const total = typeof offer.size === 'number' ? offer.size : (typeof totalSize === 'number' ? totalSize : 0);
      const progress = total > 0 ? Math.min(100, Math.round((fileData.receivedSize / total) * 100)) : 0;
      this.uiManager.updateProgressDisplay(id, progress, fileData.receivedSize, total, this.transferSpeed);

      this.sendReceiverProgress(id, fileData.receivedSize, total, progress);

      const lastLogged = typeof fileData.lastLoggedEndOffset === 'number' ? fileData.lastLoggedEndOffset : 0;
      const interval = 2 * 1024 * 1024;
      const shouldLogProgress = trace || endOffset === total || endOffset - lastLogged >= interval || lastLogged === 0;
      if (shouldLogProgress) {
        fileData.lastLoggedEndOffset = endOffset;
        this.logger.info(`[FileTransferReceiver] disk write progress: ${offer.filename} ${endOffset}/${total || '?'}`);
      }

      if (result && result.closed) {
        const isImage = offer && IMAGE_MIME_TYPES.includes(offer.mimeType);
        
        if (result.verified === true) {
          this.uiManager.updateFileRequestStatus(id, window.i18n?.t ? window.i18n.t('chat.saveComplete') : 'Save completed');
          this.fileChunks.delete(id);

          if (!isImage && result.filePath) {
            this.logger.info(`[FileTransferReceiver] disk write completed, show file action buttons: id=${id}, filePath=${result.filePath}`);
            this.uiManager.showFileCompleteActions(id, result.filePath);
          }

          markMessageAsCompleted(id, {
            fromer: this.context.targetEmail,
            dbUser: this.context.myEmail,
            retry: true,
            maxRetries: 2
          });
          if (this.electronAPI && this.electronAPI.deleteTransferMetadata) {
            this.electronAPI.deleteTransferMetadata({
              msgId: id,
              userId: this.context.myEmail
            });
          }
        } else if (typeof result.actualSize === 'number' && total > 0) {
          const missing = Math.max(0, total - result.actualSize);
          this.uiManager.updateFileRequestStatus(id, `${window.i18n?.t ? window.i18n.t('chat.receiveIncomplete') : 'receivenot complete(missing {size})'}`.replace('{size}', this.utils.formatBytes(missing)));
        } else {
          this.uiManager.updateFileRequestStatus(id, window.i18n?.t ? window.i18n.t('chat.saveComplete') : 'Save completed');
          this.fileChunks.delete(id);
        }
      }

      return result;
    } catch (error) {
      this.logger.error(`[FileTransferReceiver] streamWriteFileChunk exception: id=${id}, offset=${offset}`, error);
      throw error;
    }
  }

  /**
   * Wait for receive queue to complete
   */
  async waitForRecvQueueComplete(transferId, offer) {
    const maxWaitTime = 30000;
    const startTime = Date.now();
    const checkInterval = 100;

    while (Date.now() - startTime < maxWaitTime) {
      const queue = this.recvWriteQueues.get(transferId);
      const inflight = this.recvWriteInflight.get(transferId) || 0;

      if ((!queue || queue.length === 0) && inflight === 0) {
        // Check if offer exists
        if (!offer) {
          this.logger.warn(`[FileTransferReceiver] waitreceivequeuecompleted: offer does not exist, skipintegritycheck: ${transferId}`);
          return false;
        }
        const integrityResult = await this.verifyFileIntegrity(transferId, offer.filename, offer.size);
        if (integrityResult.complete) {
          this.logger.info(`[FileTransferReceiver] receivequeuecompleted, filecomplete: ${transferId}`);
          return true;
        }
      }

      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    this.logger.warn(`[FileTransferReceiver] waitreceivequeuecompletedtimeout: ${transferId}`);
    return false;
  }

  /**
   * Handle file completion
   */
  async handleFileComplete(data) {
    // Check if data.id is valid
    if (!data || !data.id) {
      this.logger.error(`[FileTransferReceiver] handleFileComplete: data.id invalid`, data);
      return;
    }

    // Check if MP4 streaming transfer is complete
    if (data.isMP4Stream || this.mp4StreamingReceiver.fileOffers.has(data.id)) {
      await this.mp4StreamingReceiver.handleFileComplete(data);
      return;
    }

    const isSilentMode = this.silentReceiveMode && this.silentReceiveId === data.id;
    if (isSilentMode) {
      this.logger.info(`[FileTransferReceiver] silentreceivemode, skipUIupdate: ${data.id}`);
    } else {
      this.uiManager.updateFileRequestStatus(data.id, window.i18n?.t ? window.i18n.t('chat.completing') : 'completed...');
    }

    const offer = this.fileOffers.get(data.id);
    const isImage = offer && IMAGE_MIME_TYPES.includes(offer.mimeType);

    this.logger.info(`[FileTransferReceiver] offer: ${offer ? offer.filename : 'null'}, mimeType: ${offer ? offer.mimeType : 'null'}, isImage: ${isImage}`);

    if (offer) {
      this.logger.info(`[FileTransferReceiver] file transfer completion verification: ${offer.filename}, expected size: ${offer.size} bytes, mimeType: ${offer.mimeType}`);
    }

    const isSender = false;

    this.logger.info(`[FileTransferReceiver] handleFileComplete: id=${data.id}, isImage=${isImage}, silentMode=${isSilentMode}`);

    // If offer does not exist, log error and return
    if (!offer) {
      this.logger.error(`[FileTransferReceiver] handleFileComplete: corresponding offer not found, id=${data.id}`);
      return;
    }

    await this.waitForRecvQueueComplete(data.id, offer);
    
    if (isSilentMode) {
      this.logger.info(`[FileTransferReceiver] silentReceive completed, clean@:  ${data.id}`);
      this.fileChunks.delete(data.id);
      this.fileOffers.delete(data.id);
      this.silentReceiveMode = false;
      this.silentReceiveId = null;
      return;
    }
    
    if (this.electronAPI && this.electronAPI.finalizeStreamFile) {
        if (offer) {
            this.logger.info(`[FileTransferReceiver] call finalizeStreamFile: filename=${offer.filename}, id=${offer.id}, size=${offer.size}`);
            const userId = this.context.myEmail;
            const result = await this.electronAPI.finalizeStreamFile(offer.filename, offer.id, offer.size, userId);
            this.logger.info(`[FileTransferReceiver] finalizeStreamFile result:`, result);
            if (result && result.success) {
              if (result.storedFileName) {
                offer.storedFileName = result.storedFileName;
              }

              // [NEW] Send ACK message to sender confirming successful disk write
              if (result.verified === true || isImage) {
                const saveSuccessMsg = {
                  type: 'file-save-success',
                  id: data.id
                };
                this.connection.sendData(saveSuccessMsg);
                this.logger.info(`[FileTransferReceiver] sent disk-write success confirmation to sender (file-save-success): ${data.id}`);
              }

              let hashVerified = false;
              if (offer.fileHash && result.fileHash) {
                hashVerified = offer.fileHash === result.fileHash;
                this.logger.info(`[FileTransferReceiver] filehashverify: ${offer.filename}, verification passed: ${hashVerified}`);
              } else if (offer.fileHash && !result.fileHash) {
                hashVerified = result.verified === true;
              }

              this.logger.info(`[FileTransferReceiver] condition check: result.verified=${result.verified}, result.actualSize=${result.actualSize}, offer.size=${offer.size}, hashVerified=${hashVerified}, isImage=${isImage}`);

              if (result.verified === false && typeof result.actualSize === 'number' && typeof offer.size === 'number') {
                const missing = Math.max(0, offer.size - result.actualSize);
                this.uiManager.updateFileRequestStatus(data.id, `${window.i18n?.t ? window.i18n.t('chat.receiveIncomplete') : 'receivenot complete(missing {size})'}`.replace('{size}', this.utils.formatBytes(missing)));

                // Try to display image even if transfer is incomplete (partial images may render)
                if (isImage) {
                  this.logger.warn(`[FileTransferReceiver] imagetransfernot complete, but still try to display: ${offer.filename}`);
                }
              } else if (hashVerified === false && offer.fileHash && result.fileHash) {
                this.uiManager.updateFileRequestStatus(data.id, window.i18n?.t ? window.i18n.t('chat.hashVerifyFailed') : 'filehashverifyfailed');

                // Try to display image even if hash verification fails
                if (isImage) {
                  this.logger.warn(`[FileTransferReceiver] image hash verification failed, but still try to display: ${offer.filename}`);
                }
              } else {
                this.logger.info(`[FileTransferReceiver] displayfilecompletedaction buttons: id=${data.id}, filePath=${result.filePath}`);
                this.logger.info(`[FileTransferReceiver] call updateFileRequestStatus: id=${data.id}, status=Save completed`);
                this.uiManager.updateFileRequestStatus(data.id, window.i18n?.t ? window.i18n.t('chat.saveComplete') : 'Save completed');
                this.logger.info(`[FileTransferReceiver] calling showFileCompleteActions: id=${data.id}`);
                this.uiManager.showFileCompleteActions(data.id, result.filePath);
              }

              this.fileChunks.delete(data.id);
              if (result.verified === true) {
                if (this.electronAPI && this.electronAPI.updateMessageStatus) {
                  this.electronAPI.updateMessageStatus({
                    msgid: data.id,
                    status: 100,
                    fromer: this.context.targetEmail,
                    dbUser: this.context.myEmail
                  });
                }
                if (this.electronAPI && this.electronAPI.deleteTransferMetadata) {
                  this.electronAPI.deleteTransferMetadata({
                    msgId: data.id,
                    userId: this.context.myEmail
                  });
                }
              }
            } else {
              this.logger.error(`[FileTransferReceiver] finalizeStreamFile failed:`, result);
            }

            const isAudio = AUDIO_MIME_TYPES.includes(offer.mimeType) ||
                           offer.filename.toLowerCase().endsWith('.mp3') ||
                           offer.filename.toLowerCase().endsWith('.ogg');

            if (isImage) {
              try {
                this.logger.info(`[FileTransferReceiver] updating image display: ${data.id}`);
                this.logger.info(`[FileTransferReceiver] offer info:`, {
                  id: offer.id,
                  filename: offer.filename,
                  storedFileName: offer.storedFileName,
                  mimeType: offer.mimeType
                });
                this.logger.info(`[FileTransferReceiver] result info:`, {
                  filePath: result.filePath,
                  storedFileName: result.storedFileName
                });

                // Update image display using Web Component (consistent with regular files)
                // Increase delay to ensure file is fully written and HTTP server is accessible
                const delayTime = 1000;
                this.logger.info(`[FileTransferReceiver] wait ${delayTime}ms ensurefile write completedafterreloadimage: ${data.id}`);
                await new Promise(resolve => setTimeout(resolve, delayTime));

                // Verify file accessibility (optional, reduces log noise)
                let fileAccessible = false;
                let checkAttempts = 0;
                const maxCheckAttempts = 3;
                const checkInterval = 300;
                
                while (!fileAccessible && checkAttempts < maxCheckAttempts) {
                  try {
                    const fileName = offer.storedFileName || offer.filename;
                    const imageUrl = await this._getImageUrl(fileName, isSender);
                    const response = await fetch(imageUrl, { method: 'HEAD', cache: 'no-cache' });
                    if (response.ok) {
                      fileAccessible = true;
                      this.logger.info(`[FileTransferReceiver] fileaccessible: ${data.id}`);
                    } else if (response.status === 404) {
                      // File not ready yet, continue waiting
                      checkAttempts++;
                      if (checkAttempts < maxCheckAttempts) {
                        await new Promise(resolve => setTimeout(resolve, checkInterval));
                      }
                    } else {
                      // Other errors, log but continue
                      this.logger.debug(`[FileTransferReceiver] filecheckstatus ${response.status}: ${data.id}`);
                      checkAttempts++;
                      if (checkAttempts < maxCheckAttempts) {
                        await new Promise(resolve => setTimeout(resolve, checkInterval));
                      }
                    }
                  } catch (fetchError) {
                    // Network error, server may not have finished starting
                    checkAttempts++;
                    if (checkAttempts < maxCheckAttempts) {
                      await new Promise(resolve => setTimeout(resolve, checkInterval));
                    }
                  }
                }

                if (!fileAccessible) {
                  this.logger.debug(`[FileTransferReceiver] filecheckcompleted, will tryloadimage: ${data.id}`);
                }

                const updateSuccess = await this.uiManager.updateMessageToImageDisplay(data.id, offer, isSender, result.filePath);

                if (updateSuccess) {
                  this.logger.info(`[FileTransferReceiver] image displayUpdate completed: ${data.id}`);

                  this.uiManager.showFileCompleteActions(data.id, result.filePath);
                  this.logger.info(`[FileTransferReceiver] Displayedimageaction buttons: ${data.id}`);

                  if (result.filePath && this.electronAPI?.generateThumbnail) {
                    this.electronAPI.generateThumbnail(result.filePath, 200).then(thumbResult => {
                      if (thumbResult?.success && !thumbResult.skipped) {
                        this.logger.info(`[FileTransferReceiver] thumbnail generation succeeded: ${data.id}, thumbnailPath=${thumbResult.thumbnailPath}`);
                      }
                    }).catch(err => {
                      this.logger.warn?.(`[FileTransferReceiver] thumbnail generation failed (non-fatal): ${data.id}, ${err?.message}`);
                    });
                  }

                  if (this.electronAPI && this.electronAPI.updateChatMessageContent) {
                    const shadowRoot = this.context.shadowRoot;
                    const fileRequestEl =
                      shadowRoot?.querySelector(`#file-request-${data.id}`) ||
                      shadowRoot?.querySelector(`#msg-container-${data.id} #file-request-${data.id}`);

                    if (fileRequestEl) {
                      let contentToSave = fileRequestEl.outerHTML;
                      if (fileRequestEl.tagName === 'IMAGE-FILE-DISPLAY') {
                        const fileName = offer.storedFileName || offer.filename;
                        const imageUrl = await this._getImageUrl(fileName, false);
                        const thumbnailFileName = getThumbnailFileName(fileName);
                        const thumbnailUrl = await this._getImageUrl(thumbnailFileName, false);
                        const senderEmail = this.context.targetEmail;
                        const receiverEmail = this.context.myEmail;
                        const fileSize = this.utils.formatBytes(offer.size);
                        const fileInfo = `filename: ${offer.filename} | size: ${fileSize} | sender: ${senderEmail} | receiver: ${receiverEmail} | transfermethod: WebRTC`;

                        contentToSave = `<div class="image-message file-request" id="file-request-${data.id}" data-stored-filename="${fileName}" data-file-path="${result.filePath}" style="margin-top: 8px;">
                          <img src="${thumbnailUrl}" data-original-src="${imageUrl}" alt="${fileName}" title="${fileInfo}" style="max-width: 200px; height: auto; border-radius: 4px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.1);" onclick="window.open(this.dataset.originalSrc || this.src, '_blank');" onerror="if(this.dataset.originalSrc && this.src!==this.dataset.originalSrc && !this._fb){this._fb=1;this.src=this.dataset.originalSrc;}">
                        </div>`;
                      }
                      await this.electronAPI.updateChatMessageContent({
                        msgid: data.id,
                        fromer: isSender ? this.context.myEmail : this.context.targetEmail,
                        toer: isSender ? this.context.targetEmail : this.context.myEmail,
                        content: contentToSave,
                        dbUser: this.context.myEmail
                      });
                      this.logger.info(`[FileTransferReceiver] image messagecontentUpdatedto datalibrary: ${data.id}`);
                    }
                  }
                } else {
                  this.logger.error(`[FileTransferReceiver] imageUIupdatefailed: ${data.id}`);
                }
              } catch (error) {
                this.logger.error(`[FileTransferReceiver] imageprocessexception:`, error);
              }
            } else if (isAudio) {
              // Audio file handling
              try {
                this.logger.info(`[FileTransferReceiver] updateaudiodisplay: ${data.id}`);
                
                // Wait for component render to complete
                await new Promise(resolve => setTimeout(resolve, 300));
                
                // Find audio component
                const shadowRoot = this.context.shadowRoot;
                const audioComponent =
                  shadowRoot?.querySelector(`audio-file-display[offer*="${data.id}"]`) ||
                  shadowRoot?.querySelector(`#msg-container-${data.id} audio-file-display`);
                
                if (audioComponent && audioComponent.showComplete) {
                  audioComponent.showComplete(result.filePath);
                  this.logger.info(`[FileTransferReceiver] audiodisplayUpdate completed: ${data.id}`);
                }
                
                // Show action buttons
                this.uiManager.showFileCompleteActions(data.id, result.filePath);
                
                // Save to database (converted to plain HTML)
                if (this.electronAPI && this.electronAPI.updateChatMessageContent) {
                  const fileName = offer.storedFileName || offer.filename;
                  const folder = 'recvs';
                  const currentPort = this.context.httpServerPort || 8080;
                  const audioUrl = `http://127.0.0.1:${currentPort}/${folder}/${encodeURIComponent(fileName)}`;
                  
                  // Determine MIME type
                  let audioMimeType = offer.mimeType || 'audio/mpeg';
                  if (offer.filename.toLowerCase().endsWith('.ogg') && !audioMimeType) {
                    audioMimeType = 'audio/ogg';
                  }
                  
                  // Format file size
                  let fileSizeStr = '';
                  if (offer.size) {
                    if (offer.size < 1024) {
                      fileSizeStr = `${offer.size} B`;
                    } else if (offer.size < 1024 * 1024) {
                      fileSizeStr = `${(offer.size / 1024).toFixed(1)} KB`;
                    } else {
                      fileSizeStr = `${(offer.size / (1024 * 1024)).toFixed(1)} MB`;
                    }
                  }
                  
                  const contentToSave = `<div class="audio-message file-request transfer-completed" id="file-request-${data.id}" data-stored-filename="${fileName}" data-is-sender="false">
                    <div class="audio-container">
                      <div class="audio-info">
                        <span class="file-icon">🎵</span>
                        <div class="file-details">
                          <div class="file-name" title="${offer.filename}">${offer.filename}</div>
                          <div class="file-meta">
                            <span class="file-size">${fileSizeStr}</span>
                            <span class="file-status">Receive completed</span>
                          </div>
                        </div>
                      </div>
                      <div class="audio-player-container">
                        <audio controls preload="metadata" style="width: 100%; height: 40px; border-radius: 20px;">
                          <source src="${audioUrl}" type="${audioMimeType}">
                          <p>Your browser does not support audio playback</p>
                        </audio>
                      </div>
                    </div>
                  </div>`;
                  
                  await this.electronAPI.updateChatMessageContent({
                    msgid: data.id,
                    fromer: this.context.targetEmail,
                    toer: this.context.myEmail,
                    content: contentToSave,
                    dbUser: this.context.myEmail
                  });
                  this.logger.info(`[FileTransferReceiver] audiomessagecontentUpdatedto datalibrary: ${data.id}`);
                }
              } catch (error) {
                this.logger.error(`[FileTransferReceiver] audioprocessexception:`, error);
              }
            } else {
              const offer = this.fileOffers.get(data.id);
              if (offer) {
                this.uiManager.updateProgressDisplay(data.id, 100, offer.size, offer.size, this.transferSpeed);
              }

              let renderedCompletedComponent = null;
              if (result?.filePath) {
                renderedCompletedComponent = await this._replaceWithCompletedFileComponent(data.id, offer, result.filePath);
              }
              
              if (this.electronAPI && this.electronAPI.updateChatMessageContent) {
                const fileRequestEl = renderedCompletedComponent || this._findFileRequestElement(data.id);
                
                if (fileRequestEl) {
                  const isWebComponent = fileRequestEl.tagName === 'NORMAL-FILE-DISPLAY' || 
                                         fileRequestEl.tagName === 'IMAGE-FILE-DISPLAY' ||
                                         fileRequestEl.tagName === 'VIDEO-FILE-DISPLAY';
                  
                  // Convert Web Components to plain HTML before saving
                  let contentToSave = fileRequestEl.outerHTML;
                  if (fileRequestEl.tagName === 'NORMAL-FILE-DISPLAY') {
                    const fileName = fileRequestEl.shadowRoot?.querySelector('.file-name')?.textContent || 'file';
                    const fileSize = fileRequestEl.shadowRoot?.querySelector('.file-size')?.textContent || '';
                    const storedFileName = (result?.storedFileName || offer?.storedFileName || (result?.filePath ? result.filePath.split(/[\\/]/).pop() : '')).trim();
                    const filePathAttr = result?.filePath ? ` data-file-path="${result.filePath}"` : '';
                    const storedFileAttr = storedFileName ? ` data-stored-filename="${storedFileName}"` : '';
                    const mimeTypeAttr = offer?.mimeType ? ` data-mime-type="${offer.mimeType}"` : '';
                    const fileSizeAttr = Number.isFinite(offer?.size) ? ` data-file-size="${offer.size}"` : '';
                    contentToSave = `<div class="file-request" id="file-request-${data.id}"${mimeTypeAttr}${fileSizeAttr}${storedFileAttr}${filePathAttr} data-is-sender="false">
                      <div class="file-info">
                        <span class="file-icon">📔</span>
                        <div class="file-details">
                          <div class="file-name">${fileName}</div>
                          <div class="file-meta">
                            <span class="file-size">${fileSize}</span>
                            <span class="file-status">Receive completed</span>
                          </div>
                        </div>
                      </div>
                    </div>`;
                  }
                  
                  const actionsContainer = isWebComponent 
                    ? fileRequestEl.shadowRoot?.querySelector('.file-complete-actions')
                    : fileRequestEl.querySelector('.file-complete-actions');
                    
                  if (!actionsContainer && result.filePath) {
                    this.logger.info(`[FileTransferReceiver] non-image file missing action buttons, re-adding: ${data.id}`);
                    this.uiManager.showFileCompleteActions(data.id, result.filePath);
                  }
                  
                  this.logger.info(`[FileTransferReceiver] updatenon-image filemessagecontentto datalibrary: ${data.id}, includebutton: ${!!(isWebComponent ? fileRequestEl.shadowRoot?.querySelector('.file-complete-actions') : fileRequestEl.querySelector('.file-complete-actions'))}`);
                  await this.electronAPI.updateChatMessageContent({
                    msgid: data.id,
                    status: 100,
                    fromer: this.context.targetEmail,
                    toer: this.context.myEmail,
                    content: contentToSave,
                    dbUser: this.context.myEmail
                  });
                } else {
                  this.logger.warn(`[FileTransferReceiver] findnot to filerequestelement, unable toupdatedatalibrary: ${data.id}`);
                }
              }
            }
            
            this.saveState();
            setTimeout(() => {
              this.stateManager.clearTransferState();
            }, 5000);
            
            setTimeout(async () => {
              await this.validateAndFixImageDisplay(data.id, offer, isImage, isSender, result.filePath);
            }, 6000);
        }
    }
  }

  /**
   * Save image display to database
   * @param {string} id - Transfer ID
   * @param {Object} offer - File offer
   * @param {boolean} isSender - Whether this is the sender
   * @param {string} filePath - File path (optional, for embedding into HTML)
   */
  async saveImageDisplayToDatabase(id, offer, isSender = false, filePath = null) {
    try {
      // Build image URL and HTML (no longer depends on component returned by renderImageDisplay)
      const fileName = offer.storedFileName || offer.filename;
      this.logger.info(`[FileTransferReceiver] saveImageDisplayToDatabase: id=${id}, storedFileName=${offer.storedFileName}, filename=${offer.filename}, fileName=${fileName}, isSender=${isSender}`);
      const imageUrl = await this._getImageUrl(fileName, isSender);
      this.logger.info(`[FileTransferReceiver] saveImageDisplayToDatabase: imageUrl=${imageUrl}`);
      const senderEmail = isSender ? this.context.myEmail : this.context.targetEmail;
      const receiverEmail = isSender ? this.context.targetEmail : this.context.myEmail;
      const fileSize = this.utils.formatBytes(offer.size);
      const fileInfo = `filename: ${offer.filename} | size: ${fileSize} | sender: ${senderEmail} | receiver: ${receiverEmail} | transfermethod: WebRTC`;
      
      const imageHtml = `<div class="image-message file-request" id="file-request-${id}" data-stored-filename="${fileName}" data-file-path="${filePath}" style="margin-top: 8px;">
        <img src="${imageUrl}" alt="${fileName}" title="${fileInfo}" style="max-width: 200px; height: auto; border-radius: 4px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.1);" onclick="window.open('${imageUrl}', '_blank');">
      </div>`;
      
      if (!this.electronAPI || !this.electronAPI.updateChatMessageContent) {
        this.logger.error(`[FileTransferReceiver] saveImageDisplayToDatabase: API unavailable`);
        return null;
      }
      
      const fromer = isSender ? this.context.myEmail : this.context.targetEmail;
      const toer = isSender ? this.context.targetEmail : this.context.myEmail;
      const dbUser = this.context.myEmail;
      
      let retryCount = 0;
      const maxRetries = 3;
      let lastError = null;
      
      while (retryCount < maxRetries) {
        try {
          await this.electronAPI.updateChatMessageContent({
            msgid: id,
            fromer: fromer,
            toer: toer,
            content: imageHtml,
            dbUser: dbUser
          });
          this.logger.info(`[FileTransferReceiver] image displaysave to database: ${id}, url=${imageUrl}`);
          return imageHtml;
        } catch (error) {
          lastError = error;
          retryCount++;
          this.logger.warn(`[FileTransferReceiver] saveimage displayto datalibraryfailed (attempt ${retryCount}/${maxRetries}):`, error);
          
          if (retryCount < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
          }
        }
      }
      
      if (lastError) {
        this.logger.error(`[FileTransferReceiver] saveimage displayto datalibrary eventuallyfailed:`, lastError);
      }
      
      return null;
    } catch (error) {
      this.logger.error(`[FileTransferReceiver] saveImageDisplayToDatabase exception:`, error);
      return null;
    }
  }

  /**
   * Validate and fix image display
   */
  async validateAndFixImageDisplay(id, offer, isImage, isSender = false, filePath = null) {
    if (!isImage || !this.electronAPI || !this.electronAPI.updateChatMessageContent) {
      return;
    }
    
    this.logger.info(`[FileTransferReceiver] startverifyimage display@:  ${id}`);
    
    try {
      const shadowRoot = this.context.shadowRoot;
      if (!shadowRoot) {
        this.logger.warn(`[FileTransferReceiver] verifyfailed: shadowRoot does not exist`);
        return;
      }
      
      const fileRequestEl = shadowRoot.querySelector(`#file-request-${id}`);
      if (!fileRequestEl) {
        this.logger.warn(`[FileTransferReceiver] verifyfailed: findnot to filerequestelement`);
        return;
      }
      
      const existingImage = fileRequestEl.querySelector('.image-message');
      if (existingImage) {
        this.logger.info(`[FileTransferReceiver] verification passed: alreadyisimage display@:  ${id}`);
        return;
      }
      
      this.logger.info(`[FileTransferReceiver] verification found image display needs fix: ${id}`);
      
      const updateSuccess = await this.uiManager.updateMessageToImageDisplay(id, offer, isSender, filePath);
      if (updateSuccess) {
        const updatedEl = shadowRoot.querySelector(`#file-request-${id}`);
        if (updatedEl) {
          // Convert Web Components to plain HTML before saving
          let contentToSave = updatedEl.outerHTML;
          if (updatedEl.tagName === 'IMAGE-FILE-DISPLAY') {
            // Use _getImageUrl to build the correct image URL
            const fileName = offer.storedFileName || offer.filename;
            const imageUrl = await this._getImageUrl(fileName, isSender);
            const senderEmail = isSender ? this.context.myEmail : this.context.targetEmail;
            const receiverEmail = isSender ? this.context.targetEmail : this.context.myEmail;
            const fileSize = this.utils.formatBytes(offer.size);
            const fileInfo = `filename: ${offer.filename} | size: ${fileSize} | sender: ${senderEmail} | receiver: ${receiverEmail} | transfermethod: WebRTC`;
            
            contentToSave = `<div class="image-message file-request" id="file-request-${id}" data-stored-filename="${fileName}" data-file-path="${filePath}" style="margin-top: 8px;">
              <img src="${imageUrl}" alt="${fileName}" title="${fileInfo}" style="max-width: 200px; height: auto; border-radius: 4px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.1);" onclick="window.open('${imageUrl}', '_blank');">
            </div>`;
          }
          await this.electronAPI.updateChatMessageContent({
            msgid: id,
            fromer: isSender ? this.context.myEmail : this.context.targetEmail,
            toer: isSender ? this.context.targetEmail : this.context.myEmail,
            content: contentToSave
          });
          this.logger.info(`[FileTransferReceiver] image displayfixcompleted: ${id}`);
        }
      } else {
        this.logger.error(`[FileTransferReceiver] image displayfixfailed: ${id}`);
      }
    } catch (error) {
      this.logger.error(`[FileTransferReceiver] image displayverifyandfixexception:`, error);
    }
  }

  /**
   * Verify file integrity
   * @param {string} transferId - Transfer ID
   * @param {string} originalFilename - Original filename
   * @param {number} expectedSize - Expected file size
   * @param {boolean} isSender - Whether this is the sender (determines sends or recvs directory)
   */
  async verifyFileIntegrity(transferId, originalFilename, expectedSize, isSender = false) {
    try {
      // Determine whether to search sends or recvs directory based on isSender
      const userId = this.context.myEmail;
      
      // Fix: only try lookup by transferId when transferId is not empty
      let filePath = '';
      if (transferId && String(transferId).trim() !== '') {
        const pathResult = await this.electronAPI.getSentFilePath(`${transferId}-${originalFilename}`, isSender, userId);
        if (pathResult && pathResult.success) {
          filePath = pathResult.filePath;
        }
      }
      
      // If the above lookup fails, try searching by original filename
      if (!filePath) {
        const directResult = await this.electronAPI.getSentFilePath(originalFilename, isSender, userId);
        if (directResult && directResult.success) {
          filePath = directResult.filePath;
        }
      }

      if (!filePath) {
        this.logger.info(`[FileTransferReceiver] file pathdoes not exist: ${originalFilename}, isSender=${isSender}`);
        return { complete: false, actualSize: 0, filePath: '' };
      }

      const sizeResult = await this.electronAPI.getFileSize(filePath);
      if (!sizeResult || !sizeResult.success) {
        this.logger.warn(`[FileTransferReceiver] unable to getfile size: ${filePath}`);
        return { complete: false, actualSize: 0, filePath };
      }

      const actualSize = sizeResult.size;
      const isComplete = actualSize === expectedSize;

      this.logger.info(`[FileTransferReceiver] fileintegrityverify: ${originalFilename}, isSender=${isSender}, expected: ${expectedSize}, actual: ${actualSize}, complete: ${isComplete}`);
      
      return { complete: isComplete, actualSize, filePath };
    } catch (error) {
      this.logger.error(`[FileTransferReceiver] verifyfileintegrityfailed:`, error);
      return { complete: false, actualSize: 0, filePath: '' };
    }
  }

  /**
   * Handle progress updates (from sender's file-progress message)
   * Only log, do not update UI to avoid conflicting with local write progress
   * Do not trigger tryFinalizeTransfer here because receiver may still be processing write queue
   * Finalization is triggered by handleFileComplete
   */
  updateProgress(data) {
    if (!data || !data.id) return;

    this.logger.info(`[FileTransferReceiver] received sender progress: id=${data.id}, progress=${data.progress}%, sent=${data.receivedSize}, total=${data.totalSize}`);
  }

  /**
   * Send receiver's disk write progress to sender
   */
  sendReceiverProgress(transferId, receivedSize, totalSize, progress) {
    const progressMsg = {
      type: 'receiver-file-progress',
      id: transferId,
      receivedSize: receivedSize,
      totalSize: totalSize,
      progress: progress
    };

    if (this.connection && typeof this.connection.sendData === 'function') {
      this.connection.sendData(progressMsg);
    }
  }

  /**
   * Try to finalize transfer
   */
  async tryFinalizeTransfer(transferId, totalSize) {
    const offer = this.fileOffers.get(transferId);
    if (!offer) return;
    if (offer._finalizeStarted) return;
    offer._finalizeStarted = true;
    const isImage = offer && IMAGE_MIME_TYPES.includes(offer.mimeType);

    if (this.electronAPI && this.electronAPI.finalizeStreamFile) {
      try {
        const userId = this.context.myEmail;
        const result = await this.electronAPI.finalizeStreamFile(offer.filename, offer.id, typeof totalSize === 'number' ? totalSize : offer.size, userId);
        if (result && result.success) {
          if (result.storedFileName) {
            offer.storedFileName = result.storedFileName;
          }
          
          this.logger.info(`[FileTransferReceiver] fileverifyresult: ${offer.filename}, expected size: ${offer.size}, actualsize: ${result.actualSize}, verification passed: ${result.verified}`);
          
          if (typeof result.verified === 'boolean' && typeof result.actualSize === 'number' && typeof offer.size === 'number') {
            if (result.verified) {
              this.uiManager.updateFileRequestStatus(offer.id, window.i18n?.t ? window.i18n.t('chat.saveComplete') : 'Save completed');
              if (!isImage && result.filePath) {
                this.uiManager.showFileCompleteActions(offer.id, result.filePath);
              }
              if (this.electronAPI && this.electronAPI.updateMessageStatus) {
                this.electronAPI.updateMessageStatus({
                  msgid: offer.id,
                  status: 100,
                  fromer: this.context.targetEmail,
                  dbUser: this.context.myEmail
                });
              }
              if (this.electronAPI && this.electronAPI.deleteTransferMetadata) {
                this.electronAPI.deleteTransferMetadata({
                  msgId: offer.id,
                  userId: this.context.myEmail
                });
              }
              if (!isImage && this.electronAPI && this.electronAPI.updateChatMessageContent) {
                const shadowRoot = this.context.shadowRoot;
                if (shadowRoot) {
                  let fileRequestEl = shadowRoot.querySelector(`#file-request-${offer.id}`);
                  if (!fileRequestEl) {
                    const msgContainer = shadowRoot.querySelector(`#msg-container-${offer.id}`);
                    if (msgContainer) {
                      fileRequestEl = msgContainer.querySelector(`#file-request-${offer.id}`);
                    }
                  }
                  if (fileRequestEl) {
                    this.logger.info(`[FileTransferReceiver] tryFinalizeTransfer updatenon-image filemessagecontentto datalibrary: ${offer.id}, includebutton: ${!!fileRequestEl.querySelector('.file-complete-actions')}`);
                    this.electronAPI.updateChatMessageContent({
                      msgid: offer.id,
                      fromer: this.context.targetEmail,
                      toer: this.context.myEmail,
                      content: fileRequestEl.outerHTML,
                      dbUser: this.context.myEmail
                    });
                  }
                }
              }
            } else {
              const missing = Math.max(0, offer.size - result.actualSize);
              this.uiManager.updateFileRequestStatus(offer.id, `${window.i18n?.t ? window.i18n.t('chat.receiveIncomplete') : 'receivenot complete(missing {size})'}`.replace('{size}', this.utils.formatBytes(missing)));
            }
          } else {
            this.uiManager.updateFileRequestStatus(offer.id, window.i18n?.t ? window.i18n.t('chat.saveComplete') : 'Save completed');
            if (!isImage && result.filePath) {
              this.uiManager.showFileCompleteActions(offer.id, result.filePath);
            }
          }
        } else {
          this.logger.warn(`[FileTransferReceiver] filefinalizefailed: ${offer.filename}`);
        }
      } catch (e) {
        this.logger.error(`[FileTransferReceiver] filefinalizeexception: ${offer.filename}`, e);
        this.uiManager.updateFileRequestStatus(offer.id, window.i18n?.t ? window.i18n.t('chat.transferInterrupted') : 'completedfailed');
      }
    }
  }

  /**
   * Handle file save success
   */
  handleFileSaveSuccess(data) {
    this.uiManager.updateFileRequestStatus(data.id, window.i18n?.t ? window.i18n.t('chat.saveComplete') : 'peersucceededsavefile');
  }

  /**
   * Handle file cancellation
   */
  handleFileCancel(data) {
    this.uiManager.updateFileRequestStatus(data.id, window.i18n?.t ? window.i18n.t('chat.transferInterrupted') : 'peerCanceltransfer');
    this.fileChunks.delete(data.id);
  }

  /**
   * Remove duplicate image messages
   */
  async deleteDuplicateImageMessage(msgId) {
    try {
      this.logger.info(`[FileTransferReceiver] delete duplicateimage message: ${msgId}`);

      if (this.electronAPI && this.electronAPI.deleteChatMessage) {
        await this.electronAPI.deleteChatMessage(msgId, this.context.myEmail);
        this.logger.info(`[FileTransferReceiver] from datalibrarydelete duplicatemessage: ${msgId}`);
      }

      this.uiManager.removeMessageFromUI(msgId);
    } catch (error) {
      this.logger.error(`[FileTransferReceiver] delete duplicateimage messagefailed: ${msgId}`, error);
    }
  }

  /**
   * Handle email attachments
   */
  handleEmailAttachments(from, attachments) {
    if (!attachments || !Array.isArray(attachments)) return;
    
    this.logger.info(`[FileTransferReceiver] processemail attachment: ${attachments.length} `);
    
    attachments.forEach(att => {
        const fileId = generateFileId();
        const mockOffer = {
            id: fileId,
            filename: att.filename || att.name || 'unknown',
            size: att.size || 0,
            mimeType: att.mimeType || att.type || 'application/octet-stream',
            path: att.path
        };

        this.uiManager.showAttachment(mockOffer, from);
    });
  }

  /**
   * Find file request element (supports traditional HTML and Web Components)
   * @param {string} id - Transfer ID
   * @returns {HTMLElement|null} Found element or null
   * @private
   */
  _findFileRequestElement(id) {
    const shadowRoot = this.context.shadowRoot;
    if (!shadowRoot) return null;

    // 1. First try to find traditional HTML element
    let element = shadowRoot.querySelector(`#file-request-${id}`);
    if (element) return element;

    // 2. Search within message container
    const msgContainer = shadowRoot.querySelector(`#msg-container-${id}`);
    if (msgContainer) {
      element = msgContainer.querySelector(`#file-request-${id}`);
      if (element) return element;
      
      // 3. Search for Web Components within message container
      const webComponents = msgContainer.querySelectorAll('normal-file-display, image-file-display, video-file-display, audio-file-display');
      for (const comp of webComponents) {
        // Check if the component's Shadow DOM has the matching ID
        if (comp.shadowRoot) {
          const innerEl = comp.shadowRoot.querySelector(`#file-request-${id}`);
          if (innerEl) return comp; // Return the component itself, not the inner element
        }
      }
    }

    // 4. Search globally for Web Components
    const allWebComponents = shadowRoot.querySelectorAll('normal-file-display, image-file-display, video-file-display, audio-file-display');
    for (const comp of allWebComponents) {
      if (comp.shadowRoot) {
        const innerEl = comp.shadowRoot.querySelector(`#file-request-${id}`);
        if (innerEl) return comp;
      }
    }

    return null;
  }

  async _replaceWithCompletedFileComponent(id, offer, filePath) {
    if (!filePath || !offer || !this.context.shadowRoot || !this.uiManager?.renderFileComponentFromHistory) {
      return null;
    }

    try {
      const msgContainer = this.context.shadowRoot.querySelector(`#msg-container-${id}`);
      const msgContent = msgContainer?.querySelector('.message-content');
      if (!msgContent) {
        return null;
      }

      const component = await this.uiManager.renderFileComponentFromHistory(
        { ...offer, id },
        false,
        filePath
      );

      if (!(component instanceof HTMLElement)) {
        return null;
      }

      const removableNodes = Array.from(msgContent.children).filter(child => {
        if (child.classList?.contains('message-status')) return false;
        if (child.id === `file-request-${id}`) return true;
        if (child.tagName === 'NORMAL-FILE-DISPLAY' ||
            child.tagName === 'IMAGE-FILE-DISPLAY' ||
            child.tagName === 'VIDEO-FILE-DISPLAY' ||
            child.tagName === 'AUDIO-FILE-DISPLAY') {
          return true;
        }
        return !!child.querySelector?.(`#file-request-${id}`);
      });

      removableNodes.forEach(node => node.remove());
      msgContent.insertBefore(component, msgContent.firstChild);

      const statusSpan = msgContent.querySelector('.message-status');
      if (statusSpan) {
        statusSpan.remove();
      }

      await new Promise(resolve => setTimeout(resolve, 30));

      if (typeof component.showComplete === 'function') {
        component.showComplete(filePath);
      }

      this.uiManager.rebindFileTransferEvents?.(component);
      this.uiManager.showFileCompleteActions(id, filePath);
      return component;
    } catch (error) {
      this.logger.warn(`[FileTransferReceiver] Failed to replace with completed file component ${id}`, error);
      return null;
    }
  }

  /**
   * Get image URL
   * @param {string} fileName - File name
   * @param {boolean} isSender - Whether it is sender
   * @returns {Promise<string>} Image URL
   * @private
   */
  async _getImageUrl(fileName, isSender) {
    let port = 8080;
    if (window.electronAPI && window.electronAPI.getHttpServerPort) {
      try {
        const result = await window.electronAPI.getHttpServerPort();
        if (result && result.success && result.port && result.port > 0) {
          port = result.port;
        }
      } catch (e) {
        this.logger.warn(`[FileTransferReceiver] exception getting port: ${e.message}`);
      }
    }
    
    const directory = isSender ? 'sends' : 'recvs';
    const userId = this.context.myEmail || '';
    return `http://127.0.0.1:${port}/${userId}/files/${directory}/${encodeURIComponent(fileName)}`;
  }
}
