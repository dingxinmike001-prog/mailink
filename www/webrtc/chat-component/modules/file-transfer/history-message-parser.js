/**
 * History message parser
 * Parse file metadata from historical message HTML content to recreate Web Components
 */

export class HistoryMessageParser {
  /**
   * Parse message content and determine if it's a file message
   * @param {string} content - Message HTML content
   * @returns {boolean}
   */
  static isFileMessage(content) {
    if (!content) return false;
    return content.includes('file-request') || 
           content.includes('image-file-display') ||
           content.includes('video-file-display') ||
           content.includes('audio-file-display') ||
           content.includes('normal-file-display');
  }

  /**
   * Parse image message
   * @param {string} content - Message HTML content
   * @returns {Object|null} - Parse result { type: 'image', offer: {...}, filePath: string }
   */
  static parseImageMessage(content) {
    const componentMatch = content.match(/<image-file-display[^>]*offer=["']([^"']+)["'][^>]*>/);
    if (componentMatch) {
      try {
        const offer = JSON.parse(componentMatch[1].replace(/&quot;/g, '"'));
        const filePathMatch = content.match(/file-path=["']([^"']+)["']/);
        return {
          type: 'image',
          offer,
          filePath: filePathMatch ? filePathMatch[1] : null
        };
      } catch (e) {
        console.error('[HistoryParser] parse image-file-display failed:', e);
      }
    }

    return null;
  }

  /**
   * Parse audio message
   * @param {string} content - Message HTML content
   * @returns {Object|null} - Parse result { type: 'audio', offer: {...}, filePath: string }
   */
  static parseAudioMessage(content) {
    const componentMatch = content.match(/<audio-file-display[^>]*offer=["']([^"']+)["'][^>]*>/);
    if (componentMatch) {
      try {
        const offer = JSON.parse(componentMatch[1].replace(/&quot;/g, '"'));
        const filePathMatch = content.match(/file-path=["']([^"']+)["']/);
        return {
          type: 'audio',
          offer,
          filePath: filePathMatch ? filePathMatch[1] : null
        };
      } catch (e) {
        console.error('[HistoryParser] parse audio-file-display failed:', e);
      }
    }

    return null;
  }

  /**
   * Parse video message
   * @param {string} content - Message HTML content
   * @returns {Object|null} - Parse result { type: 'video', offer: {...}, filePath: string, posterUrl: string }
   */
  static parseVideoMessage(content) {
    const componentMatch = content.match(/<video-file-display[^>]*offer=["']([^"']+)["'][^>]*>/);
    if (componentMatch) {
      try {
        const offer = JSON.parse(componentMatch[1].replace(/&quot;/g, '"'));
        const filePathMatch = content.match(/file-path=["']([^"']+)["']/);

        let posterUrl = null;
        const posterAttrMatch = content.match(/poster=["']([^"']+)["']/);
        if (posterAttrMatch) {
          posterUrl = posterAttrMatch[1];
        }

        const posterFileName = offer.posterFileName || null;

        console.info(`[HistoryParser] parse video-file-display: transferId=${offer.id}, posterFileName=${posterFileName}, posterUrl=${posterUrl}`);
        console.info(`[HistoryParser] complete offer:`, JSON.stringify(offer));

        return {
          type: 'video',
          offer,
          filePath: filePathMatch ? filePathMatch[1] : null,
          posterUrl,
          posterFileName
        };
      } catch (e) {
        console.error('[HistoryParser] parse video-file-display failed:', e);
      }
    }

    return null;
  }

  /**
   * Parse regular file message
   * @param {string} content - Message HTML content
   * @returns {Object|null} - Parse result { type: 'file', offer: {...}, filePath: string }
   */
  static parseNormalFileMessage(content) {
    const componentMatch = content.match(/<normal-file-display[^>]*offer=["']([^"']+)["'][^>]*>/);
    if (componentMatch) {
      try {
        const offer = JSON.parse(componentMatch[1].replace(/&quot;/g, '"'));
        const filePathMatch = content.match(/file-path=["']([^"']+)["']/);
        return {
          type: 'file',
          offer,
          filePath: filePathMatch ? filePathMatch[1] : null
        };
      } catch (e) {
        console.error('[HistoryParser] parse normal-file-display failed:', e);
      }
    }

    return null;
  }

  /**
   * Unified parse entry, auto-detects message type
   * @param {string} content - Message HTML content
   * @returns {Object|null} - Parse result
   */
  static parse(content) {
    if (!content) return null;

    const imageResult = this.parseImageMessage(content);
    if (imageResult) {
      console.info('[HistoryParser] parseresult: image message');
      return imageResult;
    }

    const videoResult = this.parseVideoMessage(content);
    if (videoResult) {
      console.info('[HistoryParser] parseresult: video message, posterFileName=', videoResult.posterFileName, 'posterUrl=', videoResult.posterUrl);
      return videoResult;
    }

    const audioResult = this.parseAudioMessage(content);
    if (audioResult) {
      console.info('[HistoryParser] parseresult: audiomessage');
      return audioResult;
    }

    const fileResult = this.parseNormalFileMessage(content);
    if (fileResult) {
      console.info('[HistoryParser] parseresult: normalfilemessage');
      return fileResult;
    }

    return null;
  }
}
