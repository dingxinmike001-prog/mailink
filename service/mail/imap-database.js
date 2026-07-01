const path = require('path');
const TPishSQLite = require('../sqlite/tpish-sqlite');
const logger = require('../logger');
const pathUtils = require('../../shared/path/path-utils');
const jsonProcessor = require('../workers/json-processor-manager');
const { getInstance: getBatchManager } = require('../sqlite/sqlite-batch-manager');
const { UnifiedDB } = require('../sqlite/sqlite-unified');

/**
 * Get database instance for a specific user
 * @param {string} username - Email username
 * @returns {TPishSQLite} Database instance
 */
function getDatabase(username) {
  const dbPath = pathUtils.getUserDbPath(username);
  return new TPishSQLite(dbPath);
}

/**
 * Extract email address from parsed email field
 * @param {Object|string|Array} fromField - Parsed email from field
 * @returns {string} Extracted email address
 */
function extractEmailAddress(fromField) {
  if (!fromField) {
    logger.info('extractEmailAddress: fromField is null/undefined');
    return '';
  }

  // Log the actual type and structure for debugging
  logger.info(`extractEmailAddress: type=${typeof fromField}, isArray=${Array.isArray(fromField)}`);
  if (typeof fromField === 'object' && !Array.isArray(fromField)) {
    logger.info(`extractEmailAddress: object keys=${Object.keys(fromField).join(', ')}`);
    // Log the full object for debugging (be careful with sensitive data)
    try {
      logger.info(`extractEmailAddress: object content=${JSON.stringify(fromField)}`);
    } catch (e) {
      logger.info(`extractEmailAddress: object content=[circular or non-serializable]`);
    }
  }

  // Handle mailparser's AddressObject format: { value: [{address, name}], text: '...' }
  if (typeof fromField === 'object' && !Array.isArray(fromField)) {
    // Try value array first (most reliable)
    if (fromField.value && Array.isArray(fromField.value) && fromField.value.length > 0) {
      const addr = fromField.value[0];
      logger.info(`extractEmailAddress: using value[0], address=${addr.address}`);
      if (addr.address) return addr.address;
    }

    // Try text field
    if (fromField.text) {
      logger.info(`extractEmailAddress: using text field, text=${fromField.text}`);
      const emailMatch = fromField.text.match(/<([^>]+)>/);
      if (emailMatch && emailMatch[1]) {
        return emailMatch[1];
      }
      // If no angle brackets, check if it's a valid email
      if (fromField.text.includes('@')) {
        return fromField.text.trim();
      }
    }

    // Try address field directly
    if (fromField.address) {
      logger.info(`extractEmailAddress: using address field, address=${fromField.address}`);
      return fromField.address;
    }
  }

  // Handle array (multiple addresses) - use first one
  if (Array.isArray(fromField) && fromField.length > 0) {
    logger.info(`extractEmailAddress: handling array with ${fromField.length} items`);
    return extractEmailAddress(fromField[0]);
  }

  // Handle plain string
  if (typeof fromField === 'string') {
    logger.info(`extractEmailAddress: handling string, value=${fromField}`);
    const emailMatch = fromField.match(/<([^>]+)>/);
    if (emailMatch && emailMatch[1]) {
      return emailMatch[1];
    }
    if (fromField.includes('@')) {
      return fromField.trim();
    }
    return fromField;
  }

  logger.info(`extractEmailAddress: unrecognized format, returning empty`);
  return '';
}

/**
 * Check if email already exists in database (based on message_id)
 * @param {string} dbPath - Database path
 * @param {string} messageId - Email message ID
 * @returns {Promise<boolean>} True if email already exists
 */
async function isEmailExists(dbPath, messageId) {
  if (!messageId) return false;

  try {
    const batchManager = getBatchManager();
    const result = await batchManager.checkEmailExists(dbPath, messageId);
    return result.success && result.exists;
  } catch (error) {
    logger.error(`Failed to check email existence: ${error.message}`);
    return false;
  }
}

/**
 * Extract text from parsed email field (handles various formats: string, object, array)
 * @param {Object|string|Array} field - Parsed email field (from, to, cc)
 * @returns {string} Extracted text
 */
function getEmailText(field) {
  if (!field) return '';
  if (typeof field === 'string') return field;
  if (Array.isArray(field) && field.length > 0) {
    // Handle array of addresses
    return field.map(addr => {
      if (typeof addr === 'string') return addr;
      if (addr.text) return addr.text;
      if (addr.address) return addr.address;
      return '';
    }).join(', ');
  }
  if (field.text) return field.text;
  if (field.address) return field.address;
  return '';
}

