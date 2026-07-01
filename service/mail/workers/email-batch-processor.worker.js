/**
 * Email Batch Processor Worker
 * Responsibilities: batch process email conversion in background threads
 * - Email format conversion
 * - HTML content generation
 * - Image attachment preprocessing
 * - Message deduplication check preparation
 */

const { parentPort } = require('worker_threads');

// Configuration constants
const SIGNALING_EMAIL_PREFIX = 'mailink_';
const MAILINK_PICTURE_PREFIX = 'mailink_picture:';
const MAILINK_TEXT_PREFIX = 'mailink_text:';
const MAILINK_ADDFRIEND_PREFIX = 'mailink_addfriend:[add friend]';

// Image MIME types
const IMAGE_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml'
];

/**
 * HTML escape function - prevent XSS injection attacks
 * @param {string} text - Text to escape
 * @returns {string} Escaped safe text
 */
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Extract email address (compatible with multiple formats)
 * @param {string|Array|Object} field - Email field
 * @returns {string} Extracted email address
 */
function extractEmailAddress(field) {
  if (!field) return '';

  // Process string
  if (typeof field === 'string') {
    const match = field.match(/<([^>]+)>/) || field.match(/([a-zA-Z0-9._%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    return match ? match[1].trim().toLowerCase() : field.trim().toLowerCase();
  }

  // Process object - mailparser AddressObject format
  if (typeof field === 'object' && !Array.isArray(field)) {
    if (field.value && Array.isArray(field.value) && field.value.length > 0) {
      return (field.value[0].address || '').trim().toLowerCase();
    }
    if (field.text) {
      const match = field.text.match(/<([^>]+)>/) || field.text.match(/([a-zA-Z0-9._%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      return match ? match[1].trim().toLowerCase() : field.text.trim().toLowerCase();
    }
    if (field.address) {
      return field.address.trim().toLowerCase();
    }
  }

  // Process array - multiple addresses, take the first one
  if (Array.isArray(field) && field.length > 0) {
    return extractEmailAddress(field[0]);
  }

  return '';
}

/**
 * Format byte size
 * @param {number} bytes - Number of bytes
 * @returns {string} Formatted string
 */
function formatBytes(bytes) {
  if (!bytes || bytes === 0 || !Number.isFinite(bytes)) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Generate nanosecond timestamp (based on Unix Epoch)
 * @param {Date} date - Date object
 * @returns {string} Nanosecond timestamp string
 */
function generateNanoTimestamp(date) {
  try {
    const dateMs = date ? new Date(date).getTime() : Date.now();
    const nowMs = BigInt(dateMs);
    // Use microsecond precision (process.hrtime unavailable in Worker)
    const micros = BigInt(Math.floor(performance.now() * 1000) % 1000000);
    return (nowMs * 1000000n + micros).toString();
  } catch (error) {
    const nowMs = BigInt(Date.now());
    return (nowMs * 1000000n).toString();
  }
}

/**
 * Determine whether an email is a signaling email
 * @param {Object} email - Email object
 * @returns {boolean}
 */
function isSignalingEmail(email) {
  return email.subject && email.subject.startsWith(SIGNALING_EMAIL_PREFIX);
}

/**
 * Convert email to chat message format
 * @param {Object} email - Email object
 * @param {string} username - Current user email
 * @returns {Object|null} Message object or null (if sender is invalid)
 */
function convertEmailToMessage(email, username) {
  if (!email || !email.messageId) return null;

  // Extract sender and recipient
  const fromer = extractEmailAddress(email.from);
  let toer = extractEmailAddress(email.to);

  // If recipient is empty, try extracting from cc
  if (!toer && email.cc) {
    toer = extractEmailAddress(email.cc);
  }

  // Validate required fields
  if (!fromer) {
    return null;
  }

  // Message content uses email subject with 📧 prefix to identify email messages
  const subject = email.subject || '(No subject)';

  // Detect mailink_picture and mailink_text emails
  const isMailinkPicture = subject.startsWith(MAILINK_PICTURE_PREFIX);
  const isMailinkText = subject.startsWith(MAILINK_TEXT_PREFIX);
  let content = `📧 ${subject}`;
  let type = 2; // Default email message type

  // mailink_text email: add [Click for details] after content
  if (isMailinkText) {
    content = `📧 ${subject} [Click for details]`;
  }

  if (isMailinkPicture) {
    // mailink_picture email: type=3 (image type)
    type = 3;

    // Find image attachments from attachments and generate image HTML
    const attachments = email.attachments || [];
    const imageAttachments = attachments.filter(att =>
      IMAGE_MIME_TYPES.includes(att.contentType) ||
      (att.filename && /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(att.filename))
    );

    if (imageAttachments.length > 0) {
      // Generate HTML for each image attachment
      for (const imgAtt of imageAttachments) {
        const filename = imgAtt.filename || 'image.jpg';
        const fileSize = formatBytes(imgAtt.size || 0);
        const msgId = email.messageId || `email-pic-${Date.now()}`;

        // Escape dynamic content as HTML to prevent XSS injection
        const safeFilename = escapeHtml(filename);
        const safeFileSize = escapeHtml(fileSize);
        const safeSubject = escapeHtml(subject);
        const safeMsgId = escapeHtml(msgId);
        const safeEmid = escapeHtml(email.messageId || '');
        const safeUid = escapeHtml(String(email.uid || ''));

        // New email image message HTML structure
        const imageHtml = `<div class="email-image-message" data-emid="${safeEmid}" data-email-uid="${safeUid}" data-attachment-filename="${safeFilename}" style="cursor: pointer; display: block;">
  <!-- email subject line：title contains file information -->
  <div class="email-subject-line" title="Filename: ${safeFilename} | Size: ${safeFileSize} | Transfer method: Email" style="color: #1890ff; border: 1px solid #ccc; border-radius: 4px; padding: 2px 6px; margin-bottom: 8px; display: inline-block; cursor: pointer;">📧 ${safeSubject}</div>
  <!-- image display area -->
  <div class="email-image-container" id="image-${safeMsgId}" data-email-attachment="true" style="cursor: default; display: block;">
    <img src=""
         alt="${safeFilename}"
         data-original-src=""
         data-filename="${safeFilename}"
         style="max-width: 200px; max-height: 200px; width: auto; height: auto; border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); display: block; cursor: pointer;"
         onclick="event.stopPropagation(); if(this.dataset.originalSrc || this.src) window.open(this.dataset.originalSrc || this.src, '_blank');"
         onerror="if(this.dataset.originalSrc && this.src!==this.dataset.originalSrc && !this._fb){this._fb=1;this.src=this.dataset.originalSrc;}else{this.style.display='none'; this.nextElementSibling && (this.nextElementSibling.style.display='block');}">
    <div class="image-error-message" style="font-size: 12px; color: #999; padding: 8px; display: none; border: 1px solid #ccc; border-radius: 4px;">
      Image loading... [Click email details to download image]
    </div>
  </div>
</div>`;
        content = imageHtml;
      }
    } else {
      // When no image attachments, only show subject line
      content = `<div class="email-subject-line">📧 ${subject}</div>`;
    }
  }

  // Convert creation time to nanoseconds
  let createtime;
  try {
    const emailDate = email.receivedDate || email.date || new Date();
    createtime = generateNanoTimestamp(emailDate);
  } catch (error) {
    createtime = generateNanoTimestamp();
  }

  // Determine message direction
  const isFromMe = fromer.toLowerCase() === username.toLowerCase();

  // Sync email read status (0 = unread, 1 = read)
  const isRead = email.is_read === 1 || email.is_read === true ? 1 : 0;
  const readTime = isRead === 1 ? createtime : 0;

  return {
    fromer,                    // sender email
    toer: toer || '',          // recipient email
    content,                   // 📧 email subject + imageHTML（if it ismailink_picture）
    createtime,                // receive time（nanosecond-level）
    type,                      // 2 = email message, 3 = image message（mailink_picture）
    status: 100,               // email confirmed upon arrival，do not display"(receiving...)"
    msgid: createtime,         // message unique ID (uses nanosecond timestamp, consistent with WebRTC message)
    emid: email.messageId,     // original emailMessage-ID（used to associate with original email）
    is_read: isRead,           // sync email read status（0 = unread, 1 = read）
    read_time: readTime        // Read time (0 when unread)
  };
}

/**
 * Batch preprocess emails
 * Execute time-consuming conversion operations in Worker
 * @param {Array} emails - Email array
 * @param {string} username - Current user email
 * @param {Object} options - Options
 * @returns {Object} Processing result
 */
function batchProcessEmails(emails, username, options = {}) {
  const { onlyUnread = false } = options;
  const result = {
    processed: [],
    skipped: [],
    pendingImageDownloads: [],
    errors: []
  };

  if (!Array.isArray(emails) || emails.length === 0) {
    return result;
  }

  for (const email of emails) {
    try {
      // 1. Skip signaling emails
      if (isSignalingEmail(email)) {
        result.skipped.push({
          email,
          reason: 'signaling',
          messageId: email.messageId
        });
        continue;
      }

      // 2. Process friend-request emails
      if (email.subject && email.subject.startsWith(MAILINK_ADDFRIEND_PREFIX)) {
        result.skipped.push({
          email,
          reason: 'addfriend',
          messageId: email.messageId,
          senderEmail: extractEmailAddress(email.from)
        });
        continue;
      }

      // 3. Sync email server's read status
      if (email.is_read === 1 || email.is_read === true) {
        result.skipped.push({
          email,
          reason: 'read',
          messageId: email.messageId
        });
        continue;
      }

      // 4. Only process unread emails (if onlyUnread is enabled)
      if (onlyUnread && email.is_read) {
        result.skipped.push({
          email,
          reason: 'read',
          messageId: email.messageId
        });
        continue;
      }

      // 5. Convert emails to message format
      const message = convertEmailToMessage(email, username);
      if (!message) {
        result.skipped.push({
          email,
          reason: 'conversion_failed',
          messageId: email.messageId
        });
        continue;
      }

      // 6. Collect image attachment info from mailink_picture emails
      if (message.type === 3 && email.uid) {
        const imageAttachments = (email.attachments || []).filter(att =>
          IMAGE_MIME_TYPES.includes(att.contentType) ||
          (att.filename && /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(att.filename))
        );
        if (imageAttachments.length > 0) {
          result.pendingImageDownloads.push({
            email,
            message,
            imageAttachments,
            fromer: message.fromer
          });
        }
      }

      result.processed.push({
        email,
        message,
        senderEmail: message.fromer
      });
    } catch (error) {
      result.errors.push({
        email,
        messageId: email.messageId,
        error: error.message
      });
    }
  }

  return result;
}

/**
 * Batch extract sender emails
 * @param {Array} emails - Email array
 * @returns {Array} Sender email list
 */
function extractSenderEmails(emails) {
  if (!Array.isArray(emails)) return [];

  const senders = new Set();
  for (const email of emails) {
    const sender = extractEmailAddress(email.from);
    if (sender) {
      senders.add(sender);
    }
  }
  return Array.from(senders);
}

/**
 * Generate message deduplication key
 * @param {Object} message - Message object
 * @returns {string} Deduplication key
 */
function generateDedupKey(message) {
  if (!message) return '';
  return `${message.emid || ''}_${message.fromer || ''}`;
}

// Message processing
parentPort.on('message', function(e) {
  const { type, taskId, params } = e;

  try {
    let result;

    switch (type) {
      case 'batchProcessEmails':
        result = batchProcessEmails(
          params.emails,
          params.username,
          params.options || {}
        );
        break;

      case 'convertEmailToMessage':
        result = convertEmailToMessage(
          params.email,
          params.username
        );
        break;

      case 'extractSenderEmails':
        result = extractSenderEmails(params.emails);
        break;

      case 'generateDedupKey':
        result = generateDedupKey(params.message);
        break;

      case 'isSignalingEmail':
        result = isSignalingEmail(params.email);
        break;

      default:
        throw new Error(`Unknown operation type: ${type}`);
    }

    // Return result
    parentPort.postMessage({
      type: 'result',
      taskId: taskId,
      success: true,
      result: result
    });
  } catch (error) {
    // Return error
    parentPort.postMessage({
      type: 'result',
      taskId: taskId,
      success: false,
      error: error.message
    });
  }
});

// Worker initialization log
console.log('[Email Batch Processor Worker] Initialized and ready');
