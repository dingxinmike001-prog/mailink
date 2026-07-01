import { IMAGE_MIME_TYPES } from '../config.js';

export class BaseTransferReceiver {
  constructor(context, uiManager, stateManager) {
    this.context = context;
    this.uiManager = uiManager;
    this.stateManager = stateManager;
    
    // Receiving-related state
    this.fileChunks = new Map();
    this.fileOffers = new Map();
    this.recvWriteQueues = new Map();
    this.recvWriteInflight = new Map();
    this.maxRecvWriteInflight = 8;
  }

  get logger() { return this.context.logger; }
  get utils() { return this.context.utils; }
  get connection() { return this.context.connection; }
  get electronAPI() { return window.electronAPI; }

  /**
   * Check connection status
   */
  isConnected() {
    if (!this.connection || !this.connection.isConnected()) return false;
    if (typeof this.connection.isDataChannelOpen === 'function') {
      return this.connection.isDataChannelOpen();
    }
    return true;
  }

  /**
   * Save state
   */
  saveState() {
    if (this.stateManager && typeof this.stateManager.saveTransferState === 'function') {
      this.stateManager.saveTransferState(this.fileChunks, this.fileOffers, new Map(), new Map());
    }
  }

  /**
   * Check if message already exists in database
   */
  async checkExistingMessageDB(msgid) {
    try {
      if (!this.electronAPI || !this.electronAPI.getChatMessageByMsgid) {
        return false;
      }

      const message = await this.electronAPI.getChatMessageByMsgid({
        msgid: msgid,
        dbUser: this.context.myEmail
      });

      return !!message;
    } catch (error) {
      this.logger.warn(`[BaseTransferReceiver] failed to check message existence: ${msgid}`, error);
      return false;
    }
  }

  /**
   * Check if message has been fully received (status=100)
   */
  async checkMessageAlreadyReceivedDB(msgid) {
    try {
      if (!this.electronAPI || !this.electronAPI.getChatMessageByMsgid) {
        return false;
      }

      const message = await this.electronAPI.getChatMessageByMsgid({
        msgid: msgid,
        dbUser: this.context.myEmail
      });

      if (message && message.status === 100) {
        return true;
      }

      return false;
    } catch (error) {
      this.logger.warn(`[BaseTransferReceiver] failed to check message receive status: ${msgid}`, error);
      return false;
    }
  }

  /**
   * Send ACK confirmation
   */
  sendAck(msgId) {
    if (this.connection && this.connection.sendData) {
      const ackMsg = { type: 'ack', id: msgId };
      this.connection.sendData(ackMsg);
      this.logger.info(`[BaseTransferReceiver] send ACK confirmation: ${msgId}`);
    }
  }

  /**
   * Smart breakpoint matching
   */
  async findResumeOffset(offer) {
    let offset = 0;
    
    if (!this.electronAPI || !this.electronAPI.getTransferMetadata) {
        return { offset: 0, metadata: null };
    }
    
    try {
        // Standard exact matching
        let metadata = await this.electronAPI.getTransferMetadata({ 
            msgId: offer.id, 
            userId: this.context.myEmail 
        });

        // Smart matching (if standard matching fails or breakpoint is 0 and hash/size are available)
        if ((!metadata || metadata.received_size === 0) && offer.size && offer.fileHash) {
            this.logger.info(`[BaseTransferReceiver] current ID has no breakpoint record, try smart matching by hash and size...`);
            
            if (this.electronAPI.findIncompleteTransferByHashAndSize) {
                const smartMatchedMetadata = await this.electronAPI.findIncompleteTransferByHashAndSize({
                    fileHash: offer.fileHash,
                    size: offer.size,
                    userId: this.context.myEmail,
                    senderId: this.context.targetEmail
                });

                if (smartMatchedMetadata && smartMatchedMetadata.received_size > 0 && smartMatchedMetadata.received_size < offer.size) {
                    this.logger.info(`[BaseTransferReceiver] 🌟 smart match succeeded!foundhistorybreakpoint, oldID: ${smartMatchedMetadata.msg_id}, Received: ${smartMatchedMetadata.received_size}`);
                    
                    metadata = smartMatchedMetadata;
                    
                    const oldFilePath = smartMatchedMetadata.file_path;
                    if (oldFilePath) {
                        const oldStoredName = oldFilePath.split(/[\\/]/).pop();
                        offer.storedFileName = oldStoredName;
                        this.logger.info(`[BaseTransferReceiver] redirected underlying storage name of current offer to historical file: ${oldStoredName}`);
                    }
                }
            }
        }

        if (metadata && metadata.received_size > 0 && metadata.received_size < offer.size) {
            offset = metadata.received_size;
            this.logger.info(`[BaseTransferReceiver] breakpoint found, prepare from ${offset} resume transfer: ${offer.filename}`);
        }
        
        return { offset, metadata };
    } catch (e) {
        this.logger.error('[BaseTransferReceiver] failed to get breakpoint info:', e);
        return { offset: 0, metadata: null };
    }
  }

  /**
   * Process write queue
   */
  drainRecvWriteQueue(transferId) {
    const queue = this.recvWriteQueues.get(transferId);
    if (!queue || queue.length === 0) return;

    const inflight = this.recvWriteInflight.get(transferId) || 0;
    if (inflight >= this.maxRecvWriteInflight) return;

    while (queue.length > 0) {
      const currentInflight = this.recvWriteInflight.get(transferId) || 0;
      if (currentInflight >= this.maxRecvWriteInflight) break;

      const item = queue.shift();
      this.recvWriteInflight.set(transferId, currentInflight + 1);

      this.writeOneRecvChunk(item)
        .catch((error) => {
          this.logger.error(`[BaseTransferReceiver] write failed:`, error);
        })
        .finally(() => {
          const nowInflight = this.recvWriteInflight.get(transferId) || 1;
          const nextInflight = Math.max(0, nowInflight - 1);
          if (nextInflight === 0 && (!queue || queue.length === 0)) {
            this.recvWriteInflight.delete(transferId);
            this.recvWriteQueues.delete(transferId);
          } else {
            this.recvWriteInflight.set(transferId, nextInflight);
          }
          this.drainRecvWriteQueue(transferId);
        });
    }
  }

  /**
   * This method must be implemented by subclass
   * @abstract
   */
  async writeOneRecvChunk(item) {
    throw new Error('writeOneRecvChunk must be implemented by subclass');
  }
}
