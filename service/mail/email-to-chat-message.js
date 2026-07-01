/**

 * Email-to-chat message module

 * Converts any regular email (including mailink_ prefix) into a chat message and inserts it into the message table

 * Default rule: type=2, content=📧 email subject

 * Special rule: mailink_picture subject emails, type=3, content=📧 subject + image HTML

 */

const logger = require('../logger');

const path = require('path');

const pathUtils = require('../../shared/path/path-utils');

const fs = require('fs');

const { UnifiedDB } = require('../sqlite/sqlite-unified');

const { SIGNALING_EMAIL_PREFIX } = require('../../shared/config/signaling-constants');

const thumbnailGenerator = require('../images/thumbnail-generator');

const { createWorkerManager } = require('../../shared/worker/worker-factory');



// Batch email processing Worker manager (lazy-loaded)

let emailBatchProcessorWorker = null;



/**

 * Get batch email processing Worker manager

 * @returns {WorkerManager} Worker manager instance

 */

function getEmailBatchProcessorWorker() {

  if (!emailBatchProcessorWorker) {

    emailBatchProcessorWorker = createWorkerManager('emailBatchProcessor');

  }

  return emailBatchProcessorWorker;

}



// mailink_picture subject prefix

const MAILINK_PICTURE_PREFIX = 'mailink_picture:';



// mailink_text subject prefix

const MAILINK_TEXT_PREFIX = 'mailink_text:';



// mailink_addfriend subject prefix

const MAILINK_ADDFRIEND_PREFIX = 'mailink_addfriend:[add friend]';



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



// Image MIME types

const IMAGE_MIME_TYPES = [

  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml'

];



/**

 * Auto-add/update sender contact

 * - If not exists, create new contact with status=20

 * - If exists but status<0 (blacklist), update to status=20

 * @param {string} username - Current user email

 * @param {string} senderEmail - Sender email

 */

async function autoUpdateSenderContact(username, senderEmail) {

  try {

    if (!username || !senderEmail) {

      return;

    }



    // Restriction: cannot add self as contact

    if (username.trim().toLowerCase() === senderEmail.trim().toLowerCase()) {

      return;

    }



    const dbPath = pathUtils.getUserDbPath(username);



    // Check if contact already exists

    const existingContact = await UnifiedDB.withORM(dbPath, async (orm) => {

      return await orm.table('contact')

        .whereRaw('lower(username) = lower(?)', [senderEmail])

        .find();

    });



    if (existingContact) {

      // If exists but status < 0 (blacklist), update to status=20

      if (existingContact.status < 0) {

        await UnifiedDB.execute(

          dbPath,

          'UPDATE contact SET status = 20, updatetime = ? WHERE id = ?',

          [Date.now(), existingContact.id]

        );

        logger.info(`[ChatMessage] restored sender contact status from blacklist to friend: ${senderEmail}, originalstatus=${existingContact.status}, newstatus=20`);

      }

      return;

    }



    // Extract display name

    const nickname = senderEmail.includes('@') 

      ? senderEmail.split('@')[0] 

      : senderEmail;



    // Insert new contact (status=20 means friend)

    await UnifiedDB.withORM(dbPath, async (orm) => {

      return await orm.table('contact').insert({

        nickname: nickname,

        rmkname: nickname,

        username: senderEmail,

        avatar: '',

        status: 20,

        updatetime: Date.now()

      });

    });



    logger.info(`[ChatMessage] automatically added sender as friend: ${senderEmail}, status=20`);

  } catch (error) {

    logger.error(`[ChatMessage] failed to update sender contact: ${error.message}`);

    // do not throw error，to avoid affecting email processing flow

  }

}



/**

 * Process add-friend email

 * Automatically add sender as contact

 * @param {string} username - Current user email

 * @param {Object} email - Email object

 * @returns {Promise<boolean>} Whether processing succeeded

 */

