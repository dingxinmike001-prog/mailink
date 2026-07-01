/**
 * File transfer sender persistence management module
 * Manages pending images, database persistence, status sync, etc.
 *
 * Message status definitions:
 * - 0: Not sent
 * - 50: Sending (WebRTC or email)
 * - 60: Sent via email, awaiting confirmation
 * - 100: Confirmed received
 */

import { markMessageAsCompleted } from '../../../../utils/status.js';

export class FileTransferSenderPersistence {
  constructor(context, uiManager) {
    this.context = context;
    this.uiManager = uiManager;
    this._resendingPendingImages = false;
    this._emailSentImages = new Map();
    this._emailSentImagesExpiry = 5 * 60 * 1000;
  }

  get logger() { return this.context.logger; }
  get electronAPI() { return window.electronAPI; }

  _cleanExpiredEmailSentImages() {
    const now = Date.now();
    for (const [msgid, timestamp] of this._emailSentImages) {
      if (now - timestamp > this._emailSentImagesExpiry) {
        this._emailSentImages.delete(msgid);
      }
    }
  }

  markImageAsEmailSent(msgid) {
    this._cleanExpiredEmailSentImages();
    this._emailSentImages.set(msgid, Date.now());
    this.logger.info(`[FileTransferSenderPersistence] 📧 markimageviaemail sending: ${msgid}`);
  }

  isImageEmailSent(msgid) {
    this._cleanExpiredEmailSentImages();
    return this._emailSentImages.has(msgid);
  }

  clearEmailSentMark(msgid) {
    this._emailSentImages.delete(msgid);
    this.logger.info(`[FileTransferSenderPersistence] 🗑️ clearemail sendingmark: ${msgid}`);
  }

  /**
   * Check if message has been sent
   * @param {string} msgid - Message ID
   * @returns {Promise<boolean>}
   */
  async checkMessageAlreadySent(msgid) {
    try {
      if (!this.electronAPI || !this.electronAPI.getChatMessageByMsgid) {
        return false;
      }

      const message = await this.electronAPI.getChatMessageByMsgid({
        msgid: msgid,
        dbUser: this.context.myEmail
      });

      return message && message.status === 100;
    } catch (error) {
      this.logger.warn(`[FileTransferSenderPersistence] checkmessage statusfailed: ${msgid}`, error);
      return false;
    }
  }

  /**
   * Get pending images to send
   * @param {string} targetEmail - Target email
   * @returns {Promise<Array>}
   */
  async getPendingImages(targetEmail) {
    if (!this.electronAPI || !this.electronAPI.getPendingImages) {
      this.logger.warn('[FileTransferSenderPersistence] getPendingImages: API unavailable');
      return [];
    }

    try {
      const myEmail = this.context.myEmail;
      if (!myEmail) {
        this.logger.warn('[FileTransferSenderPersistence] getPendingImages: myEmail Not set');
        return [];
      }

      const pendingImages = await this.electronAPI.getPendingImages({
        fromer: myEmail,
        toer: targetEmail
      });

      const filteredImages = pendingImages.filter(img => {
        if (this.isImageEmailSent(img.msgid)) {
          this.logger.info(`[FileTransferSenderPersistence] ⏭️ imageviaemail sending, skip: ${img.msgid}`);
          return false;
        }
        return true;
      });

      this.logger.info(`[FileTransferSenderPersistence] getto  ${pendingImages.length} awaitingsendimage, filterafter ${filteredImages.length} sheet`);
      return filteredImages || [];
    } catch (error) {
      this.logger.error('[FileTransferSenderPersistence] getpendingsendimagefailed:', error);
      return [];
    }
  }

  /**
   * Build image attachments
   * @param {Array} pendingImages - Pending image list
   * @returns {Promise<Array>}
   */
  async buildImageAttachments(pendingImages) {
    const attachments = [];

    for (const imgMsg of pendingImages) {
      try {
        const content = imgMsg.content || '';
        const filenameMatch = content.match(/alt="([^"]+)"/);
        const filename = filenameMatch ? filenameMatch[1] : (imgMsg.filename || `image-${imgMsg.msgid}.png`);

        let filePath = '';
        const userId = this.context.myEmail;
        if (this.electronAPI && this.electronAPI.getSentFilePath) {
          const pathResult = await this.electronAPI.getSentFilePath(filename, true, userId);
          if (pathResult && pathResult.success) {
            filePath = pathResult.filePath;
          }
        }

        if (!filePath && imgMsg.storedFileName) {
          const pathResult = await this.electronAPI.getSentFilePath(imgMsg.storedFileName, true, userId);
          if (pathResult && pathResult.success) {
            filePath = pathResult.filePath;
          }
        }

        if (!filePath) {
          this.logger.warn(`[FileTransferSenderPersistence] Not foundimagefile path: ${filename}`);
          continue;
        }

        attachments.push({
          filename: filename,
          path: filePath,
          cid: imgMsg.msgid,
          originalMsgId: imgMsg.msgid
        });

        this.logger.info(`[FileTransferSenderPersistence] Preparedimage attachment: ${filename}`);
      } catch (error) {
        this.logger.error(`[FileTransferSenderPersistence] buildimage attachmentfailed:`, error);
      }
    }