/**
 * Check whether to skip contact backup email (backup emails sent by self are not saved)
 * @param {Object} parsed - Parsed email object
 * @param {string} dbPath - Database path
 * @returns {boolean} true means should skip
 */
function shouldSkipContactBackupEmail(parsed, dbPath) {
  if (!parsed.subject || !parsed.subject.includes('mailink_bak_contacts')) {
    return false;
  }
  const currentUserEmail = dbPath ? require('path').basename(require('path').dirname(dbPath)).toLowerCase() : '';
  const fromEmail = extractEmailAddress(parsed.from).toLowerCase();
  if (fromEmail === currentUserEmail) {
    logger.info(`skipped self-sent contact backup email: subject="${parsed.subject}", from="${getEmailText(parsed.from)}"`);
    return true;
  }
  return false;
}

/**
 * Check whether it is a signaling email
 * @param {Object} parsed - Parsed email object
 * @returns {boolean}
 */
const { SIGNALING_EMAIL_PREFIX } = require('../../shared/config/signaling-constants');

function isSignalingEmail(parsed) {
  return parsed.subject && parsed.subject.startsWith(SIGNALING_EMAIL_PREFIX);
}

/**
 * Build complete email data object (for JSON serialization)
 * @param {Object} parsed - Parsed email object
 * @param {*} priority - Priority
 * @param {Object} headers - Email headers
 * @returns {Object} fullEmailData object
 */