async function handleAddFriendEmail(username, email) {

  try {

    const senderEmail = extractEmailAddress(email.from);

    if (!senderEmail) {

      logger.warn('[handleAddFriendEmail] could not extract sender email');

      return false;

    }



    // Cannot add self

    if (username.trim().toLowerCase() === senderEmail.trim().toLowerCase()) {

      logger.info('[handleAddFriendEmail] skipped adding self as friend');

      return false;

    }



    logger.info(`[handleAddFriendEmail] received add-friend email, sender: ${senderEmail}`);



    // Check if contact already exists

    const dbPath = pathUtils.getUserDbPath(username);

    const existingContact = await UnifiedDB.withORM(dbPath, async (orm) => {

      return await orm.table('contact')

        .whereRaw('lower(username) = lower(?)', [senderEmail])

        .find();

    });



    if (existingContact) {

      logger.info(`[handleAddFriendEmail] contact already exists: ${senderEmail}`);

      return true;

    }



    // Use email prefix as nickname

    const nickname = senderEmail.split('@')[0];



    // Insert new contact

    await UnifiedDB.withORM(dbPath, async (orm) => {

      return await orm.table('contact').insert({

        nickname: nickname,

        rmkname: nickname,

        username: senderEmail,

        avatar: '',

        status: 20,

        updatetime: Date.now()

      });

    });



    logger.info(`[handleAddFriendEmail] automatically added friend: ${senderEmail}, nickname=${nickname}`);



    // Notify renderer of new contact

    if (global.mainWindow && global.mainWindow.webContents) {

      global.mainWindow.webContents.send('contact-added-from-email', {

        username: username,

        contactEmail: senderEmail,

        nickname: nickname

      });

    }



    return true;

  } catch (error) {

    logger.error(`[handleAddFriendEmail] failed to process add-friend email: ${error.message}`);

    return false;

  }

}



/**

 * Verify whether the contact is valid (exists and status >= 0)

 * @param {string} username - Current user email

 * @param {string} contactEmail - Contact email

 * @returns {Promise<boolean>} Whether it is a valid contact

 */

async function isValidContact(username, contactEmail) {

  if (!contactEmail) return false;



  try {

    const dbPath = pathUtils.getUserDbPath(username);

    const contact = await UnifiedDB.withORM(dbPath, async (orm) => {

      return await orm.table('contact')

        .whereRaw('lower(username) = lower(?)', [contactEmail.trim()])

        .find();

    });



    // Contact exists and status >= 0 (not blacklisted -100)

    return contact && contact.status >= 0;

  } catch (error) {

    logger.error(`[isValidContact] Error checking contact: ${error.message}`, {

      username,

      contactEmail

    });

    return false;

  }

}



/**

 * Extract email address (supports multiple formats)

 * Supported formats: "Name <email@example.com>", "email@example.com",

 *           mailparser AddressObject {value:[{address:...}]}, {text:...}, {address:...}

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

 * Generate nanosecond timestamp (based on Unix Epoch)

 * @returns {string} Nanosecond timestamp string

 */

