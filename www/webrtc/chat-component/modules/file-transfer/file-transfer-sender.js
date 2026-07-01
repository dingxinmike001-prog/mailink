/**
 * File transfer sender module
 * Handles file selection, sending offers, send queue management, and chunked sending
 */

import { IMAGE_MIME_TYPES } from '../config.js';
import { MP4StreamingSender } from '../mp4-streaming-sender.js';
import { FileTransferSenderPersistence } from './file-transfer-sender-persistence.js';
import { calculateFileHash } from './file-transfer-sender-utils.js';
import { processPastedFile } from './file-converter-utils.js';
import { markMessageAsCompleted } from '../../../../utils/status.js';
import { getThumbnailFileName, deriveThumbnailUrl } from '../../../../utils/thumbnail-utils.js';
import { generateFileId } from '../../../../utils/common.js';
import { VideoPosterExtractor } from '../../../../utils/video-poster-extractor.js';
import { BaseTransferSender } from './base-transfer-sender.js';
import { validateFileForTransfer } from '../../../../../shared/security/file-security.js';

export class FileTransferSender extends BaseTransferSender {
  constructor(context, uiManager) {
    super(context, uiManager);
    this.posterExtractor = new VideoPosterExtractor(context.logger);
    
    // Sender-related state
    this.currentFile = null;
    this.copiedPaths = new Map();
    this.stagedFile = null;
    this.previewUrl = null;

    this.fileHashes = new Map();
    
    // Transport configuration
    this.chunkSize = 16 * 1024;
    this.transferSpeed = 0;
    
    // MP4 streaming sender
    this.mp4StreamingSender = new MP4StreamingSender(context, uiManager);
    
    // Persistence manager
    this.persistence = new FileTransferSenderPersistence(context, uiManager);
    
    // Progress snapshot - used to show interrupted state during resume
    this.progressSnapshots = new Map();
    this._activeTransferInfo = new Map(); // [NEW] Record active transfer file info for progress persistence
  }

  get persistenceManager() { return this.persistence; }

  /**
   * Select file and stage it
   */
  async selectAndSendFile() {
    const fileInput = this.context.root.getElementById('fileInput');
    if (!fileInput) return;

    fileInput.value = '';

    fileInput.click();
    fileInput.onchange = async (e) => {
      const file = e.target.files[0];
      if (file) {
        // Security verification: check if it is a dangerous file
        const validation = await validateFileForTransfer(file);
        if (!validation.allowed) {
          this.logger.warn(`[FileTransferSender] blocked dangerous file: ${file.name}, reason: ${validation.reasons.join(', ')}`);
          alert(validation.message);
          return;
        }

        this.stagedFile = file;
        this.previewUrl = this.uiManager.updateStagedFileUI(this.stagedFile, this.previewUrl, () => this.clearStagedFile());
      }
    };
  }

  /**
   * Clear staged files
   */
  clearStagedFile() {
    if (this.previewUrl) {
      URL.revokeObjectURL(this.previewUrl);
      this.previewUrl = null;
    }
    this.stagedFile = null;
    this.uiManager.updateStagedFileUI(null, null, null);
  }

  /**
   * Send staged files
   */
  sendStagedFile() {
    if (this.stagedFile) {
      const file = this.stagedFile;
      const isImage = IMAGE_MIME_TYPES.includes(file.type);
      
      // Handling when WebRTC is not connected
      if (!this.isConnected()) {
        // All files: files smaller than 25MB are sent directly via email
        if (file.size < 25 * 1024 * 1024) {
          this.stagedFile = null;
          this.previewUrl = this.uiManager.updateStagedFileUI(null, this.previewUrl, null);
          this.sendFileOffer(file);
          return;
        }
        // All files: prompt user to wait for connection before sending files ≥25MB
        alert(window.i18n?.t ? window.i18n.t('chat.waitForDirectConnection') : 'Establishing direct connection, please wait before sending oversized files\n\nSending after the connection is established will provide faster transfer speed');
        return;
      }

      this.stagedFile = null;
      this.previewUrl = this.uiManager.updateStagedFileUI(null, this.previewUrl, null);
      this.sendFileOffer(file);
    }
  }

  /**
   * Handle pasted files
   * Supports images, MP4 videos, and regular files; save to sends directory and stage for sending
   * Use Worker for Base64 conversion to avoid blocking the main thread
   */
  async handlePasteFile(file) {
    if (!file) return false;

    // Security verification: check if it is a dangerous file
    const validation = await validateFileForTransfer(file);
    if (!validation.allowed) {
      this.logger.warn(`[FileTransferSender] blocked pasted dangerous file: ${file.name}, reason: ${validation.reasons.join(', ')}`);
      alert(validation.message);
      return false;
    }

    // Check file type
    const isImage = file.type.indexOf('image') !== -1;
    const isMP4 = MP4StreamingSender.isMP4File(file);
    const isFile = true; // Any file can be pasted

    if (!isImage && !isMP4 && !isFile) {
      return false;
    }

    try {
      const timestamp = new Date().getTime();
      const transferId = generateFileId();

      // Determine filename based on file type
      let fileName;
      if (isImage) {
        fileName = `pasted-image-${timestamp}.png`;
      } else if (isMP4) {
        // Preserve original extension
        const ext = file.name.split('.').pop() || 'mp4';
        fileName = `pasted-video-${timestamp}.${ext}`;
      } else {
        // Regular file, keep original filename or generate a new one
        fileName = file.name || `pasted-file-${timestamp}.bin`;
      }

      // Save pasted file to sends directory
      if (this.electronAPI && this.electronAPI.saveSentFile) {
        this.logger.info(`[FileTransferSender] start saving pasted file: ${fileName}, type: ${file.type}, size: ${file.size}`);

        // Use Worker in background thread to convert file to Base64, avoiding main thread blocking
        const processResult = await processPastedFile(file);

        if (!processResult.success) {
          throw new Error(`Worker processing file failed: ${processResult.error}`);
        }

        const base64Data = processResult.base64;

        // Save to sends directory with transferId as prefix
        const savedFileName = `${transferId}-${fileName}`;
        const userId = this.context.myEmail;
        const saveResult = await this.electronAPI.saveSentFile(savedFileName, base64Data, userId);

        if (saveResult.success) {
          this.logger.info(`[FileTransferSender] pasted file saved to sends directory: ${saveResult.filePath}`);

          // Create a new File object containing the saved path info
          const newFile = new File([file], fileName, {
            type: file.type,
            lastModified: Date.now()
          });
          // Manually add path property (used when reading for subsequent sending)
          newFile.path = saveResult.filePath;
          // Save transferId and storedFileName for sending
          newFile._transferId = transferId;
          newFile._storedFileName = savedFileName;
          newFile._isPastedFile = true;
          newFile._isPastedImage = isImage;
          newFile._isPastedMP4 = isMP4;

          this.stagedFile = newFile;
          this.previewUrl = this.uiManager.updateStagedFileUI(this.stagedFile, this.previewUrl, () => this.clearStagedFile());
          return true;
        } else {
          this.logger.error('[FileTransferSender] failed to save pasted file:', saveResult.error);
          // Can still stage if save fails, but cannot send
          const newFile = new File([file], fileName, { type: file.type });
          this.stagedFile = newFile;
          this.previewUrl = this.uiManager.updateStagedFileUI(this.stagedFile, this.previewUrl, () => this.clearStagedFile());
          return true;
        }
      } else {
        // If no saveSentFile API, stage directly
        const newFile = new File([file], fileName, { type: file.type });
        this.stagedFile = newFile;
        this.previewUrl = this.uiManager.updateStagedFileUI(this.stagedFile, this.previewUrl, () => this.clearStagedFile());
        return true;
      }
    } catch (error) {
      this.logger.error('[FileTransferSender] failed to process pasted file:', error);
      // Still try to stage on error
      const timestamp = new Date().getTime();
      const fallbackName = file.name || `pasted-file-${timestamp}.bin`;
      const newFile = new File([file], fallbackName, { type: file.type });
      this.stagedFile = newFile;
      this.previewUrl = this.uiManager.updateStagedFileUI(this.stagedFile, this.previewUrl, () => this.clearStagedFile());
      return true;
    }
  }

