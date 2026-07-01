/**
 * History message parser Worker
 * Performs complex regex matching and JSON parsing in Web Worker to avoid blocking main thread
 */

const inferImageMimeType = (filename) => {
  if (!filename) return 'image/jpeg';
  const ext = filename.split('.').pop().toLowerCase();
  const mimeTypes = {
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'bmp': 'image/bmp',
    'webp': 'image/webp',
    'svg': 'image/svg+xml'
  };
  return mimeTypes[ext] || 'image/jpeg';
};

const isFileMessage = (content) => {
  if (!content) return false;
  // [FIX] Use regex to match word boundaries, avoiding email messages like email-image-message
  return content.includes('file-request') ||
         content.includes('image-file-display') ||
         content.includes('video-file-display') ||
         content.includes('audio-file-display') ||
         content.includes('normal-file-display') ||
         /\bimage-message\b/.test(content) ||
         content.includes('streaming-video-message') ||
         content.includes('audio-message');
};

const parseImageMessage = (content) => {
  const componentMatch = content.match(/<image-file-display[^>]*offer=["']([^"']+)["'][^>]*>/);
  if (componentMatch) {
    try {
      let offerStr = componentMatch[1];
      if (offerStr.startsWith('{') && !offerStr.includes('"')) {
        offerStr = offerStr.replace(/&quot;/g, '"');
      }
      if (offerStr.startsWith('{') && offerStr.endsWith('}')) {
        const offer = JSON.parse(offerStr);
        const filePathMatch = content.match(/file-path=["']([^"']+)["']/);
        return {
          type: 'image',
          offer,
          filePath: filePathMatch ? filePathMatch[1] : null
        };
      } else {
        console.warn('[HistoryParserWorker] offer formatinvalid:', offerStr.substring(0, 50));
      }
    } catch (e) {
      console.error('[HistoryParserWorker] parse image-file-display failed:', e, 'originalstring:', componentMatch[1].substring(0, 100));
    }
  }

  // [FIX] Use word boundary matching, avoiding email image messages like email-image-message
  const divMatch = content.match(/<div[^>]*class="[^"]*\bimage-message\b[^"]*"[^>]*>/);
  if (divMatch) {
    // [FIX] Extra check: ensure it's not an email image message (email-image-message)
    if (content.includes('email-image-message')) {
      console.info('[HistoryParserWorker] detectedemailimage message, skip WebRTC fileparse');
      return null;
    }

    const storedFileNameMatch = content.match(/data-stored-filename="([^"]+)"/);
    const isSenderMatch = content.match(/data-is-sender="([^"]+)"/);
    const imgMatch = content.match(/<img[^>]+src="([^"]+)"[^>]+alt="([^"]*)"/);
    const originalSrcMatch = content.match(/data-original-src="([^"]+)"/);

    if (storedFileNameMatch || imgMatch) {
      const storedFileName = storedFileNameMatch ? decodeURIComponent(storedFileNameMatch[1]) : '';
      const fileName = imgMatch ? imgMatch[2] : storedFileName;

      let transferId = '';
      const idMatch = content.match(/id="file-request-([^"]+)"/) ||
                     content.match(/id="msg-container-([^"]+)"/);
      if (idMatch) {
        transferId = idMatch[1];
      } else if (storedFileName) {
        const uuidMatch = storedFileName.match(/^([a-f0-9-]+)-/);
        if (uuidMatch) transferId = uuidMatch[1];
      }

      const imgSrc = imgMatch ? imgMatch[1] : null;
      const originalSrc = originalSrcMatch ? originalSrcMatch[1] : imgSrc;

      return {
        type: 'image',
        offer: {
          id: transferId,
          filename: fileName,
          storedFileName: storedFileName,
          mimeType: inferImageMimeType(fileName),
          size: 0
        },
        filePath: originalSrc,
        thumbnailSrc: imgSrc !== originalSrc ? imgSrc : null,
        isSender: isSenderMatch ? isSenderMatch[1] === 'true' : null
      };
    }
  }

  return null;
};