function generateNanoTimestamp() {

  const nowMs = BigInt(Date.now());

  const hrTime = process.hrtime.bigint();

  return (nowMs * 1000000n + (hrTime % 1000000n)).toString();

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

 * Default rule: type=2, content=📧 email subject

 * Special rule: mailink_picture subject emails, type=3, content=📧 subject + image HTML placeholder

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

    logger.warn('[convertEmailToMessage] No valid sender found in email');

    return null;

  }



  // Message content uses email subject with 📧 prefix to identify email messages

  const subject = email.subject || '(no subject)';



  // Detect mailink_picture and mailink_text emails

  const isMailinkPicture = subject.startsWith(MAILINK_PICTURE_PREFIX);

  const isMailinkText = subject.startsWith(MAILINK_TEXT_PREFIX);

  let content = `📧 ${subject}`;

  let type = 2; // Default email message type



  // mailink_text email: add [Click for details] after content

  if (isMailinkText) {

    content = `📧 ${subject}[click to view details]`;
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

      // Use new email image message structure: outer container wraps subject line, file info line, and image

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

        // Outer email-image-message container is clickable to open email details

        // Move file info to title attribute, shown on mouse hover

        // [FIX] Use email-image-container instead of image-message to avoid confusion with WebRTC file transfer image-message class

        // [FIX] Display subject line and images in two rows

        const imageHtml = `<div class="email-image-message" data-emid="${safeEmid}" data-email-uid="${safeUid}" data-attachment-filename="${safeFilename}" style="cursor: pointer; display: block;">

  <!-- email subject line：title contains file info -->

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

      image loading...[please click email details to download image]

    </div>

  </div>

</div>`;

        content = imageHtml;

      }

      logger.info(`[convertEmailToMessage] mailink_picture email: added ${imageAttachments.length} imagesHTML, subject="${subject}"`);

    } else {

      // When no image attachments, only show subject line

      content = `<div class="email-subject-line">📧 ${subject}</div>`;

    }

  }



  // Convert creation time to nanoseconds

  let createtime;

  try {

    const emailDate = email.receivedDate || email.date || new Date();

    const dateMs = new Date(emailDate).getTime();

    const nowMs = BigInt(dateMs);

    const hrTime = process.hrtime.bigint();

    createtime = (nowMs * 1000000n + (hrTime % 1000000n)).toString();

  } catch (error) {

    logger.warn(`[convertEmailToMessage] Error converting date: ${error.message}`);

    const nowMs = BigInt(Date.now());

    const hrTime = process.hrtime.bigint();

    createtime = (nowMs * 1000000n + (hrTime % 1000000n)).toString();

  }



  // Determine message direction

  const isFromMe = fromer.toLowerCase() === username.toLowerCase();



  // Sync email read status (0 = unread, 1 = read)

  // Note: per business logic, read emails will not call this function to insert chat history

  // But keep status sync logic for code completeness

  const isRead = email.is_read === 1 || email.is_read === true ? 1 : 0;

  const readTime = isRead === 1 ? createtime : 0;



  return {

    fromer,                    // sender email

    toer: toer || '',          // recipient email

    content,                   // 📧 email subject + imageHTML（if it ismailink_picture）

    createtime,                // receive time（nanosecond-level）

    type,                      // 2 = email message, 3 = image message（mailink_picture）

    status: 100,               // email arrival confirmed，does not display"(receiving...)"

    msgid: createtime,         // message uniqueID（uses nanosecond timestamp，andWebRTCmessage consistent）

    emid: email.messageId,     // original emailMessage-ID（used to associate original email）

    is_read: isRead,           // sync email read status（0 = unread, 1 = read）

    read_time: readTime        // Read time (0 when unread)

  };

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

 * Insert email list as chat messages into the message table

 * Supports any regular email (including mailink_ prefix), default type=2, content=📧 subject

 * Special handling: mailink_picture emails, type=3, content=📧 subject + image HTML

 * 

 * Read status handling rules:

 * - Read emails (is_read=1): do not insert into chat history table

 * - Unread emails (is_read=0): insert into chat history table and sync unread status

 * 

 * @param {string} username - Current user email

 * @param {Array} emails - Email array

 * @param {Object} options - Options {onlyUnread: boolean, imapConfig: Object}

 * @returns {Promise<{inserted: number, skipped: number, errors: Array, senders: Array}>} Processing statistics

 */

