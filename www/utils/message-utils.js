/**
 * Message utility functions module
 * Provides common functions for message query and status management
 */

/**
 * Get the current user's email address
 * @returns {string} current user email
 */
function getCurrentMyEmail() {
    return window.selectedConfig?.username || '';
}

/**
 * Send a log to the parent window
 * @param {string} message - log message
 * @param {string} level - log level (info|warn|error|success)
 */
function sendLogToParent(message, level = 'info') {
    if (window.parent && window.parent.postMessage) {
        window.parent.postMessage({
            type: 'log',
            message,
            level
        }, '*');
    }
}

/**
 * Get unsent messages for the specified contact
 * @param {string} toEmail - recipient email
 * @param {Object} options - config options
 * @param {number} options.maxRetries - maximum retries, default 2
 * @param {number} options.retryDelay - retry delay in ms, default 1000
 * @param {boolean} options.includeImages - whether to include image messages, default true
 * @param {Function} options.logger - custom logger function
 * @returns {Promise<Array>} unsent message array
 */
export async function getUnsentMessagesForEmail(toEmail, options = {}) {
    const {
        maxRetries = 2,
        retryDelay = 1000,
        includeImages = true,
        logger = sendLogToParent
    } = options;

    const myEmail = getCurrentMyEmail();

    if (!myEmail || !toEmail) {
        logger('failed to get unsent messages: Missing email address', 'error');
        return [];
    }

    if (!window.parent?.electronAPI?.getUnsentMessages) {
        logger('getUnsentMessages API unavailable', 'warn');
        return [];
    }

    const params = { fromer: myEmail, toer: toEmail };

    /**
     * Fetch unsent messages with retries
     * @param {number} attempt - current attempt count
     * @returns {Promise<Array>} message array
     */
    const getUnsentMessagesWithRetry = async (attempt = 1) => {
        try {
            const messages = await window.parent.electronAPI.getUnsentMessages(params);
            logger(`found ${messages.length} unsent messages for ${toEmail} (attempt ${attempt})`, 'info');
            return messages;
        } catch (err) {
            if (attempt < maxRetries) {
                logger(`failed to get unsent messages，Retrying (${attempt}/${maxRetries})...`, 'warn');
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                return getUnsentMessagesWithRetry(attempt + 1);
            } else {
                logger(`failed to get unsent messages，maximum retry count reached`, 'error');
                throw err;
            }
        }
    };

    try {
        const messages = await getUnsentMessagesWithRetry();

        // Filter and format messages
        return messages
            .filter(msg => msg.status < 100)
            .map(msg => ({
                id: msg.id,
                msgid: msg.msgid || msg.id,
                content: msg.content,
                type: msg.type,
                timestamp: msg.timestamp || msg.createtime,
                status: msg.status
            }));
    } catch (err) {
        logger(`failed to get unsent messages: ${err.message}`, 'error');
        return [];
    }
}

/**
 * Get the last unsent plain-text message
 * @param {string} toEmail - recipient email
 * @param {Object} options - config options
 * @returns {Promise<Object|null>} last text message or null
 */
export async function getLastUnsentTextMessage(toEmail, options = {}) {
    const messages = await getUnsentMessagesForEmail(toEmail, options);

    if (!messages || messages.length === 0) {
        return null;
    }

    // Filter out plain-text messages (exclude image and file messages)
    const textMessages = messages.filter(msg => {
        const content = msg.content || '';
        // Exclude image messages: check if contains img tag, data-image, or file-related elements
        if (content.includes('<img') ||
            content.includes('data-image-') ||
            content.includes('file-request-') ||
            content.includes('data-copied-path')) {
            return false;
        }
        return true;
    });

    // Sort by id and take the last one
    if (textMessages.length > 0) {
        textMessages.sort((a, b) => (b.id || 0) - (a.id || 0));
        const lastMsg = textMessages[0];
        return {
            id: lastMsg.msgid || lastMsg.id,
            content: lastMsg.content,
            timestamp: lastMsg.timestamp
        };
    }

    return null;
}

/**
 * Get unsent image messages
 * @param {string} toEmail - recipient email
 * @param {Object} options - config options
 * @returns {Promise<Array>} image message array
 */
export async function getUnsentImageMessages(toEmail, options = {}) {
    const messages = await getUnsentMessagesForEmail(toEmail, options);

    return messages.filter(msg => {
        const content = msg.content || '';
        return content.includes('<img') ||
               content.includes('data-image-') ||
               content.includes('image-message');
    });
}