  /**
   * Handle Backspace to delete staged file
   */
  handleBackspace() {
    if (this.stagedFile) {
      this.clearStagedFile();
      return true;
    }
    return false;
  }

  /**
   * Send file offer
   */
  async sendFileOffer(file, existingOffer = null, options = {}) {
    if (existingOffer) {
      this.currentFile = file;
      this.transferId = existingOffer.id;

      if (this.isConnected()) {
        this.connection.sendData(existingOffer);
        this.logger.info(`[FileTransferSender] resent queued file request: ${existingOffer.filename}`);
      }
      return;
    }

    this.currentFile = file;
    this.chunkSize = IMAGE_MIME_TYPES.includes(file.type) ? 16 * 1024 : 64 * 1024;
    
    // Check if it's a pasted file (already saved to sends directory)
    const isPastedFile = file._isPastedFile;
    const isPastedImage = file._isPastedImage;
    const isPastedMP4 = file._isPastedMP4;
    const pastedTransferId = file._transferId;
    const pastedStoredFileName = file._storedFileName;
    
    // If pasted file, use the transferId generated when saving
    this.transferId = options.msgid || (isPastedFile ? pastedTransferId : generateFileId());
    this.logger.info(`[FileTransferSender] use transferId: ${this.transferId}${options.msgid ? ' (from datalibrarymsgid)' : isPastedFile ? ' (from pastefile)' : ' (newgenerate)'}`);

    // Check if it's an MP4 video file; if so, use streaming transfer
    if (MP4StreamingSender.isMP4File(file)) {
      this.logger.info(`[FileTransferSender] detected MP4 file, using streaming transfer: ${file.name}`);
      try {
        const streamResult = await this.mp4StreamingSender.prepareStream(file, this.transferId);
        if (streamResult.success) {
          await this.sendMP4StreamOffer(file);
          return;
        }
      } catch (error) {
        this.logger.warn(`[FileTransferSender] MP4 streaming preparation failed, using normal transfer:`, error);
      }
    }

    this.logger.info(`[FileTransferSender] start sending file request: ${file.name} (${this.utils.formatBytes(file.size)})`);

    // Calculate file hash
    let fileHash = null;
    try {
      fileHash = await calculateFileHash(file);
      this.logger.info(`[FileTransferSender] file hash calculation completed: ${file.name}, hash: ${fileHash}`);
    } catch (error) {
      this.logger.warn(`[FileTransferSender] file hash calculation failed: ${file.name}`, error);
    }

    let copiedPath = null;
    let filePath = file.path;
    let storedFileName = null;

    // If pasted file, use saved file info directly
    if (isPastedFile && pastedStoredFileName) {
      copiedPath = filePath;
      storedFileName = pastedStoredFileName;
      this.copiedPaths.set(this.transferId, copiedPath);
      this.logger.info(`[FileTransferSender] using saved path of pasted file: ${copiedPath}, storedFileName: ${storedFileName}`);
    } else if (this.electronAPI) {
        if (this.electronAPI.getFilePath) {
            try {
                filePath = this.electronAPI.getFilePath(file);
            } catch(e) {
                console.error('failed to get file path', e);
            }
        }
        
        if (filePath && this.electronAPI.copyFileToSends) {
            storedFileName = `${this.transferId}-${file.name}`;
            const userId = this.context.myEmail;
            this.logger.info(`[FileTransferSender] start async copying file to sends directory: ${filePath}`);
            this.electronAPI.copyFileToSends(filePath, this.transferId, userId).then(copyResult => {
                if (copyResult.success) {
                    copiedPath = copyResult.filePath;
                    this.copiedPaths.set(this.transferId, copiedPath);
                    this.logger.info(`[FileTransferSender] file copied to sends directory: ${copiedPath}`);
                } else {
                    this.logger.error(`[FileTransferSender] failed to copy file: ${copyResult.error}`);
                }
            }).catch(error => {
                console.error('failed to copy file:', error);
            });
        } else {
            storedFileName = filePath ? filePath.split(/[/\\]/).pop() : null;
        }
    }

    const offer = {
      type: 'file-offer',
      id: this.transferId,
      filename: file.name,
      size: file.size,
      mimeType: file.type,
      timestamp: Date.now(),
      copiedPath: copiedPath,
      storedFileName: storedFileName,
      protocolVersion: 2,
      supportsBinary: true,
      fileHash: fileHash
    };

    // [NEW] Record current transfer file info for progress persistence
    this._activeTransferInfo.set(this.transferId, {
      name: file.name,
      storedFileName: storedFileName || `${this.transferId}-${file.name}`
    });

    if (fileHash) {
      this.fileHashes.set(this.transferId, fileHash);
    }

    const isImage = IMAGE_MIME_TYPES.includes(offer.mimeType);
    const myEmail = this.context.myEmail;

    // Image type: pre-generate thumbnail before sending
    if (isImage && filePath && this.electronAPI?.generateThumbnail) {
      try {
        const thumbResult = await this.electronAPI.generateThumbnail(filePath, 200);
        if (thumbResult?.success) {
          this.logger.info(`[FileTransferSender] sendbeforethumbnail generation succeeded: ${this.transferId}`);
        }
      } catch (err) {
        this.logger.warn(`[FileTransferSender] sendbeforethumbnail generation failed (non-fatal): ${err?.message}`);
      }
    }

    // Image handling when not connected: images <25MB are sent via email directly
    if (isImage && !this.isConnected() && file.size < 25 * 1024 * 1024) {
      this.logger.info(`[FileTransferSender] Disconnected, image ${file.name} will viaemail sending`);
      
      // Show preview
      const imageComponent = await this.uiManager.renderImageDisplay(offer, true);
      this.context.uiRenderer.displayMessage('Me', imageComponent, this.transferId, Date.now(), myEmail, 50);
      
      // Save to database, status=50 means sending
      let imageHtml;
      if (imageComponent instanceof HTMLElement) {
        imageHtml = imageComponent.outerHTML;
      } else {
        imageHtml = imageComponent;
      }
      
      if (this.electronAPI && this.electronAPI.saveChatMessage) {
        try {
          await this.electronAPI.saveChatMessage({
            fromer: myEmail || '',
            toer: this.context.targetEmail,
            content: imageHtml,
            type: 1,
            status: 50,
            msgid: this.transferId
          });
        } catch (error) {
          console.error('failed to save image message:', error);
        }
      }
      
      document.dispatchEvent(new CustomEvent('updateContactLastMessage', {
        detail: {
          email: this.context.targetEmail,
          message: '[Image]'
        }
      }));
      
      // Send image via email
      this.sendImageViaEmail(file, offer).catch(error => {
        this.logger.error('[FileTransferSender] failed to send image via email:', error);
        alert(window.i18n?.t ? window.i18n.t('chat.imageSendFailed') : 'Image sending failed, please wait for a direct connection before retrying');
      });
      return;
    }

    // Email sending handling for non-image files (<25MB) when not connected
    if (!isImage && !this.isConnected() && file.size < 25 * 1024 * 1024) {
      const messageComponent = await this.uiManager.renderFileRequestMessage(offer, true);

      this.context.uiRenderer.displayMessage('Me', messageComponent, this.transferId, Date.now(), myEmail, 50);

      // Get HTML string for storage
      let htmlMessage;
      if (messageComponent instanceof HTMLElement) {
        htmlMessage = messageComponent.outerHTML;
      } else {
        htmlMessage = messageComponent;
      }

      if (this.electronAPI && this.electronAPI.saveChatMessage) {
        try {
          await this.electronAPI.saveChatMessage({
            fromer: myEmail || '',
            toer: this.context.targetEmail,
            content: htmlMessage,
            type: 1,
            status: 50,
            msgid: this.transferId
          });
        } catch (error) {
          console.error('failed to save file message:', error);
        }
      }

      document.dispatchEvent(new CustomEvent('updateContactLastMessage', {
        detail: {
          email: this.context.targetEmail,
          message: `📎 ${file.name}`
        }
      }));

      this.logger.warn('[FileTransferSender] currently not connected, file will be sent directly via normal email');
      this.sendFileViaEmail(file, offer).catch(error => {
        this.logger.error('[FileTransferSender] failed to send file via email:', error);
        alert(window.i18n?.t ? window.i18n.t('chat.emailSendFailed') : 'Email sending failed, please wait for a direct connection before retrying');
      });
      return;
    }

    // When not connected and file ≥25MB (including images), prompt user to wait for connection
    if (!this.isConnected() && file.size >= 25 * 1024 * 1024) {
      this.logger.warn(`[FileTransferSender] file ${file.name} sizeexceed25MandDisconnected, wait to send after connection succeeds`);
      alert(window.i18n?.t ? window.i18n.t('chat.waitForDirectConnection') : 'Establishing direct connection, please wait before sending oversized files\n\nSending after the connection is established will provide faster transfer speed');
      return;
    }

    const messageComponent = await this.uiManager.renderFileRequestMessage(offer, true);

    // Pass component object directly to displayMessage for proper handling
    this.context.uiRenderer.displayMessage('Me', messageComponent, this.transferId, Date.now(), myEmail, 50);

    // Get HTML string for storage
    let htmlMessage;
    if (messageComponent instanceof HTMLElement) {
      htmlMessage = messageComponent.outerHTML;
    } else {
      htmlMessage = messageComponent;
    }

    if (this.electronAPI && this.electronAPI.saveChatMessage) {
      try {
        await this.electronAPI.saveChatMessage({
          fromer: myEmail || '',
          toer: this.context.targetEmail,
          content: htmlMessage,
          type: 1,
          status: 50,
          msgid: this.transferId
        });
      } catch (error) {
        console.error('failed to save file message:', error);
      }
    }

    document.dispatchEvent(new CustomEvent('updateContactLastMessage', {
        detail: {
            email: this.context.targetEmail,
            message: htmlMessage
        }
    }));

    this.connection.sendData(offer);
    this.logger.info('[FileTransferSender] file request sent');
  }

