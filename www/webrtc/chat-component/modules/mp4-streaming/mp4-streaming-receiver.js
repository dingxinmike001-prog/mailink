/**
 * MP4 streaming receiver module
 * Supports playing MP4 video while receiving
 *
 * This file is the main entry, integrating all functional modules:
 * - MP4Utils: utility functions
 * - MP4StateManager: state management
 * - MP4RangeManager: range management
 * - MP4MoovReassembler: Moov reassembly
 * - MP4VideoPlayer: video player
 * - MP4DataHandler: data processing
 * - MP4ConnectionHandler: connection management
 * - MP4PosterHandler: poster handling
 */

import { markMessageAsCompleted } from '../../../../utils/status.js';
import { createVideoComponent } from '../../../../components/file-display/index.js';
import { BaseTransferReceiver } from '../file-transfer/base-transfer-receiver.js';
import { _triggerTrayFlash, _playNotificationSound, _notifyUnreadIncrement } from '../chat-message.js';

import { MP4Utils } from './mp4-utils.js';
import { MP4StateManager } from './mp4-state-manager.js';
import { MP4RangeManager } from './mp4-range-manager.js';
import { MP4MoovReassembler } from './mp4-moov-reassembler.js';
import { MP4VideoPlayer } from './mp4-video-player.js';
import { MP4DataHandler } from './mp4-data-handler.js';
import { MP4ConnectionHandler } from './mp4-connection-handler.js';
import { MP4PosterHandler } from './mp4-poster-handler.js';

export class MP4StreamingReceiver extends BaseTransferReceiver {
  constructor(context, uiManager) {
    super(context, uiManager, null);

    // Initialize functional modules
    this.utilsModule = new MP4Utils(this);
    this.stateManager = new MP4StateManager(this);
    this.rangeManager = new MP4RangeManager(this);
    this.moovReassembler = new MP4MoovReassembler(this);
    this.videoPlayer = new MP4VideoPlayer(this);
    this.dataHandler = new MP4DataHandler(this);
    this.connectionHandler = new MP4ConnectionHandler(this);
    this.posterHandler = new MP4PosterHandler(this);

    // Video component instance cache
    this.videoComponents = new Map();

    // Playback state
    // Note: MP4 streaming playback needs enough data, especially when moov atom is at file beginning
    // If moov atom is at file end, full reception is required to play
    this.playableThreshold = 5 * 1024 * 1024; // 5MB playable threshold (increased to ensure enough data)
    this.minPlayablePercent = 20; // 20% playable percentage (increased percentage)

    // Polling timer
    this.progressPollers = new Map();
  }

  // ==================== Public API methods ====================

  /**
   * Check if it is MP4 streaming
   */
  isMP4StreamOffer(offer) {
    return this.utilsModule.isMP4StreamOffer(offer);
  }

