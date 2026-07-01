/**
 * File transfer state management module
 * Responsible for persistence, recovery, and cleanup of transfer state
 */

import { safeJsonParse } from '../../../../utils/common.js';

export class FileTransferStateManager {
  constructor(context) {
    this.context = context;
    
    // State storage prefix
    this.STORAGE_PREFIX = 'mailink_file_transfer_';
    this.STORAGE_KEY_TRANSFERS = this.STORAGE_PREFIX + 'active_transfers';
    this.STORAGE_KEY_OFFERS = this.STORAGE_PREFIX + 'file_offers';
    
    // State debounce configuration
    this.CONNECTION_STATUS_THROTTLE_MS = 100;
    this._lastConnectionStatus = { status: null, timestamp: 0 };
    
    // Debounced save related
    this._saveTimeout = null;
    this.SAVE_DEBOUNCE_MS = 500; // 500ms debounce
    this._pendingState = null;
    this._isSaving = false;
  }

  get logger() { return this.context.logger; }

  /**
   * Save transfer state to localStorage (debounced version)
   * @param {Map} fileChunks - Receiver's file chunk data
   * @param {Map} fileOffers - Receiver's file offer info
   * @param {Map} transferOptions - Transfer options
   * @param {Map} progressSnapshots - Receiver's progress snapshots
   * @param {Map} senderProgressSnapshots - [NEW] Sender's progress snapshots
   */
  saveTransferState(fileChunks, fileOffers, transferOptions, progressSnapshots, senderProgressSnapshots = new Map()) {
    // Store pending state to save
    this._pendingState = {
      fileChunks,
      fileOffers,
      transferOptions,
      progressSnapshots,
      senderProgressSnapshots
    };
    
    // Clear previous timer
    if (this._saveTimeout) {
      clearTimeout(this._saveTimeout);
    }
    
    // Set new debounce timer
    this._saveTimeout = setTimeout(() => {
      this._doSaveState();
    }, this.SAVE_DEBOUNCE_MS);
  }
  
  /**
   * Save state immediately (for critical points)
   */
  saveTransferStateImmediate(fileChunks, fileOffers, transferOptions, progressSnapshots, senderProgressSnapshots = new Map()) {
    // Clear pending debounced save
    if (this._saveTimeout) {
      clearTimeout(this._saveTimeout);
      this._saveTimeout = null;
    }
    
    this._pendingState = {
      fileChunks,
      fileOffers,
      transferOptions,
      progressSnapshots,
      senderProgressSnapshots
    };
    
    this._doSaveState();
  }
  
  /**
   * Actually perform save operation
   */
  _doSaveState() {
    if (this._isSaving || !this._pendingState) {
      return;
    }
    
    this._isSaving = true;
    
    // Use requestIdleCallback or setTimeout to defer save until idle
    const scheduleSave = (typeof window !== 'undefined' && window.requestIdleCallback) 
      ? window.requestIdleCallback 
      : (cb) => setTimeout(cb, 0);
    
    scheduleSave(() => {
      try {
        const { fileChunks, fileOffers, transferOptions, progressSnapshots, senderProgressSnapshots } = this._pendingState;
        
        const transferState = {
          fileChunks: Array.from(fileChunks.entries()).map(([id, data]) => ({
            id,
            totalSize: data.totalSize,
            receivedSize: data.receivedSize,
            lastLoggedEndOffset: data.lastLoggedEndOffset
          })),
          fileOffers: Array.from(fileOffers.entries()).map(([id, offer]) => ({
            id,
            filename: offer.filename,
            size: offer.size,
            mimeType: offer.mimeType,
            storedFileName: offer.storedFileName
          })),
          transferOptions: Array.from(transferOptions.entries()),
          progressSnapshots: Array.from(progressSnapshots.entries()),
          senderProgressSnapshots: Array.from(senderProgressSnapshots.entries()),
          timestamp: Date.now()
        };
        
        localStorage.setItem(this.STORAGE_KEY_TRANSFERS, JSON.stringify(transferState));
        this.logger.debug('[FileTransferState] transferstatusSaved');
      } catch (error) {
        this.logger.error('[FileTransferState] savetransferstatusfailed:', error);
      } finally {
        this._isSaving = false;
        this._pendingState = null;
      }
    });
  }

  /**
   * Restore transfer state from localStorage
   */
  restoreTransferState() {
    try {
      const savedState = localStorage.getItem(this.STORAGE_KEY_TRANSFERS);
      if (!savedState) {
        this.logger.info('[FileTransferState] Not foundsavetransferstatus');
        return null;
      }

      const transferState = safeJsonParse(savedState, null);
      const stateAge = Date.now() - transferState.timestamp;
      
      // Consider state expired if saved more than 24 hours ago
      if (stateAge > 24 * 60 * 60 * 1000) {
        this.logger.info('[FileTransferState] transferstatusExpired, clearoldstatus');
        localStorage.removeItem(this.STORAGE_KEY_TRANSFERS);
        return null;
      }

      const result = {
        fileChunks: new Map(),
        fileOffers: new Map(),
        transferOptions: new Map(),
        progressSnapshots: new Map(),
        senderProgressSnapshots: new Map()
      };

      // Restore file chunk state
      if (transferState.fileChunks) {
        transferState.fileChunks.forEach(item => {
          result.fileChunks.set(item.id, {
            totalSize: item.totalSize,
            receivedSize: item.receivedSize,
            lastLoggedEndOffset: item.lastLoggedEndOffset
          });
        });
      }

      // Restore file offer state
      if (transferState.fileOffers) {
        transferState.fileOffers.forEach(item => {
          // Ensure id field is preserved, fallback to item.id or Map key
          const offerId = item.id || item.id;
          result.fileOffers.set(item.id, {
            id: offerId,
            filename: item.filename,
            size: item.size,
            mimeType: item.mimeType,
            storedFileName: item.storedFileName
          });
        });
      }

      // Restore transfer options
      if (transferState.transferOptions) {
        transferState.transferOptions.forEach(([id, options]) => {
          result.transferOptions.set(id, options);
        });
      }

      // Restore progress snapshots
      if (transferState.progressSnapshots) {
        transferState.progressSnapshots.forEach(([id, snapshot]) => {
          result.progressSnapshots.set(id, snapshot);
        });
      }

      // [FIX] Restore sender's progress snapshot
      if (transferState.senderProgressSnapshots) {
        transferState.senderProgressSnapshots.forEach(([id, snapshot]) => {
          result.senderProgressSnapshots.set(id, snapshot);
        });
        this.logger.info(`[FileTransferState] Restored ${transferState.senderProgressSnapshots.length} senderprogress snapshot`);
      }

      this.logger.info(`[FileTransferState] Restored ${result.fileChunks.size} transferstatus`);
      return result;
    } catch (error) {
      this.logger.error('[FileTransferState] resume transferstatusfailed:', error);
      return null;
    }
  }

  /**
   * Clear transfer state
   */
  clearTransferState() {
    try {
      localStorage.removeItem(this.STORAGE_KEY_TRANSFERS);
      this.logger.info('[FileTransferState] transferstatusCleared');
    } catch (error) {
      this.logger.error('[FileTransferState] cleartransferstatusfailed:', error);
    }
  }

  /**
   * Check if connection state change needs handling
   */
  shouldHandleConnectionStatus(status) {
    const now = Date.now();
    
    if (status === this._lastConnectionStatus.status && 
        now - this._lastConnectionStatus.timestamp < this.CONNECTION_STATUS_THROTTLE_MS) {
      return false;
    }
    
    this._lastConnectionStatus = { status, timestamp: now };
    return true;
  }
}