  /**
   * Send MP4 streaming offer
   */
  async sendMP4StreamOffer(file) {
    const myEmail = this.context.myEmail;
    
    // Check if it's a pasted MP4 file
    const isPastedMP4 = file._isPastedMP4;
    const pastedStoredFileName = file._storedFileName;
    const pastedFilePath = file.path;
    
    // Copy file to sends directory (sender also needs to play it)
    let copiedPath = null;
    let filePath = file.path;

    // If pasted MP4, use saved file info directly
    if (isPastedMP4 && pastedStoredFileName) {
      copiedPath = pastedFilePath;
      this.copiedPaths.set(this.transferId, copiedPath);
      this.logger.info(`[FileTransferSender] usepasteMP4Savedpath: ${copiedPath}, storedFileName: ${pastedStoredFileName}`);
    } else if (this.electronAPI) {
      if (this.electronAPI.getFilePath) {
        try {
          filePath = this.electronAPI.getFilePath(file);
        } catch(e) {
          console.error('failed to get file path', e);
        }
      }
      
      if (filePath && this.electronAPI.copyFileToSends) {
        const userId = this.context.myEmail;
        this.logger.info(`[FileTransferSender] start async copying MP4 file to sends directory: ${filePath}`);
        this.electronAPI.copyFileToSends(filePath, this.transferId, userId).then(copyResult => {
          if (copyResult.success) {
            copiedPath = copyResult.filePath;
            this.copiedPaths.set(this.transferId, copiedPath);
            this.logger.info(`[FileTransferSender] MP4 file copied to sends directory: ${copiedPath}`);
          } else {
            this.logger.error(`[FileTransferSender] copyMP4filefailed: ${copyResult.error}`);
          }
        }).catch(error => {
          console.error('copyMP4filefailed:', error);
        });
      }
    }

    const storedFileName = isPastedMP4 ? pastedStoredFileName : `${this.transferId}-${file.name}`;
    
    // Extract video poster
    let posterFileName = null;
    let posterDataUrl = null;

    this.logger.info(`[FileTransferSender] startextractvideoposter: transferId=${this.transferId}, fileName=${file.name}`);
    try {
      const posterResult = await this.posterExtractor.extractPoster(file, {
        timeOffset: 0.5,
        maxWidth: 400,
        quality: 0.8
      });

      this.logger.info(`[FileTransferSender] posterextract result: success=${posterResult.success}, hasDataUrl=${!!posterResult.dataUrl}`);
      if (posterResult.success && posterResult.dataUrl) {
        posterDataUrl = posterResult.dataUrl;
        this.logger.info(`[FileTransferSender] posterdataextract, length=${posterDataUrl.length}, preparesaveto  sends directory`);

        // Save poster to sends directory
        if (this.electronAPI?.saveVideoPoster) {
          this.logger.info(`[FileTransferSender] call saveVideoPoster API saveposter, transferId=${this.transferId}`);
          const saveResult = await this.electronAPI.saveVideoPoster({
            transferId: this.transferId,
            posterDataUrl: posterDataUrl,
            userId: this.context.myEmail
          });

          this.logger.info(`[FileTransferSender] saveVideoPoster return: success=${saveResult?.success}, posterFileName=${saveResult?.posterFileName}`);
          if (saveResult?.success) {
            posterFileName = saveResult.posterFileName;
            this.logger.info(`[FileTransferSender] ✅ videoposter savedto  sends: ${posterFileName}`);
          } else {
            this.logger.warn(`[FileTransferSender] ❌ savevideoposterfailed: ${saveResult?.error}`);
          }
        } else {
          this.logger.warn(`[FileTransferSender] ❌ electronAPI.saveVideoPoster unavailable`);
        }
      } else {
        this.logger.warn(`[FileTransferSender] ❌ posterextractfailed: ${posterResult.error}`);
      }
    } catch (error) {
      this.logger.error(`[FileTransferSender] ❌ extract/savevideoposterexception:`, error);
    }

    this.logger.info(`[FileTransferSender] finalposterstatus: posterFileName=${posterFileName}, hasPosterData=${!!posterDataUrl}`);

    const offer = {
      type: 'file-offer',
      id: this.transferId,
      filename: file.name,
      size: file.size,
      mimeType: file.type || 'video/mp4',
      timestamp: Date.now(),
      isMP4Stream: true,
      supportsStreaming: true,
      protocolVersion: 3,
      copiedPath: copiedPath,
      storedFileName: storedFileName,
      // Poster info
      posterFileName: posterFileName,
      posterData: posterDataUrl  // Send base64 poster data to receiver
    };

    // [NEW] Record current transfer file info for progress persistence
    this._activeTransferInfo.set(this.transferId, {
      name: file.name,
      storedFileName: storedFileName
    });

    // Render video message (sender preview)
    const messageComponent = await this.uiManager.renderStreamingVideoMessage(offer, true);
    
    // Set poster immediately if available
    if (posterDataUrl && messageComponent.setPoster) {
      messageComponent.setPoster(posterDataUrl);
      this.logger.info(`[FileTransferSender] Setvideoposter`);
    }

    // Pass component object directly to displayMessage for proper handling
    this.context.uiRenderer.displayMessage('Me', messageComponent, this.transferId, Date.now(), myEmail, 50);

    // Get HTML string for storage
    let htmlMessage;
    if (messageComponent instanceof HTMLElement) {
      htmlMessage = messageComponent.outerHTML;
    } else {
      htmlMessage = messageComponent;
    }

    // Save message to database
    if (this.electronAPI && this.electronAPI.saveChatMessage) {
      try {
        await this.electronAPI.saveChatMessage({
          fromer: myEmail || '',
          toer: this.context.targetEmail,
          content: htmlMessage,
          type: 1,
          status: 50,
          msgid: this.transferId
        });
      } catch (error) {
        this.logger.error('[FileTransferSender] savevideo messagefailed:', error);
      }
    }

    document.dispatchEvent(new CustomEvent('updateContactLastMessage', {
      detail: {
        email: this.context.targetEmail,
        message: '📹 video'
      }
    }));

    // Send using MP4 streaming sender, passing copiedPath and posterFileName
    await this.mp4StreamingSender.startStreamTransfer(0, storedFileName, copiedPath, posterFileName);
    this.logger.info('[FileTransferSender] MP4 streamingtransferrequestSent');
  }