  /**
   * Handle MP4 file offer
   */
  async handleMP4StreamOffer(offer) {
    this.logger.info(`[MP4StreamingReceiver] received MP4 streamingtransferrequest: ${offer.id}, ${offer.filename}`);

    // Save offer info
    this.fileOffers.set(offer.id, {
      ...offer,
      isMP4Stream: true,
      mp4Structure: {
        ...(offer.mp4Structure || {}),
        playbackPlan: this.utilsModule.buildPlaybackPlanFromOffer(offer)
      },
      startTime: Date.now()
    });

    // Initialize receiving state
    const moovPosition = offer.mp4Structure?.moovPosition || 'unknown';
    const needsReassembly = moovPosition === 'back'; // Reassembly is only needed when moov is at the end

    this.fileChunks.set(offer.id, {
      totalSize: offer.size,
      receivedSize: 0,
      writtenSize: 0,
      canPlay: false,
      notifiedPlayable: false,
      moovPosition: moovPosition,
      needsReassembly: needsReassembly,
      ftypSize: 0,
      moovSize: 0,
      moovReceived: false,
      pendingMdatChunks: [] // Cache mdat data before moov is received
    });

    this.logger.info(`[MP4StreamingReceiver] MP4 structure: moovPosition=${moovPosition}, needsReassembly=${needsReassembly}, filetotalsize=${offer.size}`);

    // Trigger new message notification (tray flash, sound, unread count)
    _triggerTrayFlash(this.context);
    _playNotificationSound(this.context);

    // Use VideoFileDisplay Web Component instead of plain HTML
    try {
      Object.assign(this.fileChunks.get(offer.id), this.stateManager.createInitialFileData(this.fileOffers.get(offer.id)));
      const component = await createVideoComponent(offer, false, this.context, null);

      // Cache component instance
      this.videoComponents.set(offer.id, component);
      this.videoPlayer.bindVideoComponentEvents(component, offer.id);

      const updatedOffer = this.fileOffers.get(offer.id);
      if (updatedOffer && component.setAttribute) {
        component.setAttribute('offer', JSON.stringify(updatedOffer));
      }

      // If poster exists (prefer posterData), set immediately and save to recvs
      if (offer.posterData && component.setPoster) {
        await this.posterHandler._saveAndSetPoster(offer.id, offer.posterData, component);
      } else if (offer.posterFileName && component.setPoster) {
        // Backward compatibility: load from sender's HTTP server
        this.posterHandler._loadPosterImage(offer.id, offer.posterFileName, component);
      }

      // Use displayMessageElement to display component
      if (this.context.uiRenderer?.displayMessageElement) {
        this.context.uiRenderer.displayMessageElement(
          'peer',
          component,
          offer.id,
          Date.now(),
          this.context.targetEmail,
          50
        );
      } else if (this.context.uiRenderer?.displayMessage) {
        // Fallback: use regular displayMessage
        this.context.uiRenderer.displayMessage(
          'peer',
          component.outerHTML,
          offer.id,
          Date.now(),
          this.context.targetEmail,
          50
        );
      }

      // [FIX] Persist message to database so it's visible after restart (status 50 means receiving)
      if (this.electronAPI?.saveChatMessage) {
        let htmlContent;
        if (component instanceof HTMLElement) {
          htmlContent = component.outerHTML;
        } else {
          htmlContent = component;
        }

        this.electronAPI.saveChatMessage({
          fromer: this.context.targetEmail || 'unknown',
          toer: this.context.myEmail || '',
          content: htmlContent,
          type: 2, // file/message type
          status: 50, // transferring
          msgid: offer.id
        }).then(() => {
          this.logger.info(`[MP4StreamingReceiver] initial video messagesave to database: ${offer.id}`);
        }).catch(err => {
          this.logger.warn(`[MP4StreamingReceiver] saveinitial video messagefailed:`, err);
        });
      }

      this.logger.info(`[MP4StreamingReceiver] Created VideoFileDisplay component: ${offer.id}`);

      // Trigger unread message count increase (red badge notification)
      _notifyUnreadIncrement(this.context, new Set(), this.context.targetEmail, offer.id);
    } catch (error) {
      this.logger.error(`[MP4StreamingReceiver] createvideocomponentfailed:`, error);
      // Fallback: use old HTML method
      const htmlMessage = this.utilsModule.renderStreamingVideoMessage(offer);
      if (this.context.uiRenderer?.displayMessage) {
        this.context.uiRenderer.displayMessage(
          'peer',
          htmlMessage,
          offer.id,
          Date.now(),
          this.context.targetEmail,
          50
        );
      }

      // Trigger unread message count increase (red badge notification) - fallback path
      _notifyUnreadIncrement(this.context, new Set(), this.context.targetEmail, offer.id);
    }

    // Auto accept (because it's video, can play while transferring)
    setTimeout(() => this.acceptMP4Stream(offer.id), 100);

    return true;
  }

