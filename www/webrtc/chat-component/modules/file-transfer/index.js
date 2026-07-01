/**
 * File transfer manager main entry
 * Integrates state management, UI rendering, sender and receiver modules
 */

import { IMAGE_MIME_TYPES } from '../config.js';
import { FileTransferStateManager } from './file-transfer-state.js';
import { FileTransferUIManager } from './file-transfer-ui.js';
import { FileTransferSender } from './file-transfer-sender.js';
import { FileTransferReceiver } from './file-transfer-receiver.js';

export class FileTransferManager {
  constructor(context) {
    this.context = context;
    
    // Initialize submodules
    this.stateManager = new FileTransferStateManager(context);
    this.uiManager = new FileTransferUIManager(context);
    this.sender = new FileTransferSender(context, this.uiManager);
    this.receiver = new FileTransferReceiver(context, this.uiManager, this.stateManager);

    // Keep a stable reference for modules that route through context.uiRenderer/context.ui.
    if (this.context.uiRenderer) {
      this.context.uiRenderer.fileTransferUI = this.uiManager;
    }
    if (this.context.ui) {
      this.context.ui.fileTransferUI = this.uiManager;
    }
    
    // From restored initial state
    this._initFromRestoredState();
    
    // Set up event listeners
    this.setupEventListeners();
    
    // Restore transfer state
    this.restoreTransferState();
  }

  // Getters for context properties
  get logger() { return this.context.logger; }
  get eventBus() { return this.context.eventBus; }
  get connection() { return this.context.connection; }
  get utils() { return this.context.utils; }
  get electronAPI() { return window.electronAPI; }
  get stagedFile() { return this.sender ? this.sender.stagedFile : null; }
  get fileOffers() { return this.receiver ? this.receiver.fileOffers : null; }

  /**
   * Initialize from restored state
   * [FIX] Also restore sender's progress snapshots
   */
  _initFromRestoredState() {
    const restored = this.stateManager.restoreTransferState();
    if (restored) {
      // Set restored state to receiver
      restored.fileChunks.forEach((value, key) => {
        this.receiver.fileChunks.set(key, value);
      });
      restored.fileOffers.forEach((value, key) => {
        const normalizedOffer = value && typeof value === 'object'
          ? { ...value, id: value.id || key }
          : { id: key };
        this.receiver.fileOffers.set(key, normalizedOffer);
      });
      restored.progressSnapshots.forEach((value, key) => {
        this.receiver.progressSnapshots.set(key, value);
      });
      // [FIX] Restore sender's progress snapshot
      if (restored.senderProgressSnapshots) {
        restored.senderProgressSnapshots.forEach((value, key) => {
          this.sender.progressSnapshots.set(key, value);
          this.logger.info(`[FileTransferManager] sender progress snapshot restored: ${key}, receivedSize=${value.receivedSize}, totalSize=${value.totalSize}`);
        });
      }
    }
  }

  /**
   * Restore transfer state and UI
   * [FIX] Sender's progress snapshots already restored in _initFromRestoredState()
   * [FIX] Delay restore operation until historical messages are loaded
   */
  restoreTransferState() {
    this.logger.info(`[FileTransferManager] startresume transferUI`);
    this.logger.info(`[FileTransferManager] total ${this.receiver.fileOffers.size}  filesprovide requiredresume`);
    
    // [FIX] Delay restore operation to ensure historical messages are loaded into DOM
    setTimeout(() => {
      this._doRestoreTransferState();
    }, 1000);
  }
  
