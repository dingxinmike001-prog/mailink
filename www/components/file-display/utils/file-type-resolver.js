/**
 * File Type Recognition Tool
 * Identify file type based on MIME type or file extension
 */

// Image type
const IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/svg+xml'
];

// Video type
const VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/webm',
  'video/ogg'
];

// Audio type
const AUDIO_MIME_TYPES = [
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/mp3',
  'audio/mp4',
  'audio/x-m4a'
];

/**
 * Get file type category
 * @param {string} mimeType - MIME type
 * @param {string} filename - Filename (used for fallback judgment)
 * @returns {string} File type: 'image' | 'video' | 'audio' | 'normal'
 */
export function getFileType(mimeType, filename = '') {
  // Prefer to determine based on the file name extension (more reliable)
  if (filename) {
    const ext = filename.split('.').pop()?.toLowerCase();
    // Prioritize audio file extensions (to prevent M4A from being recognized as video)
    const audioExts = ['mp3', 'ogg', 'oga', 'wav', 'weba', 'm4a', 'aac', 'flac'];
    if (audioExts.includes(ext)) {
      return 'audio';
    }
    const videoExts = ['mp4', 'webm', 'ogv', 'mov', 'mkv', 'avi'];
    if (videoExts.includes(ext)) {
      return 'video';
    }
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];
    if (imageExts.includes(ext)) {
      return 'image';
    }
  }

  // Determine from MIME type
  if (IMAGE_MIME_TYPES.includes(mimeType)) {
    return 'image';
  }
  if (VIDEO_MIME_TYPES.includes(mimeType)) {
    return 'video';
  }
  if (AUDIO_MIME_TYPES.includes(mimeType)) {
    return 'audio';
  }

  return 'normal';
}

/**
 * Get the corresponding component tag name
 * @param {string} mimeType - MIME type
 * @param {string} filename - File name
 * @returns {string} Component tag name
 */
export function getComponentTagName(mimeType, filename = '') {
  const type = getFileType(mimeType, filename);
  const componentMap = {
    'image': 'image-file-display',
    'video': 'video-file-display',
    'audio': 'audio-file-display', // Reserved
    'normal': 'normal-file-display'
  };
  return componentMap[type] || 'normal-file-display';
}

/**
 * Check if it is a supported image type
 * @param {string} mimeType - MIME type
 * @returns {boolean}
 */
export function isImageFile(mimeType) {
  return IMAGE_MIME_TYPES.includes(mimeType);
}

/**
 * Check if it is a supported video type
 * @param {string} mimeType - MIME type
 * @returns {boolean}
 */
export function isVideoFile(mimeType) {
  return VIDEO_MIME_TYPES.includes(mimeType);
}

/**
 * Check if it is a type supported for streaming
 * @param {string} mimeType - MIME type
 * @returns {boolean}
 */
export function isStreamingSupported(mimeType) {
  // Currently only MP4 supports streaming
  return mimeType === 'video/mp4';
}

/**
 * Get the file icon (used for displaying regular files)
 * @param {string} mimeType - MIME type
 * @returns {string} Icon emoji
 */
export function getFileIcon(mimeType) {
  const iconMap = {
    'application/pdf': '📕',
    'application/msword': '📘',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '📘',
    'application/vnd.ms-excel': '📗',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '📗',
    'application/vnd.ms-powerpoint': '📙',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '📙',
    'text/plain': '📄',
    'text/html': '🌐',
    'text/css': '🎨',
    'text/javascript': '📜',
    'application/json': '📋',
    'application/xml': '📋',
    'application/zip': '📦',
    'application/x-rar-compressed': '📦',
    'application/x-7z-compressed': '📦',
    'application/x-tar': '📦',
    'application/gzip': '📦',
    'application/x-bzip2': '📦',
    'application/x-xz': '📦',
  };
  return iconMap[mimeType] || '📔';
}
