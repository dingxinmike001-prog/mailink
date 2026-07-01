/**
 * Message status management module
 * Encapsulates message status update operations
 */

import { getMyEmail } from './common.js';

/**
 * Update message status
 * @param {string|number} msgId - message ID
 * @param {number} status - status code (e.g., 100 means completed)
 * @param {Object} options - optional parameters
 * @param {string} options.fromer - sender email
 * @param {string} options.dbUser - database user
 * @param {boolean} options.retry - whether to enable retry mechanism
 * @param {number} options.maxRetries - maximum retries
 * @returns {Promise<Object>} update result
 */
export async function updateMessageStatus(msgId, status, options = {}) {
  const {
    fromer = getMyEmail(),
    dbUser = getMyEmail(),
    retry = true,
    maxRetries = 2
  } = options;

  // Check API availability
  if (!window.electronAPI?.updateMessageStatus) {
    console.warn('[Status] updateMessageStatus API unavailable');
    return { success: false, error: 'API not available' };
  }

  // Parameter validation
  if (!msgId) {
    console.warn('[Status] messageIDCannot be empty');
    return { success: false, error: 'Message ID is required' };
  }

  let lastError;
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      // First try updating by msgid
      let result = await window.electronAPI.updateMessageStatus({
        msgid: msgId,
        status,
        fromer,
        dbUser
      });

      // If it fails and msgid is a numeric string, try the id field
      if ((!result || !result.changes) && typeof msgId === 'string') {
        const numericId = Number(msgId);
        if (Number.isFinite(numericId)) {
          result = await window.electronAPI.updateMessageStatus({
            id: numericId,
            status,
            fromer,
            dbUser
          });
        }
      }

      // Check the update result
      if (result && (result.changes || result.success)) {
        return {
          success: true,
          changes: result.changes,
          attempt: attempt + 1
        };
      }

      // Return directly if it did not succeed and retry is not needed
      if (!retry || attempt >= maxRetries) {
        return {
          success: false,
          error: 'Update did not affect any rows',
          attempt: attempt + 1
        };
      }

      attempt++;
    } catch (error) {
      lastError = error;
      console.error(`[Status] Failed to update message status (attempt ${attempt + 1}/${maxRetries + 1}):`, error);

      if (!retry || attempt >= maxRetries) {
        return {
          success: false,
          error: error.message,
          attempt: attempt + 1
        };
      }

      attempt++;
      // Retry after a delay
      await new Promise(resolve => setTimeout(resolve, 500 * attempt));
    }
  }

  return {
    success: false,
    error: lastError?.message || 'Unknown error',
    attempt: attempt
  };
}

/**
 * Mark a message as completed (status 100)
 * @param {string|number} msgId - message ID
 * @param {Object} options - optional parameters
 * @returns {Promise<Object>} update result
 */
export async function markMessageAsCompleted(msgId, options = {}) {
  return updateMessageStatus(msgId, 100, options);
}

/**
 * Mark a message as sending (status 50)
 * @param {string|number} msgId - message ID
 * @param {Object} options - optional parameters
 * @returns {Promise<Object>} update result
 */
export async function markMessageAsSending(msgId, options = {}) {
  return updateMessageStatus(msgId, 50, options);
}

/**
 * Mark a message as failed (status -1)
 * @param {string|number} msgId - message ID
 * @param {Object} options - optional parameters
 * @returns {Promise<Object>} update result
 */
export async function markMessageAsFailed(msgId, options = {}) {
  return updateMessageStatus(msgId, -1, options);
}