async function insertEmailsAsChatMessages(username, emails, options = {}) {

  const stats = { inserted: 0, skipped: 0, errors: [], senders: [] };



  if (!Array.isArray(emails) || emails.length === 0) {

    logger.info(`[insertEmailsAsChatMessages] Input is empty`);

    return stats;

  }



  const { onlyUnread = false, imapConfig = null } = options;

  const dbPath = pathUtils.getUserDbPath(username);



  logger.info(`[insertEmailsAsChatMessages] START processing ${emails.length} emails (onlyUnread=${onlyUnread})`);



  // Use Worker to batch preprocess emails (use Worker optimization when email count > 10)

  let processedEmails = [];

  let pendingImageDownloads = [];

  let preSkippedCount = 0;



  if (emails.length > 10) {

    try {

      logger.info(`[insertEmailsAsChatMessages] use Worker batch preprocessing ${emails.length} emails`);

      const worker = getEmailBatchProcessorWorker();

      const batchResult = await worker.sendTask({

        type: 'batchProcessEmails',

        params: {

          emails,

          username,

          options: { onlyUnread }

        }

      }, 30000); // 30-second timeout



      if (batchResult && batchResult.processed) {

        processedEmails = batchResult.processed;

        pendingImageDownloads = batchResult.pendingImageDownloads || [];

        preSkippedCount = batchResult.skipped ? batchResult.skipped.length : 0;

        logger.info(`[insertEmailsAsChatMessages] Worker preprocessing completed: processable=${processedEmails.length}, skip=${preSkippedCount}, pending download images=${pendingImageDownloads.length}`);

      }



      // Process add-friend emails (database operations must run on main thread)

      if (batchResult.skipped) {

        for (const skipped of batchResult.skipped) {

          if (skipped.reason === 'addfriend') {

            await handleAddFriendEmail(username, skipped.email);

          }

        }

      }

    } catch (workerError) {

      logger.warn(`[insertEmailsAsChatMessages] Worker preprocessing failed, using main thread processing: ${workerError.message}`);

      // Worker failed, fall back to main thread processing

      processedEmails = [];

      pendingImageDownloads = [];

    }

  }



  // If Worker is not used or Worker fails, use traditional processing

  if (processedEmails.length === 0 && emails.length <= 10) {

    for (const email of emails) {

      try {

        // 1. Skip signaling emails

        if (isSignalingEmail(email)) {

          logger.debug(`[insertEmailsAsChatMessages] Skipping signaling email (subject="${email.subject}")`);

          stats.skipped++;

          continue;

        }



        // 2. Process friend-request emails

        if (email.subject && email.subject.startsWith(MAILINK_ADDFRIEND_PREFIX)) {

          logger.info(`[insertEmailsAsChatMessages] detected add-friend email: ${email.subject}`);

          const handled = await handleAddFriendEmail(username, email);

          if (handled) {

            stats.skipped++;

            continue;

          }

        }



        // 3. [Core logic] sync email server read status

        if (email.is_read === 1 || email.is_read === true) {

          logger.debug(`[insertEmailsAsChatMessages] Skipping read email from server (subject="${email.subject}", is_read=${email.is_read})`);

          stats.skipped++;

          continue;

        }



        // 4. Only process unread emails (if onlyUnread is enabled)

        if (onlyUnread && email.is_read) {

          logger.debug(`[insertEmailsAsChatMessages] Skipping read email (subject="${email.subject}")`);

          stats.skipped++;

          continue;

        }



        // 5. Convert emails to message format

        const message = convertEmailToMessage(email, username);

        if (!message) {

          logger.debug(`[insertEmailsAsChatMessages] Skipping: convertEmailToMessage returned null (subject="${email.subject}")`);

          stats.skipped++;

          continue;

        }



        processedEmails.push({ email, message, senderEmail: message.fromer });



        // Collect image attachment info for mailink_picture emails

        if (message.type === 3 && imapConfig && email.uid) {

          const imageAttachments = (email.attachments || []).filter(att =>

            IMAGE_MIME_TYPES.includes(att.contentType) ||

            (att.filename && /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(att.filename))

          );

          if (imageAttachments.length > 0) {

            pendingImageDownloads.push({

              email,

              message,

              imageAttachments,

              fromer: message.fromer

            });

          }

        }

      } catch (error) {

        logger.error(`[insertEmailsAsChatMessages] Error preprocessing email (subject="${email.subject}"): ${error.message}`);

        stats.errors.push({

          messageId: email.messageId,

          error: error.message

        });

      }

    }

  } else {

    // Worker preprocessing succeeded, accumulate skipped count

    stats.skipped += preSkippedCount;

  }



  // Process preprocessed emails (database operations must run on main thread)

  for (const { email, message, senderEmail } of processedEmails) {

    try {

      // 1. Verify sender is a valid contact

      const isValid = await isValidContact(username, message.fromer);

      if (!isValid) {

        logger.info(`[insertEmailsAsChatMessages] Skipping: non-valid contact from="${message.fromer}" (subject="${email.subject}")`);

        stats.skipped++;

        continue;

      }



      // 2. Auto-update sender contact (ensure valid status in list)

      await autoUpdateSenderContact(username, message.fromer);



      // 3. Check whether message already exists (deduplicate based on emid)

      if (message.emid) {

        const existing = await UnifiedDB.withORM(dbPath, async (orm) => {

          return await orm.table('message')

            .where({ emid: message.emid, fromer: message.fromer })

            .find();

        });

        if (existing) {

          logger.debug(`[insertEmailsAsChatMessages] Skipping: message already exists (emid="${message.emid}")`);

          stats.skipped++;

          continue;

        }

      }



      // 4. Insert message into database

      const newId = await UnifiedDB.withORM(dbPath, async (orm) => {

        const result = await orm.table('message').insert({

          msgid: message.msgid,

          emid: message.emid,

          fromer: message.fromer,

          toer: message.toer,

          content: message.content,

          createtime: message.createtime,

          type: message.type,

          status: message.status,

          is_read: message.is_read,

          read_time: message.read_time

        });



        // Get auto-increment ID after insertion

        if (result && typeof result === 'number') {

          return result;

        }



        // If ORM does not return ID, query the latest inserted record

        const lastMsg = await orm.table('message')

          .where({ emid: message.emid, fromer: message.fromer })

          .order('id desc')

          .find();

        return lastMsg ? lastMsg.id : null;

      });



      // 5. Update contact's msgtime field

      try {

        const contactEmail = message.fromer.toLowerCase() === username.toLowerCase()

          ? message.toer : message.fromer;

        if (contactEmail) {

          await UnifiedDB.execute(

            dbPath,

            `UPDATE contact SET msgtime = ? WHERE lower(username) = lower(?)`,

            [message.createtime, contactEmail]

          );

        }

      } catch (contactError) {

        logger.warn(`[insertEmailsAsChatMessages] update contact msgtime failed: ${contactError.message}`);

      }



      stats.inserted++;

      stats.senders.push(message.fromer);

      logger.info(`[insertEmailsAsChatMessages] Inserted: id=${newId}, from="${message.fromer}", type=${message.type}, subject="${email.subject}", is_read=${message.is_read}`);



      // 6. Update newId in pendingImageDownloads

      const pendingDownload = pendingImageDownloads.find(p => p.message.emid === message.emid);

      if (pendingDownload) {

        pendingDownload.newId = newId;

      }

    } catch (error) {

      logger.error(`[insertEmailsAsChatMessages] Error processing email (subject="${email.subject}"): ${error.message}`, {

        messageId: email.messageId,

        subject: email.subject,

        stack: error.stack

      });

      stats.errors.push({

        messageId: email.messageId,

        error: error.message

      });

    }

  }



  // 7. Async download image attachments for mailink_picture emails and update message content

  if (pendingImageDownloads.length > 0) {

    // Do not block main flow, execute asynchronously

    downloadPictureAttachmentsAsync(username, pendingImageDownloads, imapConfig).catch(err => {

      logger.error(`[insertEmailsAsChatMessages] async download image attachment failed: ${err.message}`);

    });

  }



  logger.info(`[insertEmailsAsChatMessages] COMPLETE: inserted=${stats.inserted}, skipped=${stats.skipped}, errors=${stats.errors.length}`);

  return stats;

}