  /**
   * Actually perform transfer state restore
   * @private
   */
  _doRestoreTransferState() {
    this.receiver.fileOffers.forEach(async (offer, id) => {
      this.logger.info(`[FileTransferManager] checkfile transfer@:  ${id}, filename: ${offer.filename}`);
      
      if (this.receiver.fileChunks.has(id)) {
        const fileData = this.receiver.fileChunks.get(id);
        
        const integrityResult = await this.receiver.verifyFileIntegrity(id, offer.filename, offer.size);
        const actualProgress = integrityResult.filePath 
          ? Math.min(100, Math.round((integrityResult.actualSize / offer.size) * 100))
          : Math.min(100, Math.round((fileData.receivedSize / offer.size) * 100));
        
        this.logger.info(`[FileTransferManager] file transferprogress: ${actualProgress}%`);
        
        if (integrityResult.complete && integrityResult.actualSize > 0) {
          this.logger.info(`[FileTransferManager] file transfercompleted: ${id}`);
          
          this.uiManager.updateFileRequestStatus(id, 'Received');
          this.uiManager.updateProgressDisplay(id, 100, integrityResult.actualSize, offer.size, 0, 'Verification completed');
          
          if (IMAGE_MIME_TYPES.includes(offer.mimeType)) {
            this.logger.info(`[FileTransferManager] detected completed image transfer, start updating to image display: ${id}`);
            
            const isSender = !this.receiver.fileChunks.has(id);
            
            try {
              const updateSuccess = await this.uiManager.updateMessageToImageDisplay(id, offer, isSender, integrityResult.filePath);
              if (updateSuccess) {
                this.logger.info(`[FileTransferManager] historyimage displayupdatesucceeded: ${id}`);
                
                if (this.electronAPI && this.electronAPI.updateChatMessageContent) {
                  const fileRequestEl = this.context.root.querySelector(`#file-request-${id}`);
                  if (fileRequestEl) {
                    this.logger.info(`[FileTransferManager] updatedatalibrary in progresshistory messagecontent: ${id}`);
                    try {
                      await this.electronAPI.updateChatMessageContent({
                        msgid: id,
                        fromer: this.context.targetEmail,
                        toer: this.context.myEmail,
                        content: fileRequestEl.outerHTML
                      });
                      this.logger.info(`[FileTransferManager] history messagedatalibraryUpdate completed: ${id}`);
                    } catch (error) {
                      this.logger.error(`[FileTransferManager] history messagedatalibraryupdatefailed:`, error);
                    }
                  }
                }
              } else {
                // When database message table is cleared, message container doesn't exist, so update failure is normal
                this.logger.info(`[FileTransferManager] history image display update skipped: ${id} (message container does not exist)`);
              }
            } catch (error) {
              this.logger.error(`[FileTransferManager] history image display update exception:`, error);
            }
          }
        } else if (fileData.receivedSize > 0 || integrityResult.actualSize > 0) {
          this.logger.info(`[FileTransferManager] file transfer in progress or interrupted, show current progress: ${id}`);
          
          this.uiManager.showTransferProgress(offer.filename, offer.size, id, true, this.context.targetEmail);
          setTimeout(() => {
            this.uiManager.updateProgressDisplay(id, actualProgress, integrityResult.actualSize || fileData.receivedSize, offer.size, 0, 'resume transfer');
          }, 500);
        } else {
          this.logger.info(`[FileTransferManager] file has not started transfer: ${id}`);
        }
      } else {
        this.logger.info(`[FileTransferManager] file transfer status unknown: ${id}`);
        
        if (IMAGE_MIME_TYPES.includes(offer.mimeType)) {
          this.logger.info(`[FileTransferManager] try restoring possibly completed image display: ${id}`);
          
          const isSender = !this.receiver.fileChunks.has(id);
          
          try {
            const updateSuccess = await this.uiManager.updateMessageToImageDisplay(id, offer, isSender);
            if (updateSuccess) {
              this.logger.info(`[FileTransferManager] image display restore succeeded: ${id}`);
            }
          } catch (error) {
            this.logger.error(`[FileTransferManager] image display restore failed:`, error);
          }
        }
      }
    });
    
    this.logger.info(`[FileTransferManager] transfer UI restore completed`);
  }