  /**
   * Handle file accept message
   */
  handleFileAccept(acceptMsg) {
    // Check if it is MP4 streaming
    if (acceptMsg.isMP4Stream || this.mp4StreamingSender.transferId === acceptMsg.id) {
      this.logger.info(`[FileTransferSender] received MP4 streamingtransferAccept: ${acceptMsg.id}`);
      this.mp4StreamingSender.handleFileAccept(acceptMsg);
      return;
    }

    if (this.currentFile && this.transferId === acceptMsg.id) {
        this.startTime = Date.now();
        const offset = acceptMsg.offset || 0;
        this.uiManager.updateFileRequestStatus(acceptMsg.id, offset > 0 ? `${window.i18n?.t ? window.i18n.t('chat.continueTransfer') : 'continuetransfer (from  {size} start)...'}`.replace('{size}', this.utils.formatBytes(offset)) : (window.i18n?.t ? window.i18n.t('chat.acceptedTransferring') : 'peerAccepted, transferring...'));
        this.startFileTransfer(offset);
    }
  }

  /**
   * Handle file reject message
   */
  handleFileReject(rejectMsg) {
    if (this.transferId === rejectMsg.id) {
        this.uiManager.updateFileRequestStatus(rejectMsg.id, 'peerRejected');
        this.currentFile = null;
        this.transferId = null;
    }
  }