  /**
   * Accept MP4 streaming transfer
   */
  async acceptMP4Stream(transferId) {
    const offer = this.fileOffers.get(transferId);
    if (!offer) {
      this.logger.warn(`[MP4StreamingReceiver] findnot to  offer: ${transferId}`);
      return;
    }

    this.logger.info(`[MP4StreamingReceiver] Accept MP4 streamingtransfer: ${offer.filename}`);

    let offset = 0;
    const result = await this.findResumeOffset(offer);

    // Get MP4-specific metadata (if resuming)
    let mp4Metadata = null;
    if (result && result.metadata && result.metadata.metadata) {
      try {
        mp4Metadata = JSON.parse(result.metadata.metadata);
        this.logger.info(`[MP4StreamingReceiver] from datalibraryresume MP4 metadata:`, mp4Metadata);
      } catch (e) {
        this.logger.warn(`[MP4StreamingReceiver] parse MP4 metadatafailed:`, e);
      }
    }

    if (result && result.offset > 0) {
      offset = result.offset;
      const fileData = this.fileChunks.get(transferId);
      if (fileData) {
        // Restore internal state
        if (mp4Metadata) {
          fileData.moovReceived = mp4Metadata.moovReceived || false;
          fileData.moovAssembled = mp4Metadata.moovAssembled || fileData.moovReceived || false;
          fileData.ftypSize = mp4Metadata.ftypSize || 0;
          fileData.moovSize = mp4Metadata.moovSize || 0;
          if (Number.isFinite(mp4Metadata.moovRangeStart)) {
            fileData.moovRangeStart = mp4Metadata.moovRangeStart;
          }
          if (Number.isFinite(mp4Metadata.moovRangeEnd)) {
            fileData.moovRangeEnd = mp4Metadata.moovRangeEnd;
          }
          fileData.needsReassembly = mp4Metadata.needsReassembly || false;
          fileData.moovPosition = mp4Metadata.moovPosition || fileData.moovPosition;
        }

        if (
          fileData.needsReassembly &&
          !fileData.moovReceived &&
          fileData.moovSize > 0 &&
          result.offset >= (fileData.ftypSize || 0) + fileData.moovSize
        ) {
          fileData.moovReceived = true;
          fileData.moovAssembled = true;
          this.logger.info(`[MP4StreamingReceiver] according to disksizeinfer moov Restored: disksize=${result.offset}, ftypsize=${fileData.ftypSize}, moovsize=${fileData.moovSize}`);
        }

        // [CRITICAL] Correct offset sent to sender
        // If file has been reassembled (moov moved to head), disk writtenSize = received ftyp + moov + received mdat
        // But sender expects offset as progress in original file: received ftyp + received mdat
        // So offset to sender = disk size - moov size
        if (fileData.needsReassembly && fileData.moovReceived && fileData.moovSize > 0) {
          const originalOffset = offset - fileData.moovSize;
          this.logger.info(`[MP4StreamingReceiver] correctresume offset: disksize=${offset}, moovsize=${fileData.moovSize}, originaloffset=${originalOffset}`);
          offset = Math.max(0, originalOffset);
        }

        fileData.writtenSize = result.offset; // Actual size on disk
        fileData.receivedSize = offset;       // Logical receive progress
        this.stateManager.restoreResumeWrittenState(fileData, offset);

        this.logger.info(`[MP4StreamingReceiver] resume transfer: ${offer.filename}, diskbreakpoint: ${result.offset}, requestsenderposition: ${offset}`);

        // [FIX] Immediately update UI to show restored progress
        const progress = Math.min(100, Math.round((result.offset / offer.size) * 100));
        this.uiManager?.updateProgressDisplay(transferId, progress, result.offset, offer.size, 0);
        this.logger.info(`[MP4StreamingReceiver] Restoredprogressdisplay: ${progress}%, ${result.offset}/${offer.size}`);

        // Check playback state once immediately after restore
        setTimeout(() => this.checkPlayableStatus(transferId), 500);
      }
    }

    // Send accept message
    const acceptMsg = {
      type: 'file-accept',
      id: offer.id,
      offset: offset,
      supportsBinary: true,
      isMP4Stream: true
    };

    this.context.connection?.sendData(acceptMsg);

    // Start polling transfer progress
    this.startProgressPolling(transferId);
  }

  /**
   * Handle MP4 data
   */
  async handleMP4Data(data) {
    return this.dataHandler.handleMP4Data(data);
  }

  /**
   * Handle file completion message
   */
  async handleFileComplete(data) {
    const transferId = data.id;

    this.logger.info(`[MP4StreamingReceiver] receivedTransfer completedmessage: ${transferId}`);

    // Force wait for disk write queue to drain
    await this.waitForRecvQueueComplete(transferId);

    // Stop polling
    this.stopProgressPolling(transferId);

    // Process completion
    await this.handleStreamComplete(transferId);
  }