  /**
   * Set up event listeners
   */
  setupEventListeners() {
    // Listen to data channel messages
    this.eventBus.on('datachannel:messageReceived', (data) => {
      this.handleFileMessage(data);
    });

    // Listen to connection state changes
    this.eventBus.on('connection:statusChanged', (status) => {
      this.handleConnectionStatusChange(status);
    });

    // Listen to file request click events in UI (compatible with traditional HTML)
    this.context.root.addEventListener('click', (e) => {
      const target = e.target;

      if (target.classList.contains('accept-btn')) {
        e.preventDefault();
        const transferId = target.dataset.transferId;
        if (transferId) {
          this.receiver.acceptFile(transferId);
        }
      }

      if (target.classList.contains('reject-btn')) {
        e.preventDefault();
        const transferId = target.dataset.transferId;
        if (transferId) {
          this.receiver.rejectFile(transferId);
        }
      }
    });

    // Listen to Web Component triggered file operation events
    this.eventBus.on('file-transfer:accept', ({ transferId }) => {
      this.logger.info(`[FileTransferManager] received EventBus accept file event: ${transferId}`);
      if (this.receiver) {
        this.receiver.acceptFile(transferId);
      } else {
        this.logger.error(`[FileTransferManager] receiver does not exist, unable toprocessAcceptevent`);
      }
    });

    this.eventBus.on('file-transfer:reject', ({ transferId }) => {
      this.logger.info(`[FileTransferManager] received EventBus reject file event: ${transferId}`);
      if (this.receiver) {
        this.receiver.rejectFile(transferId);
      } else {
        this.logger.error(`[FileTransferManager] receiver does not exist, unable toprocessRejectevent`);
      }
    });

    // Listen to input box events
    const msgInput = this.context.root.getElementById('msgInput');
    if (msgInput) {
      // Listen to Backspace deleting staged files
      msgInput.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && msgInput.value === '') {
          if (this.sender.handleBackspace()) {
            e.preventDefault();
          }
        }
      });

      // Listen to pasted files (supports images, videos, regular files)
      msgInput.addEventListener('paste', async (e) => {
        const items = e.clipboardData.items;
        let handledAny = false;
        
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          
          // Check if it's a file type (including images, videos, regular files)
          if (item.kind === 'file') {
            const file = item.getAsFile();
            if (file) {
              this.logger.info(`[FileTransferManager] detected pasted file: ${file.name}, type: ${file.type}, size: ${file.size}`);
              // handlePasteFile is now async, supports all file types
              const handled = await this.sender.handlePasteFile(file);
              if (handled) {
                handledAny = true;
              }
            }
          }
        }
        
        // Prevent default paste behavior if any file was handled
        if (handledAny) {
          e.preventDefault();
        }
      });
    }
  }

  /**
   * Handle connection state change
   */
  handleConnectionStatusChange(status) {
    if (!this.stateManager.shouldHandleConnectionStatus(status)) {
      return;
    }

    if (status === 'connected') {
      this.receiver?.mp4StreamingReceiver?.handleConnectionRestored?.().catch?.(error => {
        this.logger.warn('[FileTransferManager] restore MP4 live stream failed:', error);
      });

      // 1. Send status sync request
      // Query receiver for confirmed message statuses and update local display
      // Note: requestMessageStatusSync only queries messages with status<100,
      // Text/image messages already successfully sent via email (status=100) won't be retransmitted
      const targetEmail = this.context.targetEmail;
      if (targetEmail) {
        setTimeout(() => {
          this.sender.requestMessageStatusSync(targetEmail);
        }, 1000); // Delay 1 second to ensure connection is fully established
      }

      if (this.receiver.fileOffers.size > 0) {
        this.logger.info(`[FileTransferManager] connection restored, checking ${this.receiver.fileOffers.size}  file transfers`);

        const checkImageTransfers = async () => {
          for (const [id, offer] of this.receiver.fileOffers) {
            if (IMAGE_MIME_TYPES.includes(offer.mimeType)) {
              const fileData = this.receiver.fileChunks.get(id);
              if (fileData) {
                const integrityResult = await this.receiver.verifyFileIntegrity(id, offer.filename, offer.size);
                if (integrityResult.complete && integrityResult.actualSize > 0) {
                  this.logger.info(`[FileTransferManager] connection restored, detected image transfer completed: ${id}`);
                  setTimeout(() => {
                    this.uiManager.updateMessageToImageDisplay(id, offer, false, integrityResult.filePath).catch(() => {});
                  }, 1000);
                }
              }
            }
          }
        };

        checkImageTransfers();
      }
    } else if (status === 'disconnected' || status === 'failed') {
      this.receiver?.mp4StreamingReceiver?.handleConnectionInterrupted?.().catch?.(error => {
        this.logger.warn('[FileTransferManager] switch MP4 partial snapshot failed:', error);
      });

      this.stateManager.saveTransferState(
        this.receiver.fileChunks,
        this.receiver.fileOffers,
        new Map(),
        this.receiver.progressSnapshots,
        this.sender.progressSnapshots // [FIX] Also save sender's progress snapshots
      );

      // Update ongoing transfers to interrupted state
      this._updateActiveTransfersToInterrupted();
    }
  }

  /**
   * Update all ongoing transfers to interrupted state (supports resume)
   * @private
   */
  _updateActiveTransfersToInterrupted() {
    // 1. Handle files currently being sent by sender
    const senderTransferId = this.sender.transferId;
    if (senderTransferId) {
      const progressSnapshot = this.sender.progressSnapshots.get(senderTransferId);
      const receivedSize = progressSnapshot?.receivedSize || 0;
      const totalSize = progressSnapshot?.totalSize || this.sender.currentFile?.size || 0;

      if (totalSize > 0 || receivedSize > 0) {
        this.logger.info(`[FileTransferManager] senderTransfer interrupted: ${senderTransferId}, transfer: ${receivedSize}/${totalSize}`);
        this.uiManager.showTransferInterrupted(senderTransferId, receivedSize, totalSize, true);

        // [FIX] Also update message status to "transfer interrupted", overriding "received by peer"
        this._markMessageAsTransferInterrupted(senderTransferId);
      }
    }

    // 2. Handle files currently being received by receiver
    for (const [id, offer] of this.receiver.fileOffers) {
      const fileData = this.receiver.fileChunks.get(id);
      if (fileData && fileData.receivedSize < offer.size) {
        this.logger.info(`[FileTransferManager] receiverTransfer interrupted: ${id}, Received: ${fileData.receivedSize}/${offer.size}`);
        this.uiManager.showTransferInterrupted(id, fileData.receivedSize, offer.size, false);
        
        // [FIX] Also update message status to "transfer interrupted", overriding "received by peer"
        this._markMessageAsTransferInterrupted(id);
      }
    }
  }
  
  /**
   * Mark message as transfer interrupted state
   * Overwrites message status to "transfer interrupted", preserving file transfer progress info
   * @private
   * @param {string} transferId - Transfer ID
   */
  _markMessageAsTransferInterrupted(transferId) {
    const shadowRoot = this.context.shadowRoot;
    if (!shadowRoot) return;
    
    // Find message status element
    const statusSpan = 
      shadowRoot.getElementById('msg-status-' + transferId) ||
      shadowRoot.querySelector(`#msg-container-${transferId} .message-status`);
    
    if (statusSpan) {
      // Mark as transfer interrupted to prevent being overwritten by markMessageAsConfirmed
      statusSpan.dataset.transferIncomplete = 'true';
      statusSpan.textContent = ' (Transfer interrupted)';
      statusSpan.style.color = 'orange';
      this.logger.info(`[FileTransferManager] message status updated to transfer interrupted: ${transferId}`);
    }
  }

  /**
   * Handle file message
   */
  async handleFileMessage(data) {
    switch (data.type) {
      case 'file-offer':
        this.receiver.handleFileOffer(data);
        break;
      case 'file-accept':
        this.sender.handleFileAccept(data);
        break;
      case 'file-reject':
        this.sender.handleFileReject(data);
        break;
      case 'file-data':
        this.receiver.handleFileData(data);
        break;
      case 'file-data-binary':
        this.receiver.handleFileDataBinary(data);
        break;
      case 'file-complete':
        await this.receiver.handleFileComplete(data);
        break;
      case 'file-save-success':
        this.sender.handleFileSaveSuccess(data);
        break;
      case 'file-cancel':
        this.receiver.handleFileCancel(data);
        break;
      case 'file-progress':
        this.receiver.updateProgress(data);
        break;
      case 'receiver-file-progress':
        this.sender.handleReceiverFileProgress(data);
        break;
    }
  }

  // ============ Public API methods ============

  /**
   * Select file and stage it
   */
  selectAndSendFile() {
    this.sender.selectAndSendFile();
  }

  /**
   * Send staged files
   */
  sendStagedFile() {
    this.sender.sendStagedFile();
  }

  /**
   * Clear staged files
   */
  clearStagedFile() {
    this.sender.clearStagedFile();
  }

  /**
   * Accept file
   */
  acceptFile(transferId) {
    this.receiver.acceptFile(transferId);
  }

  /**
   * Reject file
   */
  rejectFile(transferId) {
    this.receiver.rejectFile(transferId);
  }

  /**
   * Handle email attachments
   */
  handleEmailAttachments(from, attachments) {
    this.receiver.handleEmailAttachments(from, attachments);
  }

  /**
   * Check if message is already displayed
   */
  isMessageDisplayed(msgId) {
    return this.uiManager.isMessageDisplayed(msgId);
  }

  /**
   * Remove duplicate image messages
   */
  async deleteDuplicateImageMessage(msgId) {
    return this.receiver.deleteDuplicateImageMessage(msgId);
  }

  /**
   * Send file offer (for resending)
   */
  async sendFileOffer(file, existingOffer, options) {
    return this.sender.sendFileOffer(file, existingOffer, options);
  }

  /**
   * Check if message already exists
   */
  async checkExistingMessage(msgid) {
    return this.receiver.checkExistingMessage(msgid);
  }

  /**
   * Check if file exists
   * @param {string} transferId - Transfer ID
   * @param {string} filename - Filename
   * @param {boolean} isSender - Whether this is the sender
   * @param {string} storedFileName - Stored filename (optional)
   * @returns {Promise<{exists: boolean, storedFileName: string, filePath: string}>}
   */
  async checkFileExists(transferId, filename, isSender, storedFileName = null) {
    try {
      this.logger.info(`[FileTransferManager] checkFileExists: isSender=${isSender}, transferId=${transferId}, filename=${filename}, storedFileName=${storedFileName}`);
      const userId = this.context.myEmail;

      // Prefer searching by storedFileName
      if (storedFileName) {
        this.logger.info(`[FileTransferManager] priorityuse storedFileName find: ${storedFileName}`);
        const pathResult = await this.electronAPI.getSentFilePath(storedFileName, isSender, userId);
        if (pathResult && pathResult.success && pathResult.filePath) {
          this.logger.info(`[FileTransferManager] via storedFileName foundfile: ${pathResult.filePath}`);
          return {
            exists: true,
            storedFileName: storedFileName,
            filePath: pathResult.filePath
          };
        } else {
          this.logger.warn(`[FileTransferManager] storedFileName findfailed: ${storedFileName}`);
        }
      } else {
        this.logger.warn(`[FileTransferManager] storedFileName  as empty, usealternativefindmethod`);
      }

      // Fix: only try lookup by transferId when transferId is not empty
      let pathResult = null;
      
      if (transferId && String(transferId).trim() !== '') {
        const fileNamePattern = `${transferId}-${filename}`;
        this.logger.info(`[FileTransferManager] try finding using fileNamePattern: ${fileNamePattern}`);

        // Try to get file path - first try prefix with transferId, passing isSender parameter
        pathResult = await this.electronAPI.getSentFilePath(fileNamePattern, isSender, userId);

        if (!pathResult || !pathResult.success || !pathResult.filePath) {
          // If receiver, try using transferId prefix only
          if (!isSender) {
            pathResult = await this.electronAPI.getSentFilePath(transferId, isSender, userId);
            this.logger.info(`[FileTransferManager] receivertryusetransferIdfind: ${transferId}, result=${pathResult?.success}`);
          }
        }
      } else {
        this.logger.warn(`[FileTransferManager] transferId  as empty, skipuse transferId find`);
      }

      // If still not found, try using original filename
      if (!pathResult || !pathResult.success || !pathResult.filePath) {
        this.logger.info(`[FileTransferManager] tryuseoriginalfilenamefind: ${filename}`);
        pathResult = await this.electronAPI.getSentFilePath(filename, isSender, userId);
        if (!pathResult || !pathResult.success || !pathResult.filePath) {
          this.logger.info(`[FileTransferManager] filedoes not exist: ${filename}`);
          return { exists: false, storedFileName: '', filePath: '' };
        }
      }
      
      const filePath = pathResult.filePath;
      this.logger.info(`[FileTransferManager] file exists: ${filename}, path: ${filePath}`);
      
      // Extract stored filename
      const finalStoredFileName = filePath.split(/[\\/]/).pop();
      
      return { 
        exists: true, 
        storedFileName: finalStoredFileName, 
        filePath: filePath 
      };
    } catch (error) {
      this.logger.error(`[FileTransferManager] checkfile existspropertyfailed:`, error);
      return { exists: false, storedFileName: '', filePath: '' };
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
    return this.receiver.verifyFileIntegrity(transferId, originalFilename, expectedSize, isSender);
  }

  /**
   * Update message to image display and save to database
   */
  async updateMessageToImageDisplayAndSave(id, offer, isSender, filePath = null) {
    try {
      const updateSuccess = await this.uiManager.updateMessageToImageDisplay(id, offer, isSender, filePath);
      if (updateSuccess) {
        if (this.electronAPI && this.electronAPI.updateChatMessageContent) {
           const shadowRoot = this.context.shadowRoot;
           if (shadowRoot) {
             const fileRequestEl = shadowRoot.querySelector(`#file-request-${id}`) || 
                                  shadowRoot.querySelector(`.image-message[id="image-${id}"]`)?.parentElement;
             
             if (fileRequestEl) {
               await this.electronAPI.updateChatMessageContent({
                 msgid: id,
                 fromer: isSender ? this.context.myEmail : this.context.targetEmail,
                 toer: isSender ? this.context.targetEmail : this.context.myEmail,
                 content: fileRequestEl.outerHTML
               });
               this.logger.info(`[FileTransferManager] image displayupdate and save succeeded: ${id}`);
             }
           }
        }
        return true;
      }
      return false;
    } catch (error) {
      this.logger.error(`[FileTransferManager] updateMessageToImageDisplayAndSave exception:`, error);
      return false;
    }
  }

  /**
   * Save transfer state
   * [FIX] Also save sender's progressSnapshots to restore interrupted sender progress after re-login
   */
  saveTransferState() {
    this.stateManager.saveTransferState(
      this.receiver.fileChunks,
      this.receiver.fileOffers,
      new Map(), // transferOptions
      this.receiver.progressSnapshots,
      this.sender.progressSnapshots // Sender's progress snapshots
    );
  }

  /**
   * Clear transfer state
   */
  clearTransferState() {
    this.stateManager.clearTransferState();
  }
}

// For backward compatibility, also export default FileTransferManager
export default FileTransferManager;