  /**
   * Start file transfer
   */
  startFileTransfer(startOffset = 0) {
    const file = this.currentFile;
    const fileSize = file.size;
    this.logger.info(`[FileTransferSender] starttransferfile: ${file.name}, Offset: ${startOffset}`);

    let offset = startOffset;
    this.startTime = Date.now();

    const reader = new FileReader();
    
    const readSlice = (o) => {
        const slice = file.slice(o, o + this.chunkSize);
        reader.readAsArrayBuffer(slice);
    };

    reader.onload = async (e) => {
        if (!this.isConnected()) return;

        const bufferedAmount = typeof this.connection?.getBufferedAmount === 'function'
            ? this.connection.getBufferedAmount()
            : (typeof this.context?.dataChannelManager?.dataChannel?.bufferedAmount === 'number'
                ? this.context.dataChannelManager.dataChannel.bufferedAmount
                : 0);
        if (bufferedAmount > 2048 * 1024) {
            setTimeout(() => readSlice(offset), 50);
            return;
        }

        const arrayBuffer = e.target.result;

        const header = {
            type: 'file-data-binary',
            id: this.transferId,
            offset: offset,
            totalSize: fileSize,
            byteLength: arrayBuffer.byteLength
        };

        // Check if connection has sendDataReliable method
        let headerOk = true;
        if (this.connection && typeof this.connection.sendDataReliable === 'function') {
            headerOk = await this.connection.sendDataReliable(header, { timeoutMs: 20000 });
        } else if (this.connection && typeof this.connection.sendData === 'function') {
            this.connection.sendData(header);
        } else if (this.dataChannelManager && typeof this.dataChannelManager.sendData === 'function') {
            this.dataChannelManager.sendData(header);
        } else {
            this.logger.error('[FileTransferSender] unable to senddata: no available sendData method');
            headerOk = false;
        }
        if (!headerOk) {
            setTimeout(() => readSlice(offset), 50);
            return;
        }

        // Check if connection has sendBinaryReliable method
        let binOk = true;
        if (this.connection && typeof this.connection.sendBinaryReliable === 'function') {
            binOk = await this.connection.sendBinaryReliable(arrayBuffer, { timeoutMs: 20000 });
        } else if (this.dataChannelManager && typeof this.dataChannelManager.sendBinary === 'function') {
            // Use dataChannelManager's sendBinary method
            this.dataChannelManager.sendBinary(arrayBuffer);
        } else {
            this.logger.error('[FileTransferSender] unable to send binary data: no available sendBinary method');
            binOk = false;
        }
        if (!binOk) {
            setTimeout(() => readSlice(offset), 50);
            return;
        }

        offset += arrayBuffer.byteLength;

        if (offset % (this.chunkSize * 5) === 0 || offset >= fileSize) {
            const progress = Math.min(100, Math.round((offset / fileSize) * 100));
            const progressMsg = {
                type: 'file-progress',
                id: this.transferId,
                progress: progress,
                receivedSize: offset,
                totalSize: fileSize,
                chunkSize: arrayBuffer.byteLength
            };
            if (this.connection && typeof this.connection.sendDataReliable === 'function') {
              this.connection.sendDataReliable(progressMsg, { timeoutMs: 5000 }).catch(err => this.logger.debug('Send progress failed:', err));
            } else {
              this.connection.sendData(progressMsg);
            }

            // [FIX] Record sender's sent bytes to local transfer_metadata
            // When loading history after restart, actual progress can be restored from here to avoid showing 0%
            if (this.electronAPI?.updateTransferMetadata) {
              const storedFileName = file._storedFileName || `${this.transferId}-${file.name}`;
              this.electronAPI.updateTransferMetadata({
                msgId: this.transferId,
                fileName: file.name,
                storedFileName: storedFileName,
                totalSize: fileSize,
                receivedSize: offset,
                status: 'sending',
                userId: this.context.myEmail
              }).catch(err => this.logger.debug('[FileTransferSender] savesendprogressfailed:', err));
            }

            if (progress % 20 === 0 || progress >= 95) {
                const elapsed = Date.now() - this.startTime;
                const speed = offset / (elapsed / 1000);
                this.transferSpeed = speed;
                this.logger.info(`[FileTransferSender] transferprogress: ${progress}%, speed=${this.utils.formatBytes(speed)}/s`);
            }
        }

        if (offset < fileSize) {
            readSlice(offset);
        } else {
            const elapsed = Date.now() - this.startTime;
            const speed = fileSize / (elapsed / 1000);
            this.logger.info(`[FileTransferSender] fileTransfer completed: ${file.name}, elapsed time=${elapsed}ms, average speed=${this.utils.formatBytes(speed)}/s`);
            
            this.logger.info(`[FileTransferSender] preparesend file-complete message, transferId=${this.transferId}`);
            
            const completeMsg = {
                type: 'file-complete',
                id: this.transferId,
                filename: file.name,
                totalSize: fileSize,
                duration: elapsed
            };
            
            if (this.connection && typeof this.connection.sendDataReliable === 'function') {
              await this.connection.sendDataReliable(completeMsg, { timeoutMs: 20000 });
            } else {
              this.connection.sendData(completeMsg);
            }
            
            await this.handleTransferComplete(file);
        }
    };

    readSlice(offset);
  }