function buildFullEmailData(parsed, priority, headers) {
  return {
    subject: parsed.subject || '',
    from: getEmailText(parsed.from),
    to: getEmailText(parsed.to),
    cc: getEmailText(parsed.cc),
    text: parsed.text || '',
    html: parsed.html || '',
    attachments: parsed.attachments || [],
    headers: headers,
    priority: priority
  };
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
 * Convert date to nanosecond timestamp string
 * @param {Date} date - Date object
 * @returns {string} Nanosecond timestamp string
 */
function dateToNanoTimestamp(date) {
  const receivedTimeMs = BigInt(date.getTime());
  return (receivedTimeMs * 1000000n).toString();
}

/**
 * Automatically add sender to contact list (if not exists)
 * @param {string} dbPath - Database path
 * @param {string} senderEmail - Sender email address
 * @param {string} senderName - Sender name (optional)
 */
async function autoAddContact(dbPath, senderEmail, senderName) {
  if (!senderEmail || senderEmail.trim() === '') {
    return;
  }

  try {
    // Extract current user email from database path (email in path may use _at_ instead of @)
    const path = require('path');
    const dbDir = path.dirname(dbPath);
    const currentUserEmail = path.basename(dbDir).toLowerCase().replace(/_at_/g, '@');

    const batchManager = getBatchManager();
    const result = await batchManager.autoAddSingleContact(dbPath, {
      email: senderEmail,
      name: senderName,
      currentUserEmail: currentUserEmail
    });

    if (result.success) {
      if (result.wasAdded) {
        logger.info(`[autoAddContact] Contact auto-added successfully. ID: ${result.contactId}, Email: ${senderEmail.toLowerCase()}, Name: ${senderName || ''}`);
      } else if (result.skipped) {
        logger.debug(`[autoAddContact] Cannot add self as contact: ${senderEmail}`);
      } else {
        logger.debug(`[autoAddContact] Contact already exists: ${senderEmail.toLowerCase()}`);
      }
    }
  } catch (error) {
    logger.error(`[autoAddContact] Failed to auto-add contact: ${error.message}`);
    // add contact failure should not affect email save flow
  }
}

/**
 * Save email to database
 * @param {string} dbPath - Database path
 * @param {Object} parsed - Parsed email object
 * @param {number} imapUid - IMAP UID
 * @returns {Promise<number|null>} Inserted record ID or null if not saved
 */
async function saveEmailToDatabase(dbPath, parsed, imapUid) {
  // Log the parsed object for debugging
  logger.info(`saveEmailToDatabase: parsed.from=${JSON.stringify(parsed.from)}, parsed.to=${JSON.stringify(parsed.to)}`);
  logger.info(`saveEmailToDatabase: parsed.subject=${parsed.subject}, parsed.messageId=${parsed.messageId}, imapUid=${imapUid}`);
  logger.info(`saveEmailToDatabase: parsed.priority=${parsed.priority}, parsed.headers=${JSON.stringify(parsed.headers)}`);
  
  // ✅ Filter out self-sent contact backup emails
  if (shouldSkipContactBackupEmail(parsed, dbPath)) {
    return null;
  }

  // Use priority and headers from parsed if already set (from Worker), otherwise extract from headers
  let priority = parsed.priority || null;
  let headers = parsed.headers || {};

  // If priority is not set but headers exist, try to extract from headers
  if (!priority && parsed.headers) {
    // Handle headers as Map or plain object
    let headersMap = {};
    if (parsed.headers instanceof Map) {
      headersMap = Object.fromEntries(parsed.headers);
    } else if (typeof parsed.headers === 'object') {
      headersMap = parsed.headers;
    }

    // Try both lowercase and original case for header names
    const xPriority = headersMap['x-priority'] || headersMap['X-Priority'];
    const importance = headersMap['importance'] || headersMap['Importance'];
    const mpPriority = headersMap['priority'];

    if (mpPriority) {
      priority = mpPriority;
    } else if (xPriority) {
      const p = String(xPriority).charAt(0);
      if (p === '1') priority = 'high';
      else if (p === '5') priority = 'low';
      else if (p === '3') priority = 'normal';
    } else if (importance) {
      const i = String(importance).toLowerCase();
      if (i === 'high') priority = 'high';
      else if (i === 'low') priority = 'low';
      else if (i === 'normal') priority = 'normal';
    }

    // Extract key headers for frontend use (use lowercase keys for consistency)
    if (headersMap['priority']) {
      headers['priority'] = headersMap['priority'];
    }
    if (headersMap['x-priority'] || headersMap['X-Priority']) {
      headers['x-priority'] = headersMap['x-priority'] || headersMap['X-Priority'];
    }
    if (headersMap['importance'] || headersMap['Importance']) {
      headers['importance'] = headersMap['importance'] || headersMap['Importance'];
    }
  }

  // Build complete email data object (using common function)
  const fullEmailData = buildFullEmailData(parsed, priority, headers);

  // Check signaling emails
  const isSignaling = isSignalingEmail(parsed);
  
  // All signaling emails are not written to recv table
  if (isSignaling) {
    logger.debug('signaling emails skipped saving to database');
    return null;
  }

  // Extract message ID for deduplication
  const messageId = parsed.messageId || '';
  
  // Check for duplicate email based on message_id
  if (messageId) {
    const exists = await isEmailExists(dbPath, messageId);
    if (exists) {
      logger.debug(`Email skipped (duplicate message_id: ${messageId})`);
      return null;
    }
  }

  // Get current timestamp (nanoseconds, based on Unix Epoch)
  const createtime = generateNanoTimestamp();
  
  // Extract sender and recipient
  const sender = extractEmailAddress(parsed.from);
  const recipient = extractEmailAddress(parsed.to);
  
  // Skip emails without sender
  if (!sender || sender.trim() === '') {
    logger.info('Email skipped (no sender)');
    return null;
  }
  
  // Convert received time to nanoseconds
  const emailDate = new Date(fullEmailData.date);
  const receivedTime = dateToNanoTimestamp(emailDate);

  // Build email data object for saving (split into separate fields)
  const emailData = {
    txtbody: fullEmailData.text || '',
    htmbody: fullEmailData.html || '',
    attachments: JSON.stringify(fullEmailData.attachments || []),
    headers: JSON.stringify(fullEmailData.headers || {}),
    priority: fullEmailData.priority || '',
    createtime: createtime,
    message_id: messageId,
    imap_uid: imapUid ? String(imapUid) : '',
    subject: parsed.subject || '',
    sender: sender,
    recipient: recipient,
    received_time: receivedTime,
    is_signaling: isSignaling ? 1 : 0,
    is_read: 0
  };

  // Use Worker to save single email
  const batchManager = getBatchManager();
  const saveResult = await batchManager.saveSingleEmail(dbPath, emailData);

  if (saveResult.success) {
    if (saveResult.wasInserted) {
      logger.info(`${saveResult.insertedId},Email saved to database successfully (signaling: ${isSignaling ? 'yes' : 'no'})`);

      // Automatically add sender to contact list (async, non-blocking)
      if (dbPath && sender) {
        // Extract sender name (from from field)
        let senderName = '';
        if (parsed.from) {
          if (typeof parsed.from === 'string') {
            const nameMatch = parsed.from.match(/^([^<]+)</);
            if (nameMatch) {
              senderName = nameMatch[1].trim();
            }
          } else if (parsed.from.text) {
            const nameMatch = parsed.from.text.match(/^([^<]+)</);
            if (nameMatch) {
              senderName = nameMatch[1].trim();
            }
          }
        }
        autoAddContact(dbPath, sender, senderName).catch(err => {
          logger.warn(`[saveEmailToDatabase] Auto-add contact failed (non-blocking): ${err.message}`);
        });
      }

      return saveResult.insertedId;
    } else {
      logger.debug(`Email skipped (duplicate message_id: ${messageId})`);
      return null;
    }
  } else {
    logger.error(`Failed to save email to database: ${saveResult.error}`);
    return null;
  }
}

/**
 * Batch save emails to database (optimized - supports batch JSON serialization)
 * @param {string} username - Username
 * @param {Array} emailsList - Parsed email array
 * @param {boolean} useBuffer - Whether to use buffer (batching)
 * @returns {Promise<Object>} - {savedCount, skippedCount, errors}
 */
async function batchSaveEmailsToDatabase(username, emailsList, useBuffer = true) {
  const dbPath = pathUtils.getUserDbPath(username);
  const batchManager = getBatchManager();

  const results = {
    savedCount: 0,
    skippedCount: 0,
    errors: [],
    insertedIds: []
  };

  if (!emailsList || emailsList.length === 0) {
    return results;
  }

  // ========== Phase 1: Preprocess all emails and build metadata ==========
  const emailsMetadata = [];

  // 🔍 Collect message_id and imap_uid of all emails for batch deduplication checks
  const messageIdsToCheck = [];
  const imapUidsToCheck = [];
  const parsedEmailsMap = new Map(); // For subsequent lookup

  for (const parsed of emailsList) {
    if (parsed.messageId) {
      messageIdsToCheck.push(parsed.messageId);
      parsedEmailsMap.set(parsed.messageId, parsed);
    }
    if (parsed.uid) {
      imapUidsToCheck.push(String(parsed.uid));
    }
  }

  // 🔍 Batch check whether these emails already exist in database (based on message_id)
  const existingMessageIds = new Set();
  if (messageIdsToCheck.length > 0) {
    try {
      const db = getDatabase(username);
      // Query in batches to avoid too many SQL parameters
      const batchSize = 100;
      for (let i = 0; i < messageIdsToCheck.length; i += batchSize) {
        const batch = messageIdsToCheck.slice(i, i + batchSize);
        const placeholders = batch.map(() => '?').join(',');
        const sql = `SELECT message_id FROM recv WHERE message_id IN (${placeholders})`;
        const existingRows = await db.query(sql, batch);
        existingRows.forEach(row => {
          if (row.message_id) {
            existingMessageIds.add(row.message_id);
          }
        });
      }
      await db.close();
      if (existingMessageIds.size > 0) {
        logger.info(`[batchSaveEmails] Found ${existingMessageIds.size} duplicate emails (by message_id) in database, will skip them`);
      }
    } catch (error) {
      logger.warn(`[batchSaveEmails] Failed to check existing emails by message_id: ${error.message}`);
      // check failure does not block save process，continue execution
    }
  }

  // 🔍 Batch check whether these emails already exist in database (based on imap_uid)
  const existingImapUids = new Set();
  if (imapUidsToCheck.length > 0) {
    try {
      const db = getDatabase(username);
      // Query in batches to avoid too many SQL parameters
      const batchSize = 100;
      for (let i = 0; i < imapUidsToCheck.length; i += batchSize) {
        const batch = imapUidsToCheck.slice(i, i + batchSize);
        const placeholders = batch.map(() => '?').join(',');
        const sql = `SELECT imap_uid FROM recv WHERE imap_uid IN (${placeholders})`;
        const existingRows = await db.query(sql, batch);
        existingRows.forEach(row => {
          if (row.imap_uid) {
            existingImapUids.add(row.imap_uid);
          }
        });
      }
      await db.close();
      if (existingImapUids.size > 0) {
        logger.info(`[batchSaveEmails] Found ${existingImapUids.size} duplicate emails (by imap_uid) in database, will skip them`);
      }
    } catch (error) {
      logger.warn(`[batchSaveEmails] Failed to check existing emails by imap_uid: ${error.message}`);
      // check failure does not block save process，continue execution
    }
  }

  // Get current user email (used to filter backup emails sent by self)
  const currentUserEmail = dbPath ? require('path').basename(require('path').dirname(dbPath)).toLowerCase() : '';

  for (const parsed of emailsList) {
    try {
      // ✅ Priority and headers have been processed in Worker (email-parser.worker.js)
      const priority = parsed.priority || null;
      const headers = parsed.headers || {};

      // Check signaling emails
      const isSignaling = isSignalingEmail(parsed);

      // All signaling emails are not written to recv table
      if (isSignaling) {
        logger.debug('[batchSaveEmails] signaling emails skipped saving to database');
        results.skippedCount++;
        continue;
      }

      // ✅ Filter out self-sent contact backup emails
      if (shouldSkipContactBackupEmail(parsed, dbPath)) {
        results.skippedCount++;
        continue;
      }

      // Extract message ID and IMAP UID
      const messageId = parsed.messageId || '';
      const imapUid = parsed.uid ? String(parsed.uid) : '';

      // 🔍 Check whether already exists in database (based on message_id)
      if (messageId && existingMessageIds.has(messageId)) {
        logger.debug(`[batchSaveEmails] Email skipped (duplicate message_id in database: ${messageId})`);
        results.skippedCount++;
        continue;
      }

      // 🔍 Check whether already exists in database (based on imap_uid)
      if (imapUid && existingImapUids.has(imapUid)) {
        logger.debug(`[batchSaveEmails] Email skipped (duplicate imap_uid in database: ${imapUid})`);
        results.skippedCount++;
        continue;
      }

      // Extract sender and recipient
      const sender = extractEmailAddress(parsed.from);
      const recipient = extractEmailAddress(parsed.to);

      if (!sender || sender.trim() === '') {
        logger.info('[batchSaveEmails] Email skipped (no sender)');
        results.skippedCount++;
        continue;
      }

      // Build complete email data for JSON serialization (using common function)
      const fullEmailData = buildFullEmailData(parsed, priority, headers);

      // Build email metadata (includes fields required by database)
      const createtime = generateNanoTimestamp();
      const emailDate = new Date(parsed.date ? parsed.date.toISOString() : new Date().toISOString());
      const receivedTime = dateToNanoTimestamp(emailDate);

      // Save metadata and raw data
      emailsMetadata.push({
        messageId,
        sender,
        recipient,
        isSignaling,
        createtime,
        receivedTime,
        subject: parsed.subject || '',
        uid: parsed.uid || null,
        is_read: parsed.is_read !== undefined ? parsed.is_read : 0,
        originalData: fullEmailData // Save raw data
      });

    } catch (error) {
      logger.error(`[batchSaveEmails] Error preprocessing email: ${error.message}`);
      results.errors.push({
        subject: parsed?.subject,
        error: error.message
      });
      results.skippedCount++;
    }
  }

  if (emailsMetadata.length === 0) {
    return results;
  }

  // ========== Phase 2: Build batch INSERT data ==========
  const emailsToInsert = [];
  for (let i = 0; i < emailsMetadata.length; i++) {
    const metadata = emailsMetadata[i];
    const originalData = metadata.originalData;

    if (!originalData) {
      logger.warn(`[batchSaveEmails] Skipping email with missing data at index ${i}`);
      results.skippedCount++;
      continue;
    }

    emailsToInsert.push({
      txtbody: originalData.text || '',
      htmbody: originalData.html || '',
      attachments: JSON.stringify(originalData.attachments || []),
      headers: JSON.stringify(originalData.headers || {}),
      priority: originalData.priority || '',
      createtime: metadata.createtime,
      message_id: metadata.messageId,
      imap_uid: metadata.uid ? String(metadata.uid) : '',
      subject: metadata.subject,
      sender: metadata.sender,
      recipient: metadata.recipient,
      received_time: metadata.receivedTime,
      is_signaling: metadata.isSignaling ? 1 : 0,
      is_read: metadata.is_read !== undefined ? metadata.is_read : 0
    });
  }

  // ========== Phase 4: Execute batch database insert ==========
  if (emailsToInsert.length > 0) {
    try {
      logger.info(`[batchSaveEmails] Calling batchInsertEmails with ${emailsToInsert.length} emails, useBuffer=${useBuffer}, immediate=${!useBuffer}`);
      const batchResult = await batchManager.batchInsertEmails(dbPath, emailsToInsert, !useBuffer);
      logger.info(`[batchSaveEmails] batchInsertEmails returned: ${JSON.stringify(batchResult)}`);

      if (batchResult && batchResult.success) {
        if (batchResult.buffered) {
          results.savedCount = emailsToInsert.length;
          logger.info(`[batchSaveEmails] Emails buffered successfully: ${emailsToInsert.length} emails queued for batch insert`);
        } else {
          results.savedCount = batchResult.insertedCount || 0;
          results.insertedIds = batchResult.insertedIds || [];
          logger.info(`[batchSaveEmails] Batch insert completed: inserted=${batchResult.insertedCount}, skipped=${batchResult.skippedCount}, failed=${batchResult.failedCount}`);
        }

        if (batchResult.errors && batchResult.errors.length > 0) {
          results.errors.push(...batchResult.errors);
          results.skippedCount += batchResult.failedCount || 0;
        }

        // ========== Phase 5: Automatically add senders to contact list ==========
        // Collect all unique sender emails
        const uniqueSenders = new Map();
        for (const email of emailsToInsert) {
          if (email.sender && !uniqueSenders.has(email.sender.toLowerCase())) {
            uniqueSenders.set(email.sender.toLowerCase(), {
              email: email.sender,
              name: ''
            });
          }
        }

        // Add contacts asynchronously (do not block result return)
        if (uniqueSenders.size > 0) {
          const sendersArray = Array.from(uniqueSenders.values());
          logger.info(`[batchSaveEmails] Auto-adding ${sendersArray.length} unique senders to contacts`);

          // Use Promise.allSettled to add contacts in parallel
          Promise.allSettled(
            sendersArray.map(sender => autoAddContact(dbPath, sender.email, sender.name))
          ).then(results => {
            const successCount = results.filter(r => r.status === 'fulfilled').length;
            logger.info(`[batchSaveEmails] Auto-add contacts completed: ${successCount}/${sendersArray.length} succeeded`);
          }).catch(err => {
            logger.warn(`[batchSaveEmails] Auto-add contacts error (non-blocking): ${err.message}`);
          });
        }
      } else {
        logger.error(`[batchSaveEmails] Batch insert failed: ${batchResult?.error || 'Unknown error'}`);
        results.errors.push({ error: batchResult?.error || 'Batch insert failed' });
        results.skippedCount += emailsToInsert.length;
      }
    } catch (error) {
      logger.error(`[batchSaveEmails] Exception during batch insert: ${error.message}`);
      results.errors.push({ error: error.message });
      results.skippedCount += emailsToInsert.length;
    }
  }

  return results;
}

/**
 * Flush buffer immediately (ensure all pending emails are saved)
 * @param {string} username - Username
 */
async function flushEmailBuffer(username) {
  const dbPath = pathUtils.getUserDbPath(username);
  const batchManager = getBatchManager();
  
  try {
    await batchManager.flush(dbPath);
    logger.info(`[flushEmailBuffer] Buffer flushed for user: ${username}`);
  } catch (error) {
    logger.error(`[flushEmailBuffer] Error flushing buffer: ${error.message}`);
    throw error;
  }
}

/**
 * Batch update email read status in local database
 * @param {string} username - Username
 * @param {Array} updates - [{message_id: string, is_read: 0|1}, ...]
 * @param {boolean} useBuffer - Whether to use buffer (batching)
 * @returns {Promise<Object>} - {success: boolean, updatedCount: number, errors: Array}
 */
async function batchUpdateReadStatusLocally(username, updates, useBuffer = true) {
  const dbPath = pathUtils.getUserDbPath(username);
  const batchManager = getBatchManager();

  if (!updates || updates.length === 0) {
    return { success: true, updatedCount: 0, errors: [] };
  }

  try {
    const result = await batchManager.batchUpdateReadStatus(dbPath, updates, !useBuffer);
    
    if (result && result.success) {
      logger.info(`[batchUpdateReadStatusLocally] batch update completed: update=${result.updatedCount}, failed=${result.failedCount}`);
    } else {
      logger.error(`[batchUpdateReadStatusLocally] batch update failed: ${result?.error || 'Unknown error'}`);
    }

    return result;
  } catch (error) {
    logger.error(`[batchUpdateReadStatusLocally] Exception during batch update: ${error.message}`);
    throw error;
  }
}

module.exports = {
  getDatabase,
  saveEmailToDatabase,
  batchSaveEmailsToDatabase,
  batchUpdateReadStatusLocally,
  flushEmailBuffer,
  isEmailExists
};