  /**
   * Handle stream completion
   */
  async handleStreamComplete(transferId) {
    const offer = this.fileOffers.get(transferId);
    if (!offer) return;

    const fileData = this.fileChunks.get(transferId);
    if (fileData?.phaseState) {
      fileData.phaseState.metadataReady = true;
      fileData.phaseState.startupReady = true;
      fileData.phaseState.mediaReady = true;
      fileData.sourceAttached = true;
    }

    this.logger.info(`[MP4StreamingReceiver] MP4 stream complete: ${offer.filename}`);
    this.videoPlayer.updateVideoPlayStatus(transferId, {
      metadataReady: true,
      startupReady: true,
      mediaReady: true,
      progress: 100,
      receivedSize: offer.size
    });
    this.uiManager?.updateProgressDisplay(transferId, 100, offer.size, offer.size, 0);

    if (this.electronAPI?.finalizeStreamFile) {
      try {
        const userId = this.context.myEmail;
        const result = await this.electronAPI.finalizeStreamFile(
          offer.filename,
          offer.id,
          offer.size,
          userId
        );

        if (result?.success) {
          if (result.storedFileName) {
            offer.storedFileName = result.storedFileName;
          }

          const saveSuccessMsg = {
            type: 'file-save-success',
            id: transferId
          };
          if (this.context.connection?.sendData) {
            this.context.connection.sendData(saveSuccessMsg);
          }

          const component = this.videoComponents.get(transferId);
          if (component?.showComplete && result.filePath) {
            component.showComplete(result.filePath);
          } else {
            await this.videoPlayer.updateVideoPlayerSource(transferId);
          }

          if (result.filePath && this.uiManager?.showFileCompleteActions) {
            this.uiManager.showFileCompleteActions(transferId, result.filePath);
          }

          markMessageAsCompleted?.(transferId, this.context);
        }
      } catch (error) {
        this.logger.error('[MP4StreamingReceiver] finalize stream file failed:', error);
      }
    }

    this.stopProgressPolling(transferId);
    this.fileChunks.delete(transferId);
  }

  /**
   * Handle connection interruption
   */
  async handleConnectionInterrupted() {
    return this.connectionHandler.handleConnectionInterrupted();
  }

  /**
   * Handle connection recovery
   */
  async handleConnectionRestored() {
    return this.connectionHandler.handleConnectionRestored();
  }

  // ==================== Internal method proxies ====================

  /**
   * Check playable status
   */
  checkPlayableStatus(transferId) {
    return this.dataHandler.checkPlayableStatus(transferId);
  }

  /**
   * Write single receive chunk
   */
  async writeOneRecvChunk(item) {
    return this.dataHandler.writeOneRecvChunk(item);
  }

  /**
   * Add chunk to write queue
   */
  enqueueWriteChunk(id, offer, fileData, chunk, writeOffset, originalOffset, totalSize, chunkMeta) {
    return this.dataHandler.enqueueWriteChunk(id, offer, fileData, chunk, writeOffset, originalOffset, totalSize, chunkMeta);
  }

  /**
   * Stop progress polling
   */
  stopProgressPolling(transferId) {
    const poller = this.progressPollers.get(transferId);
    if (poller) {
      clearInterval(poller);
      this.progressPollers.delete(transferId);
    }
  }

  /**
   * Wait for receive queue to complete
   */
  async waitForRecvQueueComplete(transferId) {
    const maxWaitTime = 30000;
    const checkInterval = 100;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      const queue = this.recvWriteQueues.get(transferId);
      const inflight = this.recvWriteInflight.get(transferId) || 0;
      if ((!queue || queue.length === 0) && inflight === 0) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    this.logger.warn(`[MP4StreamingReceiver] wait recv queue timeout: ${transferId}`);
    return false;
  }

  /**
   * Start progress polling
   */
  startProgressPolling(transferId) {
    this.stopProgressPolling(transferId);

    const pollInterval = setInterval(async () => {
      const offer = this.fileOffers.get(transferId);
      const fileData = this.fileChunks.get(transferId);

      if (!offer || !fileData) {
        this.stopProgressPolling(transferId);
        return;
      }

      if (fileData.writtenSize >= offer.size) {
        this.stopProgressPolling(transferId);
        await this.handleStreamComplete(transferId);
        return;
      }

      this.stateManager.updateTransferPhaseState(transferId);
    }, 1000);

    this.progressPollers.set(transferId, pollInterval);
  }
}

// Keep default export for backward compatibility
export default MP4StreamingReceiver;
