/**
 * MP4 streaming sender.
 * Uses a unified startup-first plan: metadata -> startup -> tail.
 */

import { BaseTransferSender } from './file-transfer/base-transfer-sender.js';
import { MP4BoxParser } from './mp4-streaming-sender/mp4-box-parser.js';
import { MP4StructureAnalyzer } from './mp4-streaming-sender/mp4-structure-analyzer.js';
import { PlaybackPlanBuilder } from './mp4-streaming-sender/playback-plan-builder.js';
import { TransferProgressTracker } from './mp4-streaming-sender/transfer-progress-tracker.js';
import { StreamingDataSender } from './mp4-streaming-sender/streaming-data-sender.js';

export class MP4StreamingSender extends BaseTransferSender {
  constructor(context, uiManager) {
    super(context, uiManager);
    
    // Configuration
    this.chunkSize = 256 * 1024;
    this.defaultStartupWindow = 12 * 1024 * 1024;
    this.startupSafetyBytes = 512 * 1024;
    this.fragmentStartupSeconds = 60;
    this.fragmentStartupMinSegments = 6;
    
    // State
    this.lastSentOffset = 0;
    this.pendingChunks = [];
    this.playbackPlan = null;
    this.isStreaming = false;
    this.startTime = 0;
    this.copiedPath = null;
    
    // Initialize sub-modules
    this.boxParser = new MP4BoxParser();
    this.structureAnalyzer = new MP4StructureAnalyzer(this.boxParser, this.logger);
    this.planBuilder = new PlaybackPlanBuilder();
    this.progressTracker = new TransferProgressTracker(this, uiManager);
    this.dataSender = new StreamingDataSender(this, this.progressTracker);
    
    this.setupConnectionRecovery();
  }

  setupConnectionRecovery() {
    document.addEventListener('connection:restored', () => {
      this.logger.info('[MP4StreamingSender] connection restored, checking stream resume');

      if (this.isStreaming && this.file && this.lastSentOffset < this.file.size) {
        this.logger.info(`[MP4StreamingSender] resuming stream: ${this.file.name}, offset=${this.lastSentOffset}`);
        this.sendFileData(this.lastSentOffset).catch(error => {
          this.logger.error('[MP4StreamingSender] resume failed:', error);
        });
      }
    });
  }

  static isMP4File(file) {
    const mimeType = file.type || '';
    const name = file.name || '';
    // Exclude pure audio files (M4A should use the audio component, not video streaming)
    const isAudioFile = mimeType.startsWith('audio/') ||
                        name.toLowerCase().endsWith('.m4a') ||
                        name.toLowerCase().endsWith('.mp3') ||
                        name.toLowerCase().endsWith('.ogg') ||
                        name.toLowerCase().endsWith('.wav') ||
                        name.toLowerCase().endsWith('.flac') ||
                        name.toLowerCase().endsWith('.aac');
    if (isAudioFile) {
      return false;
    }
    return mimeType.includes('video/mp4') ||
      mimeType.includes('audio/mp4') ||
      name.toLowerCase().endsWith('.mp4') ||
      name.toLowerCase().endsWith('.m4v') ||
      name.toLowerCase().endsWith('.mov');
  }

  async prepareStream(file, transferId) {
    this.file = file;
    this.transferId = transferId;
    this.isStreaming = false;
    this.playbackPlan = null;
    this.lastSentOffset = 0;
    this.progressTracker.reset();

    this.logger.info(`[MP4StreamingSender] prepare stream: ${file.name}, size=${file.size}`);

    let fileHash = null;
    try {
      fileHash = await this.getFileHash(file);
      this.logger.info(`[MP4StreamingSender] file hash ready: ${file.name}, hash=${fileHash}`);
    } catch (error) {
      this.logger.warn(`[MP4StreamingSender] file hash failed: ${file.name}`, error);
    }
    this.fileHash = fileHash;

    const mp4Structure = await this.structureAnalyzer.analyze(
      file, 
      this.defaultStartupWindow, 
      this.startupSafetyBytes
    );
    this.mp4Structure = mp4Structure;
    this.playbackPlan = this.planBuilder.buildPlaybackPlan(mp4Structure, file);

    if (mp4Structure.hasMoov) {
      this.logger.info(
        `[MP4StreamingSender] MP4 analyzed: moov=${mp4Structure.moovPosition}, metadataRanges=${mp4Structure.metadataRanges.length}, startup=${mp4Structure.startupRange?.start}-${mp4Structure.startupRange?.end}`
      );
    }

    return {
      success: true,
      isStreamable: true,
      info: {
        filename: file.name,
        size: file.size,
        type: file.type,
        mp4Structure
      },
      transferId: this.transferId
    };
  }