  /**
   * Handle transfer phase completion (all data sent), enter awaiting receiver confirmation state
   */
  async handleTransferComplete(file) {
    this.logger.info(`[FileTransferSender] transferphasecompleted (datafinished sending): ${file.name}, ID: ${this.transferId}`);

    // Update UI state to waiting for receiver confirmation
    this.uiManager.updateFileRequestStatus(this.transferId, window.i18n?.t ? window.i18n.t('chat.peerReceived') : 'Sent, waiting for peer confirmation...');
    
    const isImage = file.type && file.type.indexOf('image') !== -1;
    
    if (isImage) {
      let filePath = this.copiedPaths.get(this.transferId);
      if (!filePath && file.path) {
        filePath = file.path;
      }
      
      let storedFileName = filePath ? filePath.split(/[\\/]/).pop() : file.name;
      
      if (filePath) {
        this.uiManager.showFileCompleteActions(this.transferId, filePath);
      }
      
      const offer = {
        id: this.transferId,
        filename: file.name,
        mimeType: file.type,
        storedFileName: storedFileName,
        size: file.size
      };
      
      await new Promise(resolve => setTimeout(resolve, 300));
      await this.uiManager.updateMessageToImageDisplay(this.transferId, offer, true, filePath);
      
      // Thumbnail was pre-generated before sending, do not regenerate here
      
      try {
        if (this.electronAPI && this.electronAPI.updateChatMessageContent) {
          const shadowRoot = this.context.shadowRoot;
          const fileRequestEl =
            shadowRoot?.querySelector(`#file-request-${this.transferId}`) ||
            shadowRoot?.querySelector(`#msg-container-${this.transferId} #file-request-${this.transferId}`);

          if (fileRequestEl) {
            let contentToSave = fileRequestEl.outerHTML;
            if (fileRequestEl.tagName === 'IMAGE-FILE-DISPLAY') {
              const fileName = offer.storedFileName || offer.filename;
              const imageUrl = await this._getImageUrl(fileName, true);
              const thumbnailFileName = getThumbnailFileName(fileName);
              const thumbnailUrl = await this._getImageUrl(thumbnailFileName, true);
              const senderEmail = this.context.myEmail;
              const receiverEmail = this.context.targetEmail;
              const fileSize = this.utils.formatBytes(offer.size);
              const fileInfo = `filename: ${offer.filename} | size: ${fileSize} | sender: ${senderEmail} | receiver: ${receiverEmail} | transfermethod: WebRTC`;
              
              contentToSave = `<div class="image-message file-request" id="file-request-${this.transferId}" data-stored-filename="${fileName}" data-file-path="${filePath}" style="margin-top: 8px;">
                <img src="${thumbnailUrl}" data-original-src="${imageUrl}" alt="${fileName}" title="${fileInfo}" style="max-width: 200px; height: auto; border-radius: 4px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.1);" onclick="window.open(this.dataset.originalSrc || this.src, '_blank');" onerror="if(this.dataset.originalSrc && this.src!==this.dataset.originalSrc && !this._fb){this._fb=1;this.src=this.dataset.originalSrc;}">
              </div>`;
            }
            await this.electronAPI.updateChatMessageContent({
              msgid: this.transferId,
              fromer: this.context.myEmail,
              toer: this.context.targetEmail,
              content: contentToSave
            });
          }
        }
      } catch (error) {
        this.logger.error(`[FileTransferSender] sendersaveimage displayto datalibraryfailed:`, error);
      }
    } else {
      let filePath = this.copiedPaths.get(this.transferId);
      if (!filePath && file.path) {
        filePath = file.path;
      }
 
      if (this.electronAPI && this.electronAPI.updateChatMessageContent) {
          const shadowRoot = this.context.shadowRoot;
          let fileRequestEl = shadowRoot?.querySelector(`#file-request-${this.transferId}`) || 
                              this.context.root.querySelector(`#file-request-${this.transferId}`);
          if (fileRequestEl) {
            let contentToSave = fileRequestEl.outerHTML;
            if (fileRequestEl.tagName === 'NORMAL-FILE-DISPLAY') {
              const fileName = fileRequestEl.shadowRoot?.querySelector('.file-name')?.textContent || 'file';
              const fileSize = fileRequestEl.shadowRoot?.querySelector('.file-size')?.textContent || '';
              const storedFileName = (filePath ? filePath.split(/[\\/]/).pop() : (fileName || file?.name || '')).trim();
              const filePathAttr = filePath ? ` data-file-path="${filePath}"` : '';
              const storedFileAttr = storedFileName ? ` data-stored-filename="${storedFileName}"` : '';
              const mimeTypeAttr = file?.type ? ` data-mime-type="${file.type}"` : '';
              const fileSizeAttr = Number.isFinite(file?.size) ? ` data-file-size="${file.size}"` : '';
              contentToSave = `<div class="file-request" id="file-request-${this.transferId}"${mimeTypeAttr}${fileSizeAttr}${storedFileAttr}${filePathAttr} data-is-sender="true">
                <div class="file-info">
                  <span class="file-icon">📔</span>
                  <div class="file-details">
                    <div class="file-name">${fileName}</div>
                    <div class="file-meta">
                      <span class="file-size">${fileSize}</span>
                      <span class="file-status">Sent, waiting for peer confirmation...</span>
                    </div>
                  </div>
                </div>
              </div>`;
            }
            await this.electronAPI.updateChatMessageContent({
                msgid: this.transferId,
                fromer: this.context.myEmail,
                toer: this.context.targetEmail,
                content: contentToSave
            });
          }
      }
    }
  }

