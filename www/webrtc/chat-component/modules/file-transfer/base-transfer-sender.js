import { calculateFileHash } from './file-transfer-sender-utils.js';

export class BaseTransferSender {
  constructor(context, uiManager) {
    this.context = context;
    this.uiManager = uiManager;
    
    this.isStreaming = false;
    this.transferId = null;
    this.file = null;
    this.startTime = null;
  }

  get logger() { return this.context.logger; }
  get utils() { return this.context.utils; }
  get connection() { return this.context.connection; }
  get dataChannelManager() { return this.context.dataChannelManager; }
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
   * Get file hash
   */
  async getFileHash(file) {
    try {
      return await calculateFileHash(file);
    } catch (error) {
      this.logger.warn(`[BaseTransferSender] file hash calculation failed: ${file?.name}`, error);
      return null;
    }
  }

  /**
   * Stop transfer
   */
  stopStream() {
    this.isStreaming = false;
    this.logger.info(`[BaseTransferSender] transfer stopped: ${this.transferId}`);
  }
}