  async startStreamTransfer(offset = 0, storedFileName = null, copiedPath = null, posterFileName = null) {
    if (!this.file || !this.transferId) {
      throw new Error('stream is not prepared');
    }

    this.isStreaming = true;
    this.startTime = Date.now();
    this.copiedPath = copiedPath;

    this.logger.info(`[MP4StreamingSender] start stream: ${this.file.name}, offset=${offset}, copiedPath=${copiedPath}, poster=${posterFileName}`);

    let posterData = null;
    if (posterFileName && this.electronAPI?.readFileAsBase64) {
      try {
        const port = this.context.httpServerPort || 8080;
        const userId = this.context.myEmail || '';
        const posterUrl = `http://127.0.0.1:${port}/${userId}/files/sends/${encodeURIComponent(posterFileName)}`;
        const response = await fetch(posterUrl);
        if (response.ok) {
          const blob = await response.blob();
          posterData = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
          });
        }
      } catch (error) {
        this.logger.warn(`[MP4StreamingSender] read poster failed: ${error.message}`);
      }
    }

    const offer = {
      type: 'file-offer',
      id: this.transferId,
      filename: this.file.name,
      size: this.file.size,
      mimeType: this.file.type || 'video/mp4',
      timestamp: Date.now(),
      isMP4Stream: true,
      supportsStreaming: true,
      senderPort: this.context.httpServerPort || 8080,
      protocolVersion: 3,
      storedFileName,
      posterFileName,
      posterData,
      mp4Structure: this.mp4Structure ? {
        moovPosition: this.mp4Structure.moovPosition,
        moovOffset: this.mp4Structure.moovOffset,
        moovSize: this.mp4Structure.moovSize,
        ftypSize: this.mp4Structure.ftypSize,
        sendOrder: this.mp4Structure.sendOrder,
        streamFormat: this.mp4Structure.streamFormat,
        isFragmented: this.mp4Structure.isFragmented,
        ftypRange: this.mp4Structure.ftypRange,
        moovRange: this.mp4Structure.moovRange,
        sidxRange: this.mp4Structure.sidxRange,
        metadataRanges: this.mp4Structure.metadataRanges,
        startupRange: this.mp4Structure.startupRange,
        fragmentIndex: this.mp4Structure.fragmentIndex,
        playbackPlan: this.playbackPlan
      } : null,
      fileHash: this.fileHash
    };

    this.connection.sendData(offer);
    this.updateSenderVideoPlayer(storedFileName);
    this.progressTracker.sendProgressUpdate(true).catch(error => {
      this.logger.debug('[MP4StreamingSender] initial progress update failed:', error);
    });
    this.logger.info('[MP4StreamingSender] waiting receiver accept...');
  }

  async updateSenderVideoPlayer(storedFileName) {
    const shadowRoot = this.context.shadowRoot;
    if (!shadowRoot) {
      return;
    }

    const videoComponents = shadowRoot.querySelectorAll('video-file-display');
    let videoContainer = null;

    for (const comp of videoComponents) {
      if (comp.shadowRoot) {
        const innerContainer = comp.shadowRoot.querySelector(`#video-container-${this.transferId}`);
        if (innerContainer) {
          videoContainer = innerContainer;
          break;
        }
      }
    }

    if (!videoContainer) {
      videoContainer = shadowRoot.querySelector(`#video-container-${this.transferId}`);
    }

    if (!videoContainer) {
      return;
    }

    const videoEl = videoContainer.querySelector('video');
    if (!videoEl) {
      return;
    }

    let port = 8080;
    if (window.electronAPI?.getHttpServerPort) {
      try {
        const result = await window.electronAPI.getHttpServerPort();
        if (result?.success && result.port > 0) {
          port = result.port;
        }
      } catch (error) {
        this.logger.warn('[MP4StreamingSender] get port failed:', error);
      }
    }

    const fileName = storedFileName || this.file.name;
    const userId = this.context.myEmail || '';
    const videoUrl = `http://127.0.0.1:${port}/${userId}/files/sends/${encodeURIComponent(fileName)}`;
    const videoDisplayComp = videoContainer.closest('video-file-display');
    if (videoDisplayComp && typeof videoDisplayComp.setVideoSource === 'function') {
      videoDisplayComp.setVideoSource(videoUrl);
    } else {
      videoEl.src = videoUrl;
      videoEl.load();
    }
  }

  handleFileAccept(acceptMsg) {
    if (this.transferId !== acceptMsg.id) {
      return;
    }

    const offset = acceptMsg.offset || 0;
    this.logger.info(`[MP4StreamingSender] receiver accepted, begin send, offset=${offset}`);
    this.sendFileData(offset).catch(error => {
      this.logger.error('[MP4StreamingSender] sendFileData failed:', error);
      this.isStreaming = false;
    });
  }

  async sendFileData(startOffset = 0) {
    const file = this.file;
    const fileSize = file.size;

    if (!this.playbackPlan) {
      if (!this.mp4Structure) {
        this.mp4Structure = await this.structureAnalyzer.analyze(
          file, 
          this.defaultStartupWindow, 
          this.startupSafetyBytes
        );
      }
      this.playbackPlan = this.planBuilder.buildPlaybackPlan(this.mp4Structure, file);
    }

    await this.dataSender.sendFileData(
      startOffset,
      file,
      this.playbackPlan,
      this.mp4Structure,
      this.planBuilder,
      this.finishTransferSend.bind(this)
    );
  }

  async sendFileDataInOptimalOrder(resumeOffset = 0) {
    return this.sendFileData(resumeOffset);
  }

  async sendFileDataRange(startOffset, endOffset) {
    return this.dataSender.sendFileDataRange(startOffset, endOffset);
  }

  async finishTransferSend(file, fileSize) {
    const elapsed = Date.now() - this.startTime;
    this.progressTracker.recordSentRange(0, fileSize);
    await this.progressTracker.sendProgressUpdate(true);
    const completeMsg = {
      type: 'file-complete',
      id: this.transferId,
      filename: file.name,
      totalSize: fileSize,
      duration: elapsed,
      isMP4Stream: true
    };
    if (typeof this.connection.sendDataReliable === 'function') {
      await this.connection.sendDataReliable(completeMsg, { timeoutMs: 20000, intervalMs: 50 });
    } else {
      this.connection.sendData(completeMsg);
    }
    this.uiManager?.updateFileRequestStatus(this.transferId, 'Sent, waiting for peer confirmation...');
    this.uiManager?.updateProgressDisplay(this.transferId, 100, fileSize, fileSize, 0);

    let filePath = this.copiedPath;
    if (!filePath && file.path) {
      filePath = file.path;
    }

    if (filePath && this.uiManager) {
      this.uiManager.showFileCompleteActions(this.transferId, filePath);
    }

    const shadowRoot = this.context.shadowRoot;
    if (shadowRoot) {
      const videoComponents = shadowRoot.querySelectorAll('video-file-display');
      let videoContainer = null;
      for (const comp of videoComponents) {
        if (comp.shadowRoot) {
          const innerContainer = comp.shadowRoot.querySelector(`#video-container-${this.transferId}`);
          if (innerContainer) {
            videoContainer = innerContainer;
            break;
          }
        }
      }

      if (!videoContainer) {
        videoContainer = shadowRoot.querySelector(`#video-container-${this.transferId}`);
      }

      if (videoContainer) {
        const overlayEl = videoContainer.querySelector('.video-overlay');
        if (overlayEl) {
          overlayEl.style.display = 'none';
        }
        const statusEl = videoContainer.querySelector('.stream-status');
        if (statusEl) {
          statusEl.style.display = 'none';
        }
      }

      const msgContainer = shadowRoot.querySelector(`#msg-container-${this.transferId}`);
      if (msgContainer) {
        const msgStatus = msgContainer.querySelector('.message-status');
        if (msgStatus) {
          msgStatus.remove();
        }
      }
    }

    if (this.electronAPI?.finalizeStreamFile) {
      const userId = this.context.myEmail;
      this.electronAPI.finalizeStreamFile(file.name, this.transferId, fileSize, userId).then(result => {
        if (result?.success && result.filePath && this.uiManager) {
          this.uiManager.showFileCompleteActions(this.transferId, result.filePath);
        }
      }).catch(error => {
        this.logger.warn('[MP4StreamingSender] finalizeStreamFile failed:', error);
      });
    }

    this.isStreaming = false;
  }

  stopStream() {
    this.isStreaming = false;
    this.logger.info(`[MP4StreamingSender] stream stopped: ${this.transferId}`);
  }

  async handleFileSaveSuccess(data) {
    const id = data.id;
    this.logger.info(`[MP4StreamingSender] receiver save ack: ${id}`);
    this.uiManager?.updateFileRequestStatus(id, 'saved');
    const shadowRoot = this.context.shadowRoot;
    if (shadowRoot) {
      const videoComponents = shadowRoot.querySelectorAll('video-file-display');
      let videoContainer = null;

      for (const comp of videoComponents) {
        if (comp.shadowRoot) {
          const innerContainer = comp.shadowRoot.querySelector(`#video-container-${id}`);
          if (innerContainer) {
            videoContainer = innerContainer;
            break;
          }
        }
      }

      if (!videoContainer) {
        videoContainer = shadowRoot.querySelector(`#video-container-${id}`);
      }

      if (videoContainer) {
        const overlayEl = videoContainer.querySelector('.video-overlay');
        if (overlayEl) {
          overlayEl.style.display = 'none';
        }

        const statusEl = videoContainer.querySelector('.stream-status');
        if (statusEl) {
          statusEl.style.display = 'none';
        }
      }
    }
  }
}