  /**
   * Handle peer's successful-save ACK message
   */
  async handleFileSaveSuccess(data) {
    const id = data.id;
    this.logger.info(`[FileTransferSender] received peer save-success ACK: ${id}`);

    // Check if it's MP4 streaming transfer and delegate handling
    if (this.mp4StreamingSender && (data.isMP4Stream || this.mp4StreamingSender.transferId === id)) {
      await this.mp4StreamingSender.handleFileSaveSuccess(data);
    }

    // Update UI state
    this.uiManager.updateFileRequestStatus(id, window.i18n?.t ? window.i18n.t('chat.saveComplete') : 'Send completed');
    
    // Update message status to completed (100)
    const progressSnapshot = this.progressSnapshots.get(id);
    const snapshotTotal = typeof progressSnapshot?.totalSize === 'number' ? progressSnapshot.totalSize : 0;
    const currentTotal = (this.transferId === id && this.currentFile && Number.isFinite(this.currentFile.size))
      ? this.currentFile.size
      : 0;
    const finalTotal = snapshotTotal || currentTotal;
    if (finalTotal > 0) {
      this.uiManager.updateProgressDisplay(id, 100, finalTotal, finalTotal, this.transferSpeed);
    }

    let ackFilePath = this.copiedPaths.get(id);
    if (!ackFilePath && this.transferId === id && this.currentFile?.path) {
      ackFilePath = this.currentFile.path;
    }
    if (ackFilePath) {
      this.uiManager.showFileCompleteActions(id, ackFilePath);
    }

    markMessageAsCompleted(id, {
      fromer: this.context.myEmail,
      retry: true,
      maxRetries: 2
    });

    const transferInfo = this._activeTransferInfo.get(id);
    const totalSize = transferInfo?.totalSize || 0;
    
    if (this.electronAPI?.updateTransferMetadata) {
      this.electronAPI.updateTransferMetadata({
        msgId: id,
        userId: this.context.myEmail,
        received_size: totalSize,
        total_size: totalSize
      }).catch(error => {
        this.logger.warn(`[FileTransferSender] update transfer metadata failed: ${id}`, error);
      });
    }

    this.progressSnapshots.delete(id);
    this.fileHashes.delete(id);
    this.copiedPaths.delete(id);

    this.context.fileTransferManager?.saveTransferState?.();
    
    // UI-level confirmation marker [FIX] use await for async method completion
    if (this.context.uiRenderer && this.context.uiRenderer.markMessageAsConfirmed) {
      await this.context.uiRenderer.markMessageAsConfirmed(id);
    }

    // Update final HTML in database
    if (this.electronAPI && this.electronAPI.updateChatMessageContent) {
      const shadowRoot = this.context.shadowRoot;
      let fileRequestEl = shadowRoot?.querySelector(`#file-request-${id}`) || 
                          this.context.root.querySelector(`#file-request-${id}`);
      
      if (!fileRequestEl && shadowRoot) {
          // Try to find in video-file-display
          const videoComponents = shadowRoot.querySelectorAll('video-file-display');
          for (const comp of videoComponents) {
              if (comp.shadowRoot && comp.shadowRoot.querySelector(`#file-request-${id}`)) {
                  fileRequestEl = comp.shadowRoot.querySelector(`#file-request-${id}`);
                  break;
              }
          }
      }

      if (fileRequestEl && (fileRequestEl.tagName === 'NORMAL-FILE-DISPLAY' || fileRequestEl.tagName === 'VIDEO-FILE-DISPLAY')) {
        const fileName = fileRequestEl.shadowRoot?.querySelector('.file-name')?.textContent || 'file';
        const fileSize = fileRequestEl.shadowRoot?.querySelector('.file-size')?.textContent || '';
        const storedFileName = fileRequestEl.getAttribute('data-stored-filename') || '';
        const filePath = fileRequestEl.getAttribute('data-file-path') || ackFilePath || '';
        const filePathAttr = filePath ? ` data-file-path="${filePath}"` : '';
        const storedFileAttr = storedFileName ? ` data-stored-filename="${storedFileName}"` : '';
        const isMP4Attr = fileRequestEl.tagName === 'VIDEO-FILE-DISPLAY' ? ' data-is-mp4-stream="true"' : '';
        
        let contentToSave;
        if (fileRequestEl.tagName === 'VIDEO-FILE-DISPLAY') {
           // Keep video message original structure
           contentToSave = fileRequestEl.outerHTML;
        } else {
          contentToSave = `<div class="file-request" id="file-request-${id}"${storedFileAttr}${filePathAttr}${isMP4Attr} data-is-sender="true">
            <div class="file-info">
              <span class="file-icon">📔</span>
              <div class="file-details">
                <div class="file-name">${fileName}</div>
                <div class="file-meta">
                  <span class="file-size">${fileSize}</span>
                  <span class="file-status">Transfer completed</span>
                </div>
              </div>
            </div>
          </div>`;
        }
        
        await this.electronAPI.updateChatMessageContent({
            msgid: id,
            fromer: this.context.myEmail,
            toer: this.context.targetEmail,
            content: contentToSave
        });
      }
    }

    if (this.transferId === id) {
      this.transferId = null;
      this.currentFile = null;
    }
    this._activeTransferInfo.delete(id);
  }

  /**
   * Handle receiver's disk write progress
   * Always update UI using receiver's real progress to keep sender and receiver in sync
   */
  handleReceiverFileProgress(data) {
    if (!data || !data.id) return;

    this.logger.info(`[FileTransferSender] received receiver disk-write progress: id=${data.id}, progress=${data.progress}%, receivedSize=${data.receivedSize}, totalSize=${data.totalSize}`);

    // Save progress snapshot for showing interrupted state during resume
    this.progressSnapshots.set(data.id, {
      receivedSize: data.receivedSize,
      totalSize: data.totalSize,
      progress: data.progress,
      timestamp: Date.now()
    });

    const info = this._activeTransferInfo.get(data.id);
    if (this.electronAPI?.updateTransferMetadata && info) {
      this.electronAPI.updateTransferMetadata({
        msgId: data.id,
        fileName: info.name,
        storedFileName: info.storedFileName,
        totalSize: data.totalSize,
        receivedSize: data.receivedSize,
        status: 'sending',
        userId: this.context.myEmail
      }).catch(err => this.logger.debug('[FileTransferSender] syncreceiveprogressfailed:', err));
    }

    if (this.uiManager.isTransferComplete && this.uiManager.isTransferComplete(data.id)) {
      this._activeTransferInfo.delete(data.id); // [NEW] Clean up completed transfer info
      return;
    }

    this.uiManager.updateProgressDisplay(data.id, data.progress, data.receivedSize, data.totalSize, this.transferSpeed);
  }

  // ===== Email image sending methods =====