/**

 * Asynchronously download image attachments for mailink_picture emails and update message content

 * @param {string} username - Current user email

 * @param {Array} pendingDownloads - List of image attachments to download

 * @param {Object} imapConfig - IMAP config

 */

async function downloadPictureAttachmentsAsync(username, pendingDownloads, imapConfig) {

  const httpServerManager = require('../http/http-server-manager');

  const httpPort = httpServerManager.getHttpServerPort() || 8080;

  const dbPath = pathUtils.getUserDbPath(username);

  const recvsDir = pathUtils.getUserRecvsDir(username);



  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));



  const getLocalImagePath = async (uid, filename) => {

    const safeFilename = (filename || 'image.jpg')

      .replace(/[<>:"/\\|?*]/g, '_')

      .replace(/\s+/g, '_')

      .substring(0, 200);

    const uidPrefixedName = `${uid}_${safeFilename}`;

    const recvsFilePath = path.join(recvsDir, uidPrefixedName);

    const thumbnailFileName = thumbnailGenerator.getThumbnailFileName(uidPrefixedName);

    const thumbnailPath = path.join(recvsDir, thumbnailFileName);

    

    try {

      await fs.promises.access(recvsFilePath);

      return { exists: true, recvsFilePath, thumbnailPath, uidPrefixedName };

    } catch {

      return { exists: false, recvsFilePath, thumbnailPath, uidPrefixedName };

    }

  };



  const downloadWithRetry = async (imgAtt, email, message, maxRetries = 3) => {

    const retryDelays = [1000, 3000, 8000];

    let lastError = null;

    

    for (let attempt = 0; attempt < maxRetries; attempt++) {

      try {

        const { downloadAttachmentStreaming } = require('./imap-attachment-downloader-streaming');

        logger.info(`[downloadPictureAttachments] started downloading image attachment: filename=${imgAtt.filename}, uid=${email.uid}, attempt=${attempt + 1}/${maxRetries}`);

        

        const result = await downloadAttachmentStreaming({

          username,

          emailUid: email.uid,

          filename: imgAtt.filename,

          imapConfig

        });



        if (result && result.success && result.savePath) {

          return { success: true, result, attempt };

        }

        

        lastError = new Error(`download returned failed result: ${JSON.stringify(result)}`);

        logger.warn(`[downloadPictureAttachments] download failed (attempt ${attempt + 1}/${maxRetries}): filename=${imgAtt.filename}, error=${lastError.message}`);

      } catch (err) {

        lastError = err;

        logger.warn(`[downloadPictureAttachments] download exception (attempt ${attempt + 1}/${maxRetries}): filename=${imgAtt.filename}, error=${err.message}`);

      }

      

      if (attempt < maxRetries - 1) {

        const delay = retryDelays[attempt] || retryDelays[retryDelays.length - 1];

        logger.info(`[downloadPictureAttachments] waiting ${delay}ms then retry: filename=${imgAtt.filename}`);

        await sleep(delay);

      }

    }

    

    return { success: false, error: lastError, attempt: maxRetries };

  };



  // Ensure recvs directory exists

  try {

    await fs.promises.mkdir(recvsDir, { recursive: true });

  } catch (mkdirErr) {

    logger.warn(`[downloadPictureAttachments] create recvs directory failed: ${mkdirErr.message}`);

  }



  for (const { email, message, imageAttachments, newId } of pendingDownloads) {

    try {

      

      for (const imgAtt of imageAttachments) {

        try {

          const localInfo = await getLocalImagePath(email.uid, imgAtt.filename);

          

          let imgSrc, imageUrl, recvsFilePath, fileSize;

          

          if (localInfo.exists) {

            logger.info(`[downloadPictureAttachments] image already exists, skip download: uid=${email.uid}, filename=${imgAtt.filename}`);

            const attachmentFileName = localInfo.uidPrefixedName;

            recvsFilePath = localInfo.recvsFilePath;

            imageUrl = `http://127.0.0.1:${httpPort}/${username}/files/recvs/${encodeURIComponent(attachmentFileName)}`;

            fileSize = formatBytes(imgAtt.size || 0);

            

            const thumbResult = await thumbnailGenerator.generateThumbnail(recvsFilePath, { maxWidth: 200 });

            const thumbnailFileName = thumbnailGenerator.getThumbnailFileName(attachmentFileName);

            const thumbnailUrl = `http://127.0.0.1:${httpPort}/${username}/files/recvs/${encodeURIComponent(thumbnailFileName)}`;

            imgSrc = (thumbResult && !thumbResult.skipped) ? thumbnailUrl : imageUrl;

          } else {

            const dlResult = await downloadWithRetry(imgAtt, email, message);



            if (!dlResult.success) {

              logger.error(`[downloadPictureAttachments] image attachment download ultimately failed (retried ${dlResult.attempt} times): filename=${imgAtt.filename}, error=${dlResult.error?.message}`);

              continue;

            }



            const { result } = dlResult;

            const attachmentFileName = `${email.uid}_${result.savePath.split(/[/\\]/).pop()}`;

            recvsFilePath = path.join(recvsDir, attachmentFileName);



            try {

              await fs.promises.copyFile(result.savePath, recvsFilePath);

              logger.info(`[downloadPictureAttachments] copied image to recvs directory: ${recvsFilePath}`);

            } catch (copyErr) {

              logger.warn(`[downloadPictureAttachments] copy to recvs failed, try using attachment path: ${copyErr.message}`);

            }



            imageUrl = `http://127.0.0.1:${httpPort}/${username}/files/recvs/${encodeURIComponent(attachmentFileName)}`;

            fileSize = formatBytes(result.size || imgAtt.size || 0);



            logger.info(`[downloadPictureAttachments] image attachment download succeeded: ${attachmentFileName}, URL=${imageUrl}`);



            const thumbResult = await thumbnailGenerator.generateThumbnail(recvsFilePath, { maxWidth: 200 });

            const thumbnailFileName = thumbnailGenerator.getThumbnailFileName(attachmentFileName);

            const thumbnailUrl = `http://127.0.0.1:${httpPort}/${username}/files/recvs/${encodeURIComponent(thumbnailFileName)}`;

            imgSrc = (thumbResult && !thumbResult.skipped) ? thumbnailUrl : imageUrl;

          }



          const msgId = message.emid || message.msgid;

          const subject = email.subject || '(no subject)';



          // Escape dynamic content as HTML to prevent XSS injection

          const safeFilename = escapeHtml(imgAtt.filename);

          const safeFileSize = escapeHtml(fileSize);

          const safeSubject = escapeHtml(subject);

          const safeMsgId = escapeHtml(msgId);

          const safeEmid = escapeHtml(email.messageId || '');

          const safeUid = escapeHtml(String(email.uid || ''));



          // Move file info to title attribute, shown on mouse hover

          // [FIX] Use email-image-container instead of image-message to avoid confusion with WebRTC file transfer image-message class

          // [FIX] Display subject line and images in two rows

          const newContent = `<div class="email-image-message" data-emid="${safeEmid}" data-email-uid="${safeUid}" data-attachment-filename="${safeFilename}" style="cursor: pointer; display: block;">

  <div class="email-subject-line" title="filename: ${safeFilename} | size: ${safeFileSize} | transmission method: Email" style="color: #1890ff; border: 1px solid #ccc; border-radius: 4px; padding: 2px 6px; margin-bottom: 8px; display: inline-block; cursor: pointer;">📧 ${safeSubject}</div>

  <div class="email-image-container" id="image-${safeMsgId}" data-email-attachment="true" style="cursor: default; display: block;">

    <img src="${imgSrc}"

         data-original-src="${imageUrl}"

         alt="${safeFilename}"

         data-filename="${safeFilename}"

         style="max-width: 200px; height: auto; border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); display: block; cursor: pointer;"

         onclick="event.stopPropagation(); window.open(this.dataset.originalSrc || this.src, '_blank');"

         onerror="if(this.dataset.originalSrc && this.src!==this.dataset.originalSrc && !this._fb){this._fb=1;this.src=this.dataset.originalSrc;}else{this.style.display='none';}">

  </div>

</div>`;

            

            // Update message content in database

            await UnifiedDB.execute(

              dbPath,

              'UPDATE message SET content = ? WHERE msgid = ?',

              [newContent, message.msgid]

            );



            logger.info(`[downloadPictureAttachments] message content updated to imageHTML: msgid=${message.msgid}`);



            // Update attachments field in recv table, appending localPath info

            try {

              const recvRow = await UnifiedDB.get(

                dbPath,

                'SELECT id, attachments FROM recv WHERE message_id = ?',

                [email.messageId]

              );



              if (recvRow && recvRow.attachments) {

                let attachmentsList;

                try {

                  attachmentsList = typeof recvRow.attachments === 'string'

                    ? JSON.parse(recvRow.attachments) : recvRow.attachments;

                } catch (parseErr) {

                  logger.warn(`[downloadPictureAttachments] parse recv table attachments failed: ${parseErr.message}`);

                  attachmentsList = null;

                }



                if (Array.isArray(attachmentsList)) {

                  for (const att of attachmentsList) {

                    if (att.filename === imgAtt.filename) {

                      att.downloaded = true;

                      att.localPath = recvsFilePath;

                      att.downloadedAt = new Date().toISOString();

                      break;

                    }

                  }

                  await UnifiedDB.execute(

                    dbPath,

                    'UPDATE recv SET attachments = ? WHERE id = ?',

                    [JSON.stringify(attachmentsList), recvRow.id]

                  );

                  logger.info(`[downloadPictureAttachments] updated recv table attachment info: emailId=${recvRow.id}, filename=${imgAtt.filename}, localPath=${recvsFilePath}`);

                }

              } else {

                logger.warn(`[downloadPictureAttachments] not in recv found email in table: messageId=${email.messageId}`);

              }

            } catch (recvUpdateErr) {

              logger.warn(`[downloadPictureAttachments] update recv table attachment info failed: ${recvUpdateErr.message}`);

            }

            

            // Notify renderer to update this message

            if (global.mainWindow && global.mainWindow.webContents) {

              try {

                global.mainWindow.webContents.send('chat-message-content-updated', {

                  username,

                  msgid: message.msgid,

                  content: newContent

                });

              } catch (notifyError) {

                logger.warn(`[downloadPictureAttachments] failed to notify renderer process: ${notifyError.message}`);

              }

            }

          } catch (downloadError) {

            logger.error(`[downloadPictureAttachments] download image attachment exception: filename=${imgAtt.filename}, error=${downloadError.message}`);

          }

        }

    } catch (error) {

      logger.error(`[downloadPictureAttachments] failed to process email image attachment: subject="${email.subject}", error=${error.message}`);

    }

  }

}



/**

 * Process new emails and trigger the full notification flow

 * Auto: filter signaling emails + filter read emails + insert messages + auto-update contacts + trigger notifications

 * Supports any regular email (including mailink_ prefix), default type=2, content=📧 subject

 * Special handling: mailink_picture emails, type=3, content=📧 subject + image HTML

 * @param {string} username - Current user email

 * @param {Array} emails - Email array

 * @param {Object} imapConfig - IMAP config (used to download image attachments for mailink_picture emails)

 * @returns {Promise<{stats: {inserted: number, skipped: number, errors: Array}}>} Processing result

 */

async function processNewEmailsAndNotify(username, emails, imapConfig = null) {

  if (!emails || !Array.isArray(emails) || emails.length === 0) {

    return { stats: { inserted: 0, skipped: 0, errors: [] } };

  }



  const stats = { inserted: 0, skipped: 0, errors: [] };



  try {

    // 1. Filter processable emails (non-signaling is enough, no longer limited to mailink_ prefix)

    const chatEmails = emails.filter(email => {

      if (!email) return false;

      if (isSignalingEmail(email)) return false;

      return true;

    });



    if (chatEmails.length === 0) {

      logger.info(`[ChatMessage] no emails to process (total${emails.length}emails, all are signaling emails)`);

      return { stats: { inserted: 0, skipped: emails.length, errors: [] } };

    }



    logger.info(`[ChatMessage] from${emails.length}emails filtered out${chatEmails.length}regular emails pending processing`);



    // 2. Insert chat messages into message table (onlyUnread=true, process only unread, pass imapConfig)

    const insertResult = await insertEmailsAsChatMessages(username, chatEmails, { onlyUnread: true, imapConfig });

    stats.inserted = insertResult.inserted;

    stats.skipped = insertResult.skipped;

    stats.errors = insertResult.errors;



    // 3. Auto-update sender contacts + notify renderer

    if (stats.inserted > 0) {

      const senders = new Set(insertResult.senders);



      // 4. Notify renderer of new chat messages

      if (global.mainWindow && global.mainWindow.webContents) {

        try {

          const senderList = Array.from(senders);

          const senderCounts = {};

          for (const sender of insertResult.senders) {

            senderCounts[sender] = (senderCounts[sender] || 0) + 1;

          }



          global.mainWindow.webContents.send('new-chat-messages', {

            username: username,

            newCount: stats.inserted,

            senders: senderList,

            senderCounts: senderCounts,

            timestamp: Date.now()

          });

          logger.info(`[ChatMessage] notified renderer process: ${stats.inserted}new messages, sender: ${senderList.join(', ')}`);

        } catch (notifyError) {

          logger.error(`[ChatMessage] failed to notify renderer process: ${notifyError.message}`);

        }

      }

    }

  } catch (error) {

    logger.error(`[ChatMessage] processNewEmailsAndNotify failed: ${error.message}`, error);

    stats.errors.push({ error: error.message });

  }



  return { stats };

}



module.exports = {

  insertEmailsAsChatMessages,

  processNewEmailsAndNotify,

  autoUpdateSenderContact,

  isValidContact,

  convertEmailToMessage,

  extractEmailAddress,

  handleAddFriendEmail,

  MAILINK_ADDFRIEND_PREFIX

};

