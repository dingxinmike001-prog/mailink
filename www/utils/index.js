// Main entry file, exports all utility functions

// General utility functions
import {
  isValidEmail,
  resolveRole,
  isPolite,
  isSender,
  isReceiver,
  sleep,
  withTimeout,
  generateMessageId,
  generateFileId,
  safeJsonParse,
  formatBytes,
  getMyEmail
} from './common.js';

// Formatting related
import { formatDate, formatTime, formatTimeFull } from './format.js';

// Avatar generation related
import { generateAvatar, generateAvatarLocal } from './avatar.js';

// WebRTC related
import {
  getOptimalIceCandidatePoolSize,
  getIceCandidatePriority,
  deduplicateIceCandidates,
  filterHighPriorityIceCandidates,
  addIceCandidates
} from './webrtc.js';

// DOM manipulation related
import { sanitizeHtml, textToHtml } from './dom.js';

// Retry mechanism related
import { withRetry, sendMessageToWebcomWithRetry, ensureSendEmailAvailable } from './retry.js';

// State management related
import {
  updateMessageStatus,
  markMessageAsCompleted,
  markMessageAsSending,
  markMessageAsFailed
} from './status.js';

// Math utilities - imported from shared/utils
import { getColorFromHash } from '../../shared/utils/math.js';

// Color utilities - imported from shared/utils
import { getRandomColor } from '../../shared/utils/color.js';

// Image tool related
import {
  svgToPngDataUrl,
  isSvgString,
  svgToDataUrl,
  getFileExtensionFromMimeType,
  getMimeTypeFromDataUrl,
  getBase64FromDataUrl,
  getBase64Size,
  preloadImage,
  createThumbnail
} from './image-utils.js';

// Message tool related
import {
  getUnsentMessagesForEmail,
  getLastUnsentTextMessage,
  getUnsentImageMessages,
  updateMessageStatus as updateMsgStatus,
  batchUpdateMessageStatus,
  extractFileNameFromContent,
  generateUniqueMessageId,
  isImageMessage,
  isTextMessage
} from './message-utils.js';

import { getUtilsRoot } from './root.js';

async function deleteEmailWithRetry(...args) {
    const root = getUtilsRoot();
    const api = root?.retry;
    const impl = api?.deleteEmailWithRetry;
    if (typeof impl === 'function') return impl.apply(api, args);
    throw new Error('deleteEmailWithRetryunavailable');
}

// Export all utility functions
export {
  // General utility functions
  isValidEmail,
  resolveRole,
  isPolite,
  isSender,
  isReceiver,
  sleep,
  withTimeout,
  generateMessageId,
  generateFileId,
  safeJsonParse,
  formatBytes,
  getMyEmail,

  // Formatting related
  formatDate,
  formatTime,
  formatTimeFull,

  // Avatar generation related
  generateAvatar,
  generateAvatarLocal,

  // WebRTC related
  getOptimalIceCandidatePoolSize,
  getIceCandidatePriority,
  deduplicateIceCandidates,
  filterHighPriorityIceCandidates,
  addIceCandidates,

  // DOM manipulation related
  sanitizeHtml,
  textToHtml,

  // Retry mechanism related
  withRetry,
  sendMessageToWebcomWithRetry,
  ensureSendEmailAvailable,
  deleteEmailWithRetry,

  // State management related
  updateMessageStatus,
  markMessageAsCompleted,
  markMessageAsSending,
  markMessageAsFailed,

  // Math utilities
  getColorFromHash,

  // Color utilities
  getRandomColor,

  // Image tool related
  svgToPngDataUrl,
  isSvgString,
  svgToDataUrl,
  getFileExtensionFromMimeType,
  getMimeTypeFromDataUrl,
  getBase64FromDataUrl,
  getBase64Size,
  preloadImage,
  createThumbnail,

  // Message tool related
  getUnsentMessagesForEmail,
  getLastUnsentTextMessage,
  getUnsentImageMessages,
  batchUpdateMessageStatus,
  extractFileNameFromContent,
  generateUniqueMessageId,
  isImageMessage,
  isTextMessage
};

// Provide CommonJS compatibility
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        ...exports
    };
}