  /**
   * Send image via regular email (fallback when WebRTC is not connected)
   * @param {File} file - Image file object
   * @param {Object} offer - File offer info
   */
  async sendImageViaEmail(file, offer) {
    const myEmail = this.context.myEmail;
    const targetEmail = this.context.targetEmail;
    
    this.logger.info(`[FileTransferSender] start sending via emailimage: ${file.name} -> ${targetEmail}`);

    try {
      // Ensure file has been copied to sends directory
      let filePath = this.copiedPaths.get(this.transferId);
      if (!filePath && file.path) {
        filePath = file.path;
      }
      
      // Wait a moment if copying is not yet complete
      if (!filePath && this.electronAPI && this.electronAPI.copyFileToSends && file.path) {
        const userId = myEmail;
        const copyResult = await this.electronAPI.copyFileToSends(file.path, this.transferId, userId);
        if (copyResult.success) {
          filePath = copyResult.filePath;
          this.copiedPaths.set(this.transferId, filePath);
          this.logger.info(`[FileTransferSender] file copied to sends directory: ${filePath}`);
        }
      }

      if (!filePath) {
        throw new Error('unable to getimagefile path');
      }

      // Build attachment info
      const attachments = [{
        filename: file.name,
        path: filePath
      }];

      // Send regular email with subject mailink_picture
      const config = window.getSelectedConfig ? window.getSelectedConfig() : null;
      if (!config) {
        throw new Error('Not obtainedto email config');
      }

      const subject = `mailink_picture:${file.name}`;
      this.logger.info(`[FileTransferSender] send image email: subject=${subject}, to=${targetEmail}, file=${file.name}`);
      
      const result = await this.electronAPI.sendemail(config, {
        to: targetEmail,
        subject: subject,
        text: `[Mailinkemail chatsoftware: image] sendto ${targetEmail}`,
        attachments: attachments
      });

      this.logger.info(`[FileTransferSender] image emailsendsucceeded:`, result);

      // Send success, update to 100 using unified state management
      try {
        await markMessageAsCompleted(this.transferId, {
          fromer: myEmail,
          retry: true,
          maxRetries: 2
        });
        this.logger.info(`[FileTransferSender] image messagestatusUpdated as 100: ${this.transferId}`);
      } catch (error) {
        this.logger.error('[FileTransferSender] failed to update message status:', error);
      }

      // Mark image as sent via email to prevent duplicate sending after WebRTC connects
      this.persistence.markImageAsEmailSent(this.transferId);

      // UI marks as confirmed [FIX] use await to wait for async method to complete
      if (this.context.uiRenderer && this.context.uiRenderer.markMessageAsConfirmed) {
        await this.context.uiRenderer.markMessageAsConfirmed(this.transferId);
      }

      return result;

    } catch (error) {
      this.logger.error(`[FileTransferSender] viafailed to send image via email: ${error.message}`, error);
      throw error; // Throw to let caller handle fallback logic
    }
  }

  /**
   * Send non-image files via regular email
   * When WebRTC is not connected, files <25MB are sent as email attachments
   * Subject format: maillink_file:fullFilename
   */
  async sendFileViaEmail(file, offer) {
    const myEmail = this.context.myEmail;
    const targetEmail = this.context.targetEmail;
    
    this.logger.info(`[FileTransferSender] start sending via emailfile: ${file.name} -> ${targetEmail}`);

    try {
      // Ensure file has been copied to sends directory
      let filePath = this.copiedPaths.get(this.transferId);
      if (!filePath && file.path) {
        filePath = file.path;
      }

      if (!filePath && this.electronAPI && this.electronAPI.copyFileToSends && file.path) {
        const userId = myEmail;
        const copyResult = await this.electronAPI.copyFileToSends(file.path, this.transferId, userId);
        if (copyResult.success) {
          filePath = copyResult.filePath;
          this.copiedPaths.set(this.transferId, filePath);
          this.logger.info(`[FileTransferSender] file copied to sends directory: ${filePath}`);
        }
      }

      if (!filePath) {
        throw new Error('unable to getfile path');
      }

      // Build attachment info
      const attachments = [{
        filename: file.name,
        path: filePath
      }];

      // Send regular email with subject maillink_file:filename
      const config = window.getSelectedConfig ? window.getSelectedConfig() : null;
      if (!config) {
        throw new Error('Not obtainedto email config');
      }

      const subject = `maillink_file:${file.name}`;
      this.logger.info(`[FileTransferSender] send file email: subject=${subject}, to=${targetEmail}, file=${file.name}`);
      
      const result = await this.electronAPI.sendemail(config, {
        to: targetEmail,
        subject: subject,
        text: `[mailinkfile] sendto ${targetEmail}`,
        attachments: attachments
      });

      this.logger.info(`[FileTransferSender] fileemail sendingsucceeded:`, result);

      // Update UI state to "sent via email"
      this.uiManager.updateFileRequestStatus(this.transferId, 'viaemail sending');

      // Send success, update to 100 using unified state management
      try {
        await markMessageAsCompleted(this.transferId, {
          fromer: myEmail,
          retry: true,
          maxRetries: 2
        });
        this.logger.info(`[FileTransferSender] filemessage statusUpdated as 100: ${this.transferId}`);
      } catch (error) {
        this.logger.error('[FileTransferSender] failed to update message status:', error);
      }

      // Mark as sent via email to prevent duplicate sending after WebRTC connects
      this.persistence.markImageAsEmailSent(this.transferId);

      // UI marks as confirmed [FIX] use await to wait for async method to complete
      if (this.context.uiRenderer && this.context.uiRenderer.markMessageAsConfirmed) {
        await this.context.uiRenderer.markMessageAsConfirmed(this.transferId);
      }

      return result;

    } catch (error) {
      this.logger.error(`[FileTransferSender] viafailed to send file via email: ${error.message}`, error);
      throw error;
    }
  }

  // ===== Helper methods =====

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
        this.logger.warn(`[FileTransferSender] exception getting port: ${e.message}`);
      }
    }
    
    const directory = isSender ? 'sends' : 'recvs';
    const userId = this.context.myEmail || '';
    return `http://127.0.0.1:${port}/${userId}/files/${directory}/${encodeURIComponent(fileName)}`;
  }

  // ===== Helper methods =====

  /**
   * Request message status sync
   */
  async requestMessageStatusSync(targetEmail) {
    return this.persistence.requestMessageStatusSync(targetEmail, this.connection);
  }
}
