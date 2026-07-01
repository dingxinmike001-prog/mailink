/**
 * MP4 utility module
 * Provides common helper functions and utility methods
 */

export class MP4Utils {
  constructor(receiver) {
    this.receiver = receiver;
    this.logger = receiver.logger;
    this.context = receiver.context;
    this.electronAPI = receiver.electronAPI;
  }

  /**
   * Check if it is MP4 streaming
   */
  isMP4StreamOffer(offer) {
    return offer && (offer.isMP4Stream || offer.supportsStreaming);
  }

  /**
   * Build playback plan
   */
  buildPlaybackPlanFromOffer(offer) {
    const plan = offer?.mp4Structure?.playbackPlan;
    if (plan?.phases?.length) {
      return plan;
    }

    const metadataRanges = offer?.mp4Structure?.metadataRanges || [];
    const startupRange = offer?.mp4Structure?.startupRange;
    return {
      phases: [
        {
          phase: 'metadata',
          ranges: metadataRanges.map(range => ({ ...range }))
        },
        {
          phase: 'startup',
          ranges: startupRange && startupRange.end > startupRange.start
            ? [{ ...startupRange, chunkType: 'startup' }]
            : []
        },
        {
          phase: 'tail',
          ranges: []
        }
      ]
    };
  }

  /**
   * Check if it's an MDAT payload chunk type
   */
  isMdatPayloadChunkType(chunkType) {
    return chunkType === 'data' || chunkType === 'startup';
  }

  /**
   * Get HTTP port
   */
  async getHttpPort() {
    let port = 8080;
    if (this.electronAPI?.getHttpServerPort) {
      try {
        const result = await this.electronAPI.getHttpServerPort();
        if (result?.success && result.port > 0) {
          port = result.port;
        }
      } catch (e) {
        this.logger.warn(`[MP4Utils] getportfailed:`, e);
      }
    }
    return port;
  }

  /**
   * Calculate write progress
   */
  calcWriteProgress(fileData) {
    if (!fileData?.totalSize) {
      return 0;
    }
    return (fileData.writtenSize / fileData.totalSize) * 100;
  }

  /**
   * Render streaming video message (fallback)
   */
  renderStreamingVideoMessage(offer) {
    const utils = this.receiver.utils;
    const fileSize = utils?.formatBytes(offer.size) || `${offer.size} bytes`;

    return `
      <div class="streaming-video-message file-request" id="file-request-${offer.id}">
        <div class="video-container" id="video-container-${offer.id}">
          <video
            controls
            preload="metadata"
            style="max-width: 100%; width: 400px; border-radius: 8px; background: #000;"
            poster="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='225' viewBox='0 0 400 225'%3E%3Crect fill='%23333' width='400' height='225'/%3E%3Ctext fill='%23666' font-family='sans-serif' font-size='20' dy='10.5' font-weight='bold' x='50%25' y='50%25' text-anchor='middle'%3EVideo loading...%3C/text%3E%3C/svg%3E"
          >
            <p>Your browser does not support video playback</p>
          </video>
          <div class="video-overlay">
            <span class="stream-status">Waiting to receive data...</span>
            <span class="file-name" title="${offer.filename}">${offer.filename}</span>
            <span class="file-size">${fileSize}</span>
          </div>
          <div class="stream-progress-container">
            <div class="stream-progress" style="width: 0%"></div>
          </div>
        </div>
      </div>
    `;
  }
}