const parseAudioMessage = (content) => {
  const componentMatch = content.match(/<audio-file-display[^>]*offer=["']([^"']+)["'][^>]*>/);
  if (componentMatch) {
    try {
      let offerStr = componentMatch[1];
      if (offerStr.startsWith('{') && !offerStr.includes('"')) {
        offerStr = offerStr.replace(/&quot;/g, '"');
      }
      if (offerStr.startsWith('{') && offerStr.endsWith('}')) {
        const offer = JSON.parse(offerStr);
        const filePathMatch = content.match(/file-path=["']([^"']+)["']/);
        return {
          type: 'audio',
          offer,
          filePath: filePathMatch ? filePathMatch[1] : null
        };
      }
    } catch (e) {
      console.error('[HistoryParserWorker] parse audio-file-display failed:', e, 'originalstring:', componentMatch[1].substring(0, 100));
    }
  }

  const divMatch = content.match(/<div[^>]*class="[^"]*audio-message[^"]*"[^>]*>/);
  if (divMatch) {
    const storedFileNameMatch = content.match(/data-stored-filename="([^"]+)"/);
    const isSenderMatch = content.match(/data-is-sender="([^"]+)"/);
    const audioMatch = content.match(/<source[^>]+src="([^"]+)"/);
    const fileNameMatch = content.match(/<div[^>]*class="[^"]*file-name[^"]*"[^>]*>([^<]+)<\/div>/);
    const mimeTypeMatch = content.match(/type="(audio\/[^"]+)"/);

    if (storedFileNameMatch || audioMatch) {
      const storedFileName = storedFileNameMatch ? storedFileNameMatch[1] : '';
      const fileName = fileNameMatch ? fileNameMatch[1].trim() : (storedFileName || 'audio');

      let transferId = '';
      const idMatch = content.match(/id="file-request-([^"]+)"/);
      if (idMatch) transferId = idMatch[1];

      let mimeType = mimeTypeMatch ? mimeTypeMatch[1] : 'audio/mpeg';
      if (!mimeType && fileName.toLowerCase().endsWith('.ogg')) {
        mimeType = 'audio/ogg';
      } else if (!mimeType && fileName.toLowerCase().endsWith('.mp3')) {
        mimeType = 'audio/mpeg';
      }

      return {
        type: 'audio',
        offer: {
          id: transferId,
          filename: fileName,
          storedFileName: storedFileName,
          mimeType: mimeType,
          size: 0
        },
        filePath: audioMatch ? audioMatch[1] : null,
        isSender: isSenderMatch ? isSenderMatch[1] === 'true' : null
      };
    }
  }

  return null;
};

const parseVideoMessage = (content) => {
  const componentMatch = content.match(/<video-file-display[^>]*offer=["']([^"']+)["'][^>]*>/);
  if (componentMatch) {
    try {
      let offerStr = componentMatch[1];
      if (offerStr.startsWith('{') && !offerStr.includes('"')) {
        offerStr = offerStr.replace(/&quot;/g, '"');
      }
      if (offerStr.startsWith('{') && offerStr.endsWith('}')) {
        const offer = JSON.parse(offerStr);
        const filePathMatch = content.match(/file-path=["']([^"']+)["']/);

        let posterUrl = null;
        const posterAttrMatch = content.match(/poster=["']([^"']+)["']/);
        if (posterAttrMatch) {
          posterUrl = posterAttrMatch[1];
        }

        const posterFileName = offer.posterFileName || null;

        console.info(`[HistoryParserWorker] parse video-file-display: transferId=${offer.id}, posterFileName=${posterFileName}, posterUrl=${posterUrl}`);
        console.info(`[HistoryParserWorker] complete offer:`, JSON.stringify(offer));

        return {
          type: 'video',
          offer,
          filePath: filePathMatch ? filePathMatch[1] : null,
          posterUrl,
          posterFileName
        };
      }
    } catch (e) {
      console.error('[HistoryParserWorker] parse video-file-display failed:', e, 'originalstring:', componentMatch[1].substring(0, 100));
    }
  }

  const divMatch = content.match(/<div[^>]*class="[^"]*streaming-video-message[^"]*"[^>]*>/);
  if (divMatch) {
    const storedFileNameMatch = content.match(/data-stored-filename="([^"]+)"/);
    const isSenderMatch = content.match(/data-is-sender="([^"]+)"/);
    const videoMatch = content.match(/<source[^>]+src="([^"]+)"/);
    const fileNameMatch = content.match(/<span[^>]*class="[^"]*file-name[^"]*"[^>]*>([^<]+)<\/span>/);

    let posterUrl = null;
    const posterAttrMatch = content.match(/poster=["']([^"']+)["']/);
    if (posterAttrMatch) {
      posterUrl = posterAttrMatch[1];
    }

    if (storedFileNameMatch || videoMatch) {
      const storedFileName = storedFileNameMatch ? storedFileNameMatch[1] : '';
      const fileName = fileNameMatch ? fileNameMatch[1].trim() : (storedFileName || 'video');

      let transferId = '';
      const idMatch = content.match(/id="file-request-([^"]+)"/);
      if (idMatch) transferId = idMatch[1];

      console.info(`[HistoryParserWorker] parse streaming-video-message div: transferId=${transferId}, posterUrl=${posterUrl}`);

      return {
        type: 'video',
        offer: {
          id: transferId,
          filename: fileName,
          storedFileName: storedFileName,
          mimeType: 'video/mp4',
          size: 0
        },
        filePath: videoMatch ? videoMatch[1] : null,
        isSender: isSenderMatch ? isSenderMatch[1] === 'true' : null,
        posterUrl: posterUrl || (content.match(/<video[^>]+poster=["']([^"']+)["']/) || [])[1]
      };
    }
  }

  return null;
};