/**
 * Update message status
 * @param {string} msgId - message ID
 * @param {number} status - new status (0=unsent, 50=sending, 100=delivered)
 * @param {Object} options - config options
 * @param {string} options.fromer - sender email
 * @param {boolean} options.retry - whether to enable retries
 * @param {number} options.maxRetries - maximum retries
 * @returns {Promise<boolean>} whether the update succeeded
 */
export async function updateMessageStatus(msgId, status, options = {}) {
    const {
        fromer = getCurrentMyEmail(),
        retry = true,
        maxRetries = 2
    } = options;

    if (!msgId || !fromer) {
        console.warn('updateMessageStatus: missing required parameter');
        return false;
    }

    if (!window.parent?.electronAPI?.updateChatMessageStatus) {
        console.warn('updateChatMessageStatus API unavailable');
        return false;
    }

    const attemptUpdate = async (attempt = 1) => {
        try {
            await window.parent.electronAPI.updateChatMessageStatus(msgId, status);
            return true;
        } catch (err) {
            if (retry && attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 500));
                return attemptUpdate(attempt + 1);
            }
            console.error(`failed to update message status (${msgId}):`, err);
            return false;
        }
    };

    return attemptUpdate();
}

/**
 * Batch update message statuses
 * @param {Array<string>} msgIds - message ID array
 * @param {number} status - new status
 * @param {Object} options - config options
 * @returns {Promise<{success: number, failed: number}>} update statistics
 */
export async function batchUpdateMessageStatus(msgIds, status, options = {}) {
    if (!msgIds || !Array.isArray(msgIds) || msgIds.length === 0) {
        return { success: 0, failed: 0 };
    }

    const results = await Promise.all(
        msgIds.map(msgId => updateMessageStatus(msgId, status, options))
    );

    const success = results.filter(r => r).length;
    return {
        success,
        failed: results.length - success
    };
}

/**
 * Extract file name from message content
 * @param {string} content - message content
 * @returns {string} file name
 */
export function extractFileNameFromContent(content) {
    if (!content) return 'unknown_file';

    try {
        // Try to extract filename from src attribute of HTML img tag
        const imgMatch = content.match(/src=['"]([^'"]+)['"]/i);
        if (imgMatch && imgMatch[1]) {
            const srcPath = imgMatch[1];

            // If it is a file:// protocol path
            if (srcPath.startsWith('file://')) {
                return srcPath.split('/').pop().split('?')[0];
            }

            // If it is a normal file path
            if (srcPath.includes('/') || srcPath.includes('\\')) {
                return srcPath.split('/').pop().split('\\').pop().split('?')[0];
            }
        }

        // Try to infer extension from data:image
        if (content.includes('data:image')) {
            const mimeMatch = content.match(/data:image\/(\w+);/i);
            if (mimeMatch && mimeMatch[1]) {
                const ext = mimeMatch[1] === 'jpeg' ? 'jpg' : mimeMatch[1];
                return `image.${ext}`;
            }
        }

        // Try to find the file name pattern
        const filePattern = content.match(/[\w-]+\.(png|jpg|jpeg|gif|bmp|webp|pdf|doc|docx)/i);
        if (filePattern) {
            return filePattern[0];
        }
    } catch (e) {
        console.warn('extractFileNameFromContent parsing failed:', e.message);
    }

    return 'unknown_file';
}

/**
 * Generate unique message ID
 * @returns {string} Message ID
 */
export function generateUniqueMessageId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 10);
    const counter = Math.floor(Math.random() * 1000000).toString(36).padStart(4, '0');
    return `msg-${timestamp}-${random}-${counter}`;
}

/**
 * Check whether a message is an image message
 * @param {Object} msg - message object
 * @returns {boolean} whether it is an image message
 */
export function isImageMessage(msg) {
    if (!msg || !msg.content) return false;
    const content = msg.content;
    return content.includes('<img') ||
           content.includes('data-image-') ||
           content.includes('image-message') ||
           content.includes('file-request-') ||
           content.includes('data-copied-path');
}

/**
 * Check whether a message is a text message
 * @param {Object} msg - message object
 * @returns {boolean} whether it is a text message
 */
export function isTextMessage(msg) {
    return !isImageMessage(msg);
}

// Provide compatibility for CommonJS environment
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        getUnsentMessagesForEmail,
        getLastUnsentTextMessage,
        getUnsentImageMessages,
        updateMessageStatus,
        batchUpdateMessageStatus,
        extractFileNameFromContent,
        generateUniqueMessageId,
        isImageMessage,
        isTextMessage
    };
}