    return attachments;
  }

  /**
   * Update image message status to sent
   * @param {Array} pendingImages - Pending image list
   */
  async updateImageMessageStatus(pendingImages) {
    const myEmail = this.context.myEmail;
    for (const imgMsg of pendingImages) {
      try {
        // Use unified state management function
        const result = await markMessageAsCompleted(imgMsg.msgid, {
          fromer: myEmail,
          retry: true,
          maxRetries: 2
        });

        if (result.success) {
          this.logger.info(`[FileTransferSenderPersistence] image messagestatusUpdated as Sent: ${imgMsg.msgid}`);
        } else {
          this.logger.warn(`[FileTransferSenderPersistence] updateimage messagestatusfailed: ${imgMsg.msgid}, ${result.error}`);
        }
      } catch (error) {
        this.logger.error(`[FileTransferSenderPersistence] updateimage messagestatusfailed: ${imgMsg.msgid}`, error);
      }
    }
  }

  /**
   * Clear sent images
   * @param {Array} sentImages - Sent image list
   */
  async clearPendingImages(sentImages) {
    if (!this.electronAPI || !this.electronAPI.deletePendingImages) {
      this.logger.warn('[FileTransferSenderPersistence] deletePendingImages API unavailable');
      return;
    }

    if (!sentImages || sentImages.length === 0) {
      return;
    }

    try {
      const myEmail = this.context.myEmail;
      const msgIds = sentImages.map(img => img.msgid).filter(Boolean);
      
      if (msgIds.length === 0) {
        return;
      }

      await this.electronAPI.deletePendingImages({
        fromer: myEmail,
        msgids: msgIds
      });
      
      this.logger.info(`[FileTransferSenderPersistence] Cleared ${msgIds.length} sheetSentimage`);
    } catch (error) {
      this.logger.error('[FileTransferSenderPersistence] clearSentimagefailed:', error);
    }
  }

  /**
   * Load pending image messages (status=50) from database
   * Used to resume unfinished image sends after app restart
   * @param {string} targetEmail - Target email
   * @returns {Promise<Array>}
   */
  async loadPendingImagesFromDB(targetEmail) {
    if (!this.electronAPI || !this.electronAPI.getUnsentMessages) {
      this.logger.warn('[FileTransferSenderPersistence] loadPendingImagesFromDB: getUnsentMessages API unavailable');
      return [];
    }

    const myEmail = this.context.myEmail;
    if (!myEmail || !targetEmail) {
      this.logger.warn('[FileTransferSenderPersistence] loadPendingImagesFromDB: email info incomplete');
      return [];
    }

    try {
      const params = { fromer: myEmail, toer: targetEmail };
      const messages = await this.electronAPI.getUnsentMessages(params);
      
      // Filter image messages (status=50, content contains image markers, and not sent via email)
      const pendingImages = messages.filter(msg => {
        if (msg.status !== 50) return false;
        // Skip images already sent via email
        if (this.isImageEmailSent(msg.msgid)) {
          this.logger.info(`[FileTransferSenderPersistence] ⏭️ imageviaemail sending, skipresend: ${msg.msgid}`);
          return false;
        }
        const content = msg.content || '';
        // Match characteristics of image messages
        return content.includes('file-request-') && 
               (content.includes('image-message') || 
                content.includes('data-image-') ||
                content.includes('image/'));
      });

      this.logger.info(`[FileTransferSenderPersistence] from datalibrary loadingto  ${pendingImages.length} awaitingsendimage`);
      return pendingImages;
    } catch (error) {
      this.logger.error('[FileTransferSenderPersistence] from datalibrary loading pendingsendimagefailed:', error);
      return [];
    }
  }

  /**
   * Request message status sync
   * Query receiver for confirmed message statuses to update local state after sender re-login
   * @param {string} targetEmail - Target email (receiver)
   * @param {Object} connection - WebRTC connection object
   */
  async requestMessageStatusSync(targetEmail, connection) {
    const myEmail = this.context.myEmail;
    if (!myEmail || !targetEmail) {
      this.logger.warn('[FileTransferSenderPersistence] requestMessageStatusSync: email info incomplete');
      return;
    }

    this.logger.info(`[FileTransferSenderPersistence] requestmessagestatus sync: ${myEmail} -> ${targetEmail}`);

    try {
      // Query all local messages with status=50 (including text and images)
      if (!this.electronAPI || !this.electronAPI.getUnsentMessages) {
        this.logger.warn('[FileTransferSenderPersistence] requestMessageStatusSync: getUnsentMessages API unavailable');
        return;
      }

      const params = { fromer: myEmail, toer: targetEmail };
      const pendingMessages = await this.electronAPI.getUnsentMessages(params);

      if (!pendingMessages || pendingMessages.length === 0) {
        this.logger.info('[FileTransferSenderPersistence] no messages pending sync');
        return;
      }

      // Extract message ID list
      const messageIds = pendingMessages.map(msg => msg.msgid).filter(id => id);

      if (messageIds.length === 0) {
        this.logger.info('[FileTransferSenderPersistence] no valid message IDs need sync');
        return;
      }

      this.logger.info(`[FileTransferSenderPersistence] sendstatus syncrequest, include ${messageIds.length} itemmessage`);

      // Send status sync request
      const syncRequest = {
        type: 'status-sync-request',
        messageIds: messageIds,
        fromEmail: myEmail,
        timestamp: Date.now()
      };

      // Use connection to send data
      if (connection && connection.sendData) {
        const sent = connection.sendData(syncRequest);
        if (sent) {
          this.logger.info(`[FileTransferSenderPersistence] status syncrequestSent: ${messageIds.length} itemmessage`);
        } else {
          this.logger.warn('[FileTransferSenderPersistence] status syncrequestsendfailed');
        }
      } else {
        this.logger.warn('[FileTransferSenderPersistence] connection.sendData unavailable, unable to sendsyncrequest');
      }

    } catch (error) {
      this.logger.error('[FileTransferSenderPersistence] requestMessageStatusSync executefailed:', error);
    }
  }
}
