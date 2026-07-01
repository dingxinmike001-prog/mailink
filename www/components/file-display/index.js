/**
 * Unified entry point for the file display component library
 *
 * Usage example:
 * import { createFileDisplayComponent, registerAllComponents } from './components/file-display/index.js';
 *
 * // Register all components (only need to call once)
 * registerAllComponents();
 *
 * // Create a file display component
 * const component = createFileDisplayComponent(offer, isSender, context, filePath);
 * container.appendChild(component);
 */

// Export base class
export { FileDisplayBase } from './base/file-display-base.js';

// Export specific components
export { NormalFileDisplay } from './components/normal-file-display/normal-file-display.js';
export { ImageFileDisplay } from './components/image-file-display/image-file-display.js';
export { VideoFileDisplay } from './components/video-file-display/video-file-display.js';
export { AudioFileDisplay } from './components/audio-file-display/audio-file-display.js';
export { EmailAttachmentDisplay } from './components/email-attachment-display/email-attachment-display.js';

// Export utility functions
export {
  getFileType,
  getComponentTagName,
  isImageFile,
  isVideoFile,
  isStreamingSupported,
  getFileIcon
} from './utils/file-type-resolver.js';

/**
 * Automatically register all components
 * Only need to call once when the application starts
 */
export async function registerAllComponents() {
  // Use dynamic import to ensure the component code is loaded and executed
  await import('./components/normal-file-display/normal-file-display.js');
  await import('./components/image-file-display/image-file-display.js');
  await import('./components/video-file-display/video-file-display.js');
  await import('./components/audio-file-display/audio-file-display.js');
  await import('./components/email-attachment-display/email-attachment-display.js');
}

/**
 * Factory function to create a file display component
 * Automatically selects the corresponding component based on MIME type
 *
 * @param {Object} offer - File offer object, containing properties like id, filename, size, mimeType, etc.
 * @param {boolean} isSender - Whether it is the sender
 * @param {Object} context - Context object (including logger, utils, myEmail, targetEmail, etc.)
 * @param {string} filePath - File path (optional)
 * @returns {Promise<HTMLElement>} File display component instance
 *
 * @example
 * const offer = {
 *   id: '123',
 *   filename: 'photo.jpg',
 *   size: 2048000,
 *   mimeType: 'image/jpeg',
 *   storedFileName: 'photo.jpg'
 * };
 * const component = await createFileDisplayComponent(offer, true, context, '/path/to/file');
 */
export async function createFileDisplayComponent(offer, isSender, context, filePath = null) {
  const { getComponentTagName } = await import('./utils/file-type-resolver.js');
  const tagName = getComponentTagName(offer.mimeType, offer.filename);

  const element = document.createElement(tagName);
  element.setAttribute('offer', JSON.stringify(offer));
  element.setAttribute('is-sender', String(isSender));
  if (filePath) {
    element.setAttribute('file-path', filePath);
  }

  if (context) {
    element.setContext(context);
  }

  return element;
}

/**
 * Quickly create an image display component
 * @param {Object} offer - File offer object
 * @param {boolean} isSender - Whether it is the sender
 * @param {Object} context - Context object
 * @param {string} filePath - File path (optional)
 * @returns {Promise<ImageFileDisplay>} Image display component instance
 */
export async function createImageComponent(offer, isSender, context, filePath = null) {
  const { ImageFileDisplay } = await import('./components/image-file-display/image-file-display.js');
  const element = document.createElement('image-file-display');
  element.setAttribute('offer', JSON.stringify(offer));
  element.setAttribute('is-sender', String(isSender));
  if (filePath) {
    element.setAttribute('file-path', filePath);
  }
  if (context) {
    element.setContext(context);
  }
  return element;
}

/**
 * Quickly create a video display component
 * @param {Object} offer - File offer object
 * @param {boolean} isSender - Whether it is the sender
 * @param {Object} context - Context object
 * @param {string} filePath - File path (optional)
 * @returns {Promise<VideoFileDisplay>} Video display component instance
 */
export async function createVideoComponent(offer, isSender, context, filePath = null) {
  const { VideoFileDisplay } = await import('./components/video-file-display/video-file-display.js');
  const element = document.createElement('video-file-display');
  element.setAttribute('offer', JSON.stringify(offer));
  element.setAttribute('is-sender', String(isSender));
  if (filePath) {
    element.setAttribute('file-path', filePath);
  }
  if (context) {
    element.setContext(context);
  }
  return element;
}

/**
 * Quickly create a normal file display component
 * @param {Object} offer - File offer object
 * @param {boolean} isSender - Whether it is the sender
 * @param {Object} context - Context object
 * @param {string} filePath - File path (optional)
 * @returns {Promise<NormalFileDisplay>} Instance of normal file display component
 */
export async function createNormalFileComponent(offer, isSender, context, filePath = null) {
  const { NormalFileDisplay } = await import('./components/normal-file-display/normal-file-display.js');
  const element = document.createElement('normal-file-display');
  element.setAttribute('offer', JSON.stringify(offer));
  element.setAttribute('is-sender', String(isSender));
  if (filePath) {
    element.setAttribute('file-path', filePath);
  }
  if (context) {
    element.setContext(context);
  }
  return element;
}

/**
 * Quickly create an audio display component
 * @param {Object} offer - File offer object
 * @param {boolean} isSender - Whether it is the sender
 * @param {Object} context - Context object
 * @param {string} filePath - File path (optional)
 * @returns {Promise<AudioFileDisplay>} Audio display component instance
 */
export async function createAudioComponent(offer, isSender, context, filePath = null) {
  const { AudioFileDisplay } = await import('./components/audio-file-display/audio-file-display.js');
  const element = document.createElement('audio-file-display');
  element.setAttribute('offer', JSON.stringify(offer));
  element.setAttribute('is-sender', String(isSender));
  if (filePath) {
    element.setAttribute('file-path', filePath);
  }
  if (context) {
    element.setContext(context);
  }
  return element;
}

/**
 * Create an email attachment display component
 * Used to display metadata information of email attachments (without relying on the actual file)
 *
 * @param {Object} attachment - Attachment object, containing properties like filename, contentType, size, etc.
 * @returns {Promise<EmailAttachmentDisplay>} Email attachment display component instance
 *
 * @example
 * const attachment = {
 *   filename: 'document.pdf',
 *   contentType: 'application/pdf',
 *   size: 1024000
 * };
 * const component = await createEmailAttachmentComponent(attachment);
 * container.appendChild(component);
 */
export async function createEmailAttachmentComponent(attachment) {
  await import('./components/email-attachment-display/email-attachment-display.js?v=3');
  const element = document.createElement('email-attachment-display');
  element.setAttribute('attachment', JSON.stringify(attachment));
  return element;
}
