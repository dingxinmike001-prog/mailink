/**
 * Message formatting Worker
 * Performs complex string processing, regex replacement, and JSON parsing in Web Worker
 * Avoids blocking main thread and improves UI responsiveness
 */

const formatTimestamp = (timestamp) => {
  try {
    let msTimestamp;
    if (typeof timestamp === 'string' && timestamp.length > 15) {
      msTimestamp = Number(BigInt(timestamp) / BigInt(1000000));
    } else {
      msTimestamp = timestamp ? new Date(timestamp).getTime() : Date.now();
    }

    const date = isNaN(msTimestamp) ? new Date() : new Date(msTimestamp);
    const day = date.getDate().toString().padStart(2, '0');
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    return `${day}d ${hours}:${minutes}:${seconds}`;
  } catch (e) {
    console.error('[MessageFormatterWorker] Format time failed:', e);
    return new Date().toLocaleString();
  }
};

const replaceLocalUrls = (msg, httpPort, isSender) => {
  if (!msg.includes('http://127.0.0.1:')) {
    return msg;
  }

  let result = msg.replace(/http:\/\/127\.0\.0\.1:\d+\//g, `http://127.0.0.1:${httpPort}/`);

  if (!isSender && result.includes('/sends/')) {
    result = result.replace(/\/sends\//g, '/recvs/');
  }
  if (isSender && result.includes('/recvs/')) {
    result = result.replace(/\/recvs\//g, '/sends/');
  }

  return result;
};

const removeFilePathForReceiver = (msg, isSender) => {
  if (isSender) {
    return msg;
  }
  return msg.replace(/<div class="file-path"[^>]*>[\s\S]*?<\/div>/g, '');
};

const parseOfferFromMatch = (match) => {
  let offerStr = null;
  
  const brokenMatch = match.match(/offer=["']?(\{.*?\})["']?(?:\s+[a-zA-Z0-9\-]+=|>)/);
  if (brokenMatch) {
    offerStr = brokenMatch[1];
  } else {
    const normalMatch = match.match(/offer='([^']*)'/) || match.match(/offer="([^"]*)"/);
    if (normalMatch) offerStr = normalMatch[1];
  }
  
  if (offerStr) {
    try {
      return JSON.parse(offerStr.replace(/&quot;/g, '"'));
    } catch (e) {
      console.error('[MessageFormatterWorker] Failed to parse offer JSON:', e);
      return null;
    }
  }
  
  return null;
};

const formatFileSize = (size) => {
  if (typeof size !== 'number' || !Number.isFinite(size)) {
    return '';
  }
  
  if (size < 1024) {
    return `${size} B`;
  } else if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  } else {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
};

const getFileIcon = (mimeType) => {
  if (!mimeType) return '📄';
  
  const iconMap = {
    'application/pdf': '📕',
    'application/zip': '📦',
    'application/x-zip-compressed': '📦',
    'application/msword': '📘',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '📘',
    'application/vnd.ms-excel': '📗',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '📗',
    'application/vnd.ms-powerpoint': '📙',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '📙',
    'text/plain': '📄',
    'text/html': '🌐',
    'text/css': '🎨',
    'text/javascript': '⚙️',
    'application/javascript': '⚙️',
    'application/json': '📊',
    'audio/mpeg': '🎵',
    'audio/wav': '🎵',
    'audio/ogg': '🎵',
    'video/mp4': '🎬',
    'video/webm': '🎬',
    'video/ogg': '🎬'
  };
  
  return iconMap[mimeType] || '📄';
};

const getThumbnailFileName = (originalFileName) => {
    const lastDot = originalFileName.lastIndexOf('.');
    if (lastDot === -1) return originalFileName + '_thumb.jpg';
    return originalFileName.substring(0, lastDot) + '_thumb.jpg';
};

const convertImageFileDisplay = (match, httpPort) => {
  let imgSrc = '';
  let thumbnailSrc = '';
  let imgAlt = 'image';
  let imgTitle = '';

  const offer = parseOfferFromMatch(match);
  const isSenderFlag = /is-sender/.test(match);
  
  const altMatch = match.match(/alt="([^"]*)"/);
  const titleMatch = match.match(/title="([^"]*)"/);

  imgAlt = altMatch ? altMatch[1] : 'image';
  imgTitle = titleMatch ? titleMatch[1] : '';

  if (offer) {
    const originalFileName = offer.storedFileName || offer.filename || '';
    const fileName = encodeURIComponent(originalFileName);
    const thumbFileName = encodeURIComponent(getThumbnailFileName(originalFileName));
    
    if (!altMatch) {
      imgAlt = offer.filename || 'image';
    }
    
    const folder = isSenderFlag ? 'sends' : 'recvs';
    imgSrc = `http://127.0.0.1:${httpPort}/${folder}/${fileName}`;
    thumbnailSrc = `http://127.0.0.1:${httpPort}/${folder}/${thumbFileName}`;
  }

  let safeStoredFileName = '';
  if (offer) {
    safeStoredFileName = offer.storedFileName || offer.filename || '';
  } else {
    safeStoredFileName = imgAlt;
  }
  
  const displaySrc = thumbnailSrc || imgSrc;
  const originalSrcAttr = imgSrc ? `data-original-src="${imgSrc}"` : '';
  
  return `<div class="image-message file-request transfer-completed" data-stored-filename="${encodeURIComponent(safeStoredFileName)}" data-is-sender="${isSenderFlag}" style="margin-top: 8px;">
    <img src="${displaySrc}" ${originalSrcAttr} alt="${imgAlt}" title="${imgTitle}" style="max-width: 200px; height: auto; border-radius: 4px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.1);" onclick="window.open(this.dataset.originalSrc || this.src, '_blank');" onerror="if(this.dataset.originalSrc && this.src!==this.dataset.originalSrc && !this._fb){this._fb=1;this.src=this.dataset.originalSrc;}else{this.onerror=null;this.alt='image(loadfailed)';}">
  </div>`;
};

const convertNormalFileDisplay = (match) => {
  const offer = parseOfferFromMatch(match);
  
  let fileName = 'file';
  let fileSize = '';
  let transferId = null;
  let storedFileName = '';
  let mimeType = '';
  let fileSizeBytes = null;
  
  if (offer) {
    fileName = offer.filename || 'file';
    transferId = offer.id || null;
    storedFileName = offer.storedFileName || offer.filename || '';
    mimeType = offer.mimeType || '';
    fileSizeBytes = typeof offer.size === 'number' ? offer.size : null;

    if (fileName && transferId && fileName.includes(transferId)) {
      const lastDashIndex = fileName.lastIndexOf('-');
      if (lastDashIndex > 0) {
        const originalFileName = fileName.substring(lastDashIndex + 1);
        if (originalFileName) {
          fileName = originalFileName;
        }
      }
    }

    if (offer.size) {
      fileSize = formatFileSize(offer.size);
    }
  }
  
  const isSenderFlag = /is-sender/.test(match);
  const attrParts = [];
  if (transferId) attrParts.push(`id="file-request-${transferId}"`);
  if (storedFileName) attrParts.push(`data-stored-filename="${storedFileName}"`);
  if (mimeType) attrParts.push(`data-mime-type="${mimeType}"`);
  if (Number.isFinite(fileSizeBytes)) attrParts.push(`data-file-size="${fileSizeBytes}"`);
  attrParts.push(`data-is-sender="${isSenderFlag}"`);
  const attrs = attrParts.length ? ' ' + attrParts.join(' ') : '';
  const fileIcon = getFileIcon(mimeType);
  
  return `<div class="file-request transfer-completed"${attrs}><div class="file-info"><span class="file-icon">${fileIcon}</span><div class="file-details"><div class="file-name" title="${fileName}">${fileName}</div><div class="file-meta"><span class="file-size">${fileSize}</span></div></div></div></div>`;
};

const convertVideoFileDisplay = (match, httpPort) => {
  const offer = parseOfferFromMatch(match);
  
  let fileName = 'video';
  let storedFileName = '';
  let transferId = null;
  let isSenderFlag = false;

  if (offer) {
    fileName = offer.filename || 'video';
    storedFileName = offer.storedFileName || offer.filename || '';
    transferId = offer.id || null;
  }

  isSenderFlag = /is-sender/.test(match);

  const folder = isSenderFlag ? 'sends' : 'recvs';
  const videoFileName = storedFileName || fileName;
  const encodedFileName = encodeURIComponent(videoFileName);
  const videoUrl = `http://127.0.0.1:${httpPort}/${folder}/${encodedFileName}`;

  const containerId = transferId ? `id="file-request-${transferId}"` : '';
  const storedFileAttr = storedFileName ? `data-stored-filename="${storedFileName}"` : '';
  const isSenderAttr = `data-is-sender="${isSenderFlag}"`;

  return `<div class="streaming-video-message file-request transfer-completed" ${containerId} ${storedFileAttr} ${isSenderAttr}>
    <div class="video-container" ${transferId ? `id="video-container-${transferId}"` : ''}>
      <video
        controls
        preload="metadata"
        style="max-width: 100%; width: 400px; border-radius: 8px; background: #000;"
        poster="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='225' viewBox='0 0 400 225'%3E%3Crect fill='%23333' width='400' height='225'/%3E%3Ctext fill='%23666' font-family='sans-serif' font-size='20' dy='10.5' font-weight='bold' x='50%25' y='50%25' text-anchor='middle'%3EVideo loading...%3C/text%3E%3C/svg%3E"
      >
        <source src="${videoUrl}" type="video/mp4">
        <p>Your browser does not support video playback</p>
      </video>
      <div class="video-overlay">
        <span class="stream-status playable">Can play</span>
        <span class="file-name" title="${fileName}">${fileName}</span>
      </div>
      <div class="stream-progress-container">
        <div class="stream-progress" style="width: 100%"></div>
      </div>
    </div>
  </div>`;
};

const convertAudioFileDisplay = (match, httpPort) => {
  const offer = parseOfferFromMatch(match);
  
  let fileName = 'audio';
  let storedFileName = '';
  let transferId = null;
  let isSenderFlag = false;
  let fileSize = '';
  let mimeType = 'audio/mpeg';

  if (offer) {
    fileName = offer.filename || 'audio';
    storedFileName = offer.storedFileName || offer.filename || '';
    transferId = offer.id || null;
    mimeType = offer.mimeType || 'audio/mpeg';
    if (offer.size) {
      fileSize = formatFileSize(offer.size);
    }
  }

  isSenderFlag = /is-sender/.test(match);

  const folder = isSenderFlag ? 'sends' : 'recvs';
  const audioFileName = storedFileName || fileName;
  const encodedFileName = encodeURIComponent(audioFileName);
  const audioUrl = `http://127.0.0.1:${httpPort}/${folder}/${encodedFileName}`;

  let audioMimeType = mimeType;
  if (fileName.toLowerCase().endsWith('.mp3') && !mimeType) {
    audioMimeType = 'audio/mpeg';
  } else if (fileName.toLowerCase().endsWith('.ogg') && !mimeType) {
    audioMimeType = 'audio/ogg';
  }

  const containerId = transferId ? `id="file-request-${transferId}"` : '';
  const storedFileAttr = storedFileName ? `data-stored-filename="${storedFileName}"` : '';
  const isSenderAttr = `data-is-sender="${isSenderFlag}"`;

  return `<div class="audio-message file-request transfer-completed" ${containerId} ${storedFileAttr} ${isSenderAttr}>
    <div class="audio-container">
      <div class="audio-info">
        <span class="file-icon">🎵</span>
        <div class="file-details">
          <div class="file-name" title="${fileName}">${fileName}</div>
          <div class="file-meta">
            <span class="file-size">${fileSize}</span>
            <span class="file-status">Receive completed</span>
          </div>
        </div>
      </div>
      <div class="audio-player-container">
        <audio
          controls
          preload="metadata"
          style="width: 100%; height: 40px; border-radius: 20px;"
        >
          <source src="${audioUrl}" type="${audioMimeType}">
          <p>Your browser does not support audio playback</p>
        </audio>
      </div>
    </div>
  </div>`;
};

const formatMessage = (msg, httpPort, isSender) => {
  let formattedMsg = msg;
  
  formattedMsg = replaceLocalUrls(formattedMsg, httpPort, isSender);
  formattedMsg = removeFilePathForReceiver(formattedMsg, isSender);
  
  formattedMsg = formattedMsg.replace(/<image-file-display[^>]*>.*?<\/image-file-display>/gs, (match) => {
    return convertImageFileDisplay(match, httpPort);
  });

  formattedMsg = formattedMsg.replace(/<normal-file-display[^>]*>.*?<\/normal-file-display>/gs, (match) => {
    return convertNormalFileDisplay(match);
  });

  formattedMsg = formattedMsg.replace(/<video-file-display[^>]*>.*?<\/video-file-display>/gs, (match) => {
    return convertVideoFileDisplay(match, httpPort);
  });

  formattedMsg = formattedMsg.replace(/<audio-file-display[^>]*>.*?<\/audio-file-display>/gs, (match) => {
    return convertAudioFileDisplay(match, httpPort);
  });
  
  const hasFileOrImage = formattedMsg.includes('file-request') || 
                         formattedMsg.includes('image-message') || 
                         formattedMsg.includes('streaming-video-message') || 
                         formattedMsg.includes('audio-message');
  
  return {
    formattedMsg,
    hasFileOrImage
  };
};

self.onmessage = (event) => {
  console.log('[MessageFormatterWorker] Received message:', event.data);
  const { id, message, timestamp, sender, httpPort, isSender } = event.data;
  
  try {
    console.log('[MessageFormatterWorker] Formatting message, id:', id);
    const formattedTime = formatTimestamp(timestamp);
    const { formattedMsg, hasFileOrImage } = formatMessage(message, httpPort, isSender);
    
    console.log('[MessageFormatterWorker] Message formatted successfully, id:', id, 'hasFileOrImage:', hasFileOrImage);
    self.postMessage({
      id,
      formattedMsg,
      formattedTime,
      hasFileOrImage
    });
  } catch (error) {
    console.error('[MessageFormatterWorker] Error formatting message:', error);
    self.postMessage({
      id,
      formattedMsg: message,
      formattedTime: new Date().toLocaleString(),
      hasFileOrImage: false,
      error: error.message
    });
  }
};