const parseNormalFileMessage = (content) => {
  const componentMatch = content.match(/<normal-file-display[^>]*offer=["']([^"']+)["'][^>]*>/);
  if (componentMatch) {
    try {
      let offerStr = componentMatch[1];
      if (offerStr.startsWith('{') && !offerStr.includes('"')) {
        offerStr = offerStr.replace(/&quot;/g, '"');
      }
      if (offerStr.startsWith('{') && offerStr.endsWith('}')) {
        const offer = JSON.parse(offerStr);
        const filePathMatch = content.match(/file-path=["']([^"']+)["']/);
        return {
          type: 'file',
          offer,
          filePath: filePathMatch ? filePathMatch[1] : null
        };
      }
    } catch (e) {
      console.error('[HistoryParserWorker] parse normal-file-display failed:', e, 'originalstring:', componentMatch[1].substring(0, 100));
    }
  }

  const divMatch = content.match(/<div[^>]*class="[^"]*file-request[^"]*"[^>]*id="file-request-([^"]+)"/);
  if (divMatch) {
    const transferId = divMatch[1];
    const storedFileNameMatch = content.match(/data-stored-filename="([^"]+)"/);
    const mimeTypeMatch = content.match(/data-mime-type="([^"]+)"/);
    const fileSizeMatch = content.match(/data-file-size="(\d+)"/);
    const isSenderMatch = content.match(/data-is-sender="([^"]+)"/);
    const fileNameMatch = content.match(/<div[^>]*class="[^"]*file-name[^"]*"[^>]*>([^<]+)<\/div>/);

    let storedFileName = storedFileNameMatch ? storedFileNameMatch[1] : '';
    const fileName = fileNameMatch ? fileNameMatch[1].trim() : storedFileName;

    if (storedFileName && !storedFileName.includes(transferId)) {
      console.warn(`[HistoryParserWorker] storedFileName  with  transferId not match: transferId=${transferId}, storedFileName=${storedFileName}, will clear storedFileName`);
      storedFileName = '';
    }

    return {
      type: 'file',
      offer: {
        id: transferId,
        filename: fileName,
        storedFileName: storedFileName,
        mimeType: mimeTypeMatch ? mimeTypeMatch[1] : 'application/octet-stream',
        size: fileSizeMatch ? parseInt(fileSizeMatch[1]) : 0
      },
      filePath: null,
      isSender: isSenderMatch ? isSenderMatch[1] === 'true' : null
    };
  }

  return null;
};

const parse = (content) => {
  if (!content) return null;

  const imageResult = parseImageMessage(content);
  if (imageResult) {
    console.info('[HistoryParserWorker] parseresult: image message');
    return imageResult;
  }

  const videoResult = parseVideoMessage(content);
  if (videoResult) {
    console.info('[HistoryParserWorker] parseresult: video message, posterFileName=', videoResult.posterFileName, 'posterUrl=', videoResult.posterUrl);
    return videoResult;
  }

  const audioResult = parseAudioMessage(content);
  if (audioResult) {
    console.info('[HistoryParserWorker] parseresult: audiomessage');
    return audioResult;
  }

  const fileResult = parseNormalFileMessage(content);
  if (fileResult) {
    console.info('[HistoryParserWorker] parseresult: normalfilemessage');
    return fileResult;
  }

  return null;
};

const parseBatch = (messages) => {
  return messages.map((msg, index) => {
    const result = parse(msg.content);
    return {
      index,
      msgId: msg.msgid || msg.id,
      parseResult: result
    };
  });
};

const sortAndParseBatch = (messages) => {
  const sortedMessages = [...messages].sort((a, b) => a.id - b.id);
  
  return {
    sortedMessages,
    parseResults: sortedMessages.map((msg, index) => {
      const result = parse(msg.content);
      return {
        index,
        msgId: msg.msgid || msg.id,
        parseResult: result
      };
    })
  };
};

self.onmessage = (event) => {
  const { type, payload, taskId } = event.data;

  switch (type) {
    case 'parse': {
      const result = parse(payload.content);
      self.postMessage({ type: 'parse:result', taskId, payload: result });
      break;
    }

    case 'parseBatch': {
      const results = parseBatch(payload.messages);
      self.postMessage({ type: 'parseBatch:result', taskId, payload: results });
      break;
    }

    case 'sortAndParseBatch': {
      const result = sortAndParseBatch(payload.messages);
      self.postMessage({ type: 'sortAndParseBatch:result', taskId, payload: result });
      break;
    }

    case 'isFileMessage': {
      const result = isFileMessage(payload.content);
      self.postMessage({ type: 'isFileMessage:result', taskId, payload: result });
      break;
    }

    default:
      console.warn('[HistoryParserWorker] not knowmessagetype:', type);
  }
};

self.postMessage({ type: 'ready' });
