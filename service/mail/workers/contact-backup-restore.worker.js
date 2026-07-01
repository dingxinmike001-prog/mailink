/**
 * Contact backup restore Worker
 * Execute contact backup restore operations in Worker threads
 * Avoid blocking main process
 */
const { parentPort } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const Imap = require('imap');

// Add project root directory to module search path
const projectRoot = path.resolve(__dirname, '../../../');
require('module').Module.globalPaths.push(projectRoot);

// Import unified database module
const { UnifiedDB } = require('../../sqlite/sqlite-unified');
const pathUtils = require('../../../shared/path/path-utils');

// Backup email subject
const BACKUP_EMAIL_SUBJECT = 'mailink_bak_contacts';

// Retry config: IMAP concurrent connection limit may cause System busy! error
const RETRY_CONFIG = {
  maxRetries: 3,
  delays: [5000, 10000, 20000], // Increasing intervals: 5s → 10s → 20s
  retryableKeywords: ['System busy', 'Too many simultaneous', 'connection', 'ECONNRESET', 'ETIMEDOUT', 'rate limit']
};

/**
 * Determine whether error is retryable (temporary failure)
 * @param {Error|string} error - Error object or message
 * @returns {boolean}
 */
function isRetryableError(error) {
  const msg = (error?.message || String(error)).toLowerCase();
  return RETRY_CONFIG.retryableKeywords.some(keyword => msg.includes(keyword.toLowerCase()));
}

/**
 * Delay utility function
 * @param {number} ms - Delay milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Search contact backup emails
 * @param {Object} imap - IMAP connection instance
 * @param {string} username - Currently logged-in email address (used to verify sender)
 * @returns {Promise<Array>} Email UID list (reverse chronological order, newest first)
 */
async function searchBackupEmails(imap, username) {
  return new Promise((resolve, reject) => {
    // Search criteria: subject must be backup subject and sender must be currently logged-in user
    const searchCriteria = [
      ['SUBJECT', BACKUP_EMAIL_SUBJECT],
      ['FROM', username]
    ];

    imap.search(searchCriteria, (err, results) => {
      if (err) {
        reject(new Error(`Search backup emails failed: ${err.message}`));
      } else {
        const sortedResults = Array.isArray(results) ? results.sort((a, b) => b - a) : [];
        resolve(sortedResults);
      }
    });
  });
}

/**
 * Get email attachment information
 * @param {Object} imap - IMAP connection instance
 * @param {number} uid - Email UID
 * @returns {Promise<Object>} Email info including attachment list
 */
async function getEmailWithAttachments(imap, uid) {
  return new Promise((resolve, reject) => {
    const fetchOptions = {
      bodies: 'HEADER.FIELDS (FROM TO SUBJECT DATE)',
      struct: true
    };

    const f = imap.fetch([uid], fetchOptions);
    let emailInfo = null;

    f.on('message', (msg) => {
      msg.on('body', (stream) => {
        let buffer = '';
        stream.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
        });
        stream.on('end', () => {
          const headers = {};
          buffer.split('\n').forEach(line => {
            const match = line.match(/^([^:]+):\s*(.+)$/);
            if (match) {
              headers[match[1].toLowerCase()] = match[2].trim();
            }
          });
          emailInfo = { headers };
        });
      });

      msg.once('attributes', (attrs) => {
        const attachments = [];
        console.log('[ContactBackupRestore] Email structure:', JSON.stringify(attrs.struct, null, 2));
        
        const extractAttachments = (struct, prefix = '') => {
          if (!struct || !Array.isArray(struct)) return;
          for (let i = 0; i < struct.length; i++) {
            const part = struct[i];
            if (Array.isArray(part)) {
              extractAttachments(part, `${prefix}${i + 1}.`);
            } else if (part && typeof part === 'object') {
              console.log(`[ContactBackupRestore] Checking part: ${prefix}${i + 1}`, {
                type: part.type,
                subtype: part.subtype,
                partID: part.partID,
                disposition: part.disposition,
                params: part.params,
                encoding: part.encoding
              });
              
              // Stricter attachment detection
              const isAttachment = part.disposition?.type === 'attachment' ||
                                   (part.type !== 'TEXT' && part.type !== 'MULTIPART' && part.partID);
              
              if (isAttachment || (part.disposition && part.partID)) {
                const filename = part.disposition?.params?.filename ||
                                part.params?.name ||
                                `attachment_${part.partID}`;
                const attachmentInfo = {
                  partNum: part.partID,
                  filename: filename,
                  encoding: (part.encoding || 'BASE64').toUpperCase(),
                  size: part.size || 0,
                  contentType: `${part.type}/${part.subtype}`
                };
                console.log('[ContactBackupRestore] Attachment found:', attachmentInfo);
                attachments.push(attachmentInfo);
              }
            }
          }
        };
        extractAttachments(attrs.struct);
        console.log(`[ContactBackupRestore] Found ${attachments.length} attachment(s)`);
        
        if (emailInfo) {
          emailInfo.attachments = attachments;
          emailInfo.uid = uid;
          emailInfo.date = attrs.date;
        }
      });
    });

    f.once('error', (err) => {
      reject(new Error(`Get email info failed: ${err.message}`));
    });

    f.once('end', () => {
      resolve(emailInfo);
    });
  });
}

/**
 * Download the first attachment of an email
 * Reference implementation in project's imap-attachment-downloader-streaming.js
 * @param {Object} imap - IMAP connection instance
 * @param {number} uid - Email UID
 * @param {Object} attachment - Attachment info
 * @param {string} username - Username
 * @returns {Promise<string>} Attachment save path
 */
async function downloadAttachment(imap, uid, attachment, username) {
  return new Promise(async (resolve, reject) => {
    const saveDir = pathUtils.getUserAttachmentDir(username);
    const savePath = path.join(saveDir, `contact_backup_${Date.now()}.csv`);

    // Check and create directory asynchronously
    try {
      await fs.promises.access(saveDir, fs.constants.F_OK);
    } catch {
      // Directory does not exist, create it
      try {
        await fs.promises.mkdir(saveDir, { recursive: true });
      } catch (mkdirErr) {
        reject(new Error(`Create directory failed: ${mkdirErr.message}`));
        return;
      }
    }

    console.log(`[ContactBackupRestore] Start downloading attachment: partNum=${attachment.partNum}, encoding=${attachment.encoding}`);

    // node-imap bodies parameter only needs part ID, no BODY.PEEK prefix
    const f = imap.fetch([uid], {
      bodies: String(attachment.partNum),
      markSeen: false
    });

    let isResolved = false;
    let totalBytes = 0;

    const safeResolve = (result) => {
      if (!isResolved) {
        isResolved = true;
        resolve(result);
      }
    };

    const safeReject = (error) => {
      if (!isResolved) {
        isResolved = true;
        reject(error);
      }
    };

    f.on('message', (msg) => {
      msg.on('body', (stream, info) => {
        console.log(`[ContactBackupRestore] Received attachment stream, expected size: ${info.size || 'unknown'}`);

        const writeStream = fs.createWriteStream(savePath);
        let decodedBytes = 0;

        // Use simple Base64 decoding (line by line to avoid cross-chunk issues)
        if (attachment.encoding === 'BASE64' || attachment.encoding === 'B') {
          const { Transform } = require('stream');
          
          // Accumulation buffer
          let buffer = '';
          
          const decoder = new Transform({
            transform(chunk, encoding, callback) {
              // Convert chunk to string (Base64 is ASCII-safe)
              buffer += chunk.toString('ascii');
              
              // Process complete lines (separated by newlines)
              const lines = buffer.split('\r\n');
              // Keep last line (may be incomplete)
              buffer = lines.pop() || '';
              
              // Decode complete lines
              for (const line of lines) {
                if (line.trim()) {
                  try {
                    const decoded = Buffer.from(line, 'base64');
                    decodedBytes += decoded.length;
                    this.push(decoded);
                  } catch (e) {
                    console.warn(`[ContactBackupRestore] Base64 decode warning: ${e.message}`);
                  }
                }
              }
              
              callback();
            },
            flush(callback) {
              // Process remaining data
              if (buffer.trim()) {
                try {
                  const decoded = Buffer.from(buffer, 'base64');
                  decodedBytes += decoded.length;
                  this.push(decoded);
                } catch (e) {
                  console.warn(`[ContactBackupRestore] Base64 decode warning (remaining): ${e.message}`);
                }
              }
              console.log(`[ContactBackupRestore] Base64 decode completed, decoded size: ${decodedBytes} bytes`);
              callback();
            }
          });

          stream.pipe(decoder).pipe(writeStream);
        } else {
          // Non-Base64 encoding, write directly
          stream.pipe(writeStream);
        }

        writeStream.on('finish', async () => {
          try {
            const stats = await fs.promises.stat(savePath);
            console.log(`[ContactBackupRestore] Attachment download completed: ${savePath}, size: ${stats.size} bytes`);

            if (stats.size === 0) {
              safeReject(new Error('Downloaded attachment file size is 0'));
            } else {
              safeResolve(savePath);
            }
          } catch (err) {
            safeReject(new Error(`Check file failed: ${err.message}`));
          }
        });

        writeStream.on('error', (err) => {
          safeReject(new Error(`Write attachment failed: ${err.message}`));
        });

        stream.on('error', (err) => {
          safeReject(new Error(`Read attachment stream failed: ${err.message}`));
        });
      });
    });

    f.once('error', (err) => {
      safeReject(new Error(`Download attachment failed: ${err.message}`));
    });
  });
}

/**
 * Parse CSV file content
 * @param {string} csvContent - CSV file content
 * @returns {Array} Contact object array
 */
function parseCSV(csvContent) {
  const contacts = [];
  const lines = csvContent.split('\n');

  // Find header row (skip comment rows)
  let headerLine = '';
  let dataStartIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line && !line.startsWith('#')) {
      headerLine = line;
      dataStartIndex = i + 1;
      break;
    }
  }

  if (!headerLine) {
    return contacts;
  }

  // Parse header
  const headers = parseCSVLine(headerLine);

  // Parse data rows
  for (let i = dataStartIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const values = parseCSVLine(line);
    const contact = {};

    headers.forEach((header, idx) => {
      contact[header] = values[idx] || '';
    });

    // Only add contacts with username
    if (contact.username) {
      contacts.push(contact);
    }
  }

  return contacts;
}

/**
 * Parse a single CSV line (handle quotes, commas, etc.)
 * @param {string} line - CSV line
 * @returns {Array} Field array
 */
function parseCSVLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped double quote
        current += '"';
        i++;
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  // Add last value
  values.push(current);

  return values;
}

/**
 * Merge contacts into database
 * @param {string} dbPath - Database path
 * @param {Array} contacts - Contact object array
 * @returns {Promise<Object>} Merge result {added: number, updated: number, skipped: number}
 */
async function mergeContactsToDatabase(dbPath, contacts) {
  const result = { added: 0, updated: 0, skipped: 0, errors: [] };

  if (!contacts || contacts.length === 0) {
    return result;
  }

  try {
    // Get existing contacts (including id, status, and updatetime)
    const existingContacts = await UnifiedDB.query(dbPath,
      'SELECT id, username, status, updatetime FROM contact WHERE username IS NOT NULL AND username != \'\''
    );
    const existingMap = new Map();
    existingContacts.forEach(c => {
      const email = c.username?.toLowerCase().trim();
      if (email) {
        existingMap.set(email, c);
      }
    });

    const newContacts = [];
    const updateContacts = [];

    for (const contact of contacts) {
      const email = contact.username?.toLowerCase().trim();
      if (!email) {
        result.skipped++;
        continue;
      }

      const existing = existingMap.get(email);
      if (existing) {
        // For existing contacts, check whether CSV updatetime is greater than database updatetime
        const csvUpdatetime = parseInt(contact.updatetime, 10) || 0;
        const dbUpdatetime = parseInt(existing.updatetime, 10) || 0;

        if (csvUpdatetime > dbUpdatetime) {
          // CSV time is newer, need to update all contact fields
          updateContacts.push({
            id: existing.id,
            email: email,
            contact: contact
          });
        } else {
          result.skipped++;
        }
      } else {
        // New contact
        newContacts.push(contact);
      }
    }

    // Insert new contact
    if (newContacts.length > 0) {
      const insertPromises = newContacts.map(contact => {
        // Use avgray value to fill avatar field
        const avatarValue = contact.avgray || '';
        const statusValue = parseInt(contact.status, 10) || 0;
        // Use updatetime from CSV, fallback to current time if absent
        const updatetimeValue = parseInt(contact.updatetime, 10) || Date.now();

        return UnifiedDB.execute(dbPath,
          `INSERT INTO contact (nickname, rmkname, username, avatar, avgray, status, updatetime) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            contact.nickname || '',
            contact.rmkname || '',
            contact.username || '',
            avatarValue,
            contact.avgray || '',
            statusValue,
            updatetimeValue
          ]
        ).then(() => {
          result.added++;
        }).catch(err => {
          result.errors.push({ email: contact.username, error: err.message });
        });
      });

      await Promise.all(insertPromises);
    }

    // Update all fields of existing contact
    if (updateContacts.length > 0) {
      const updatePromises = updateContacts.map(item => {
        const contact = item.contact;
        const avatarValue = contact.avgray || '';
        const statusValue = parseInt(contact.status, 10) || 0;
        const updatetimeValue = parseInt(contact.updatetime, 10) || Date.now();

        return UnifiedDB.execute(dbPath,
          `UPDATE contact SET nickname = ?, rmkname = ?, username = ?, avatar = ?, avgray = ?, status = ?, updatetime = ? WHERE id = ?`,
          [
            contact.nickname || '',
            contact.rmkname || '',
            contact.username || '',
            avatarValue,
            contact.avgray || '',
            statusValue,
            updatetimeValue,
            item.id
          ]
        ).then(() => {
          result.updated++;
        }).catch(err => {
          result.errors.push({ email: item.email, error: err.message });
        });
      });

      await Promise.all(updatePromises);
    }

    return result;
  } catch (error) {
    throw new Error(`Merge contacts failed: ${error.message}`);
  }
}

/**
 * Move emails to specified folder (for Gmail and other special handling)
 * @param {Object} imap - IMAP connection instance
 * @param {Array<number>} uids - Email UID list to move
 * @param {string} targetFolder - Target folder name
 * @returns {Promise<number>} Number of moved emails
 */
async function moveEmailsToFolder(imap, uids, targetFolder) {
  return new Promise((resolve, reject) => {
    if (!uids || uids.length === 0) {
      resolve(0);
      return;
    }

    console.log(`[ContactBackupRestore] Move ${uids.length} email(s) to folder: ${targetFolder}`);

    imap.move(uids, targetFolder, (err) => {
      if (err) {
        reject(new Error(`Move emails to ${targetFolder} failed: ${err.message}`));
        return;
      }
      console.log(`[ContactBackupRestore] Successfully moved ${uids.length} email(s) to ${targetFolder}`);
      resolve(uids.length);
    });
  });
}

/**
 * Detect whether it is a Gmail mailbox
 * @param {string} host - IMAP server hostname
 * @param {string} username - Email username
 * @returns {boolean}
 */
function isGmail(host, username) {
  const gmailHosts = ['imap.gmail.com', 'gmail.com', 'googlemail.com'];
  const isGmailHost = gmailHosts.some(gmailHost => host.toLowerCase().includes(gmailHost));
  const isGmailAddress = username.toLowerCase().endsWith('@gmail.com') || username.toLowerCase().endsWith('@googlemail.com');
  return isGmailHost || isGmailAddress;
}

/**
 * Delete emails by UID (supports Gmail double-delete)
 * @param {Object} imap - IMAP connection instance
 * @param {Array<number>} uids - Email UID list to delete
 * @param {Object} config - IMAP config {host, username}
 * @returns {Promise<number>} Number of deleted emails
 */
async function deleteEmails(imap, uids, config) {
  return new Promise((resolve, reject) => {
    if (!uids || uids.length === 0) {
      resolve(0);
      return;
    }

    const isGmailAccount = isGmail(config.host, config.username);
    console.log(`[ContactBackupRestore] Delete emails, is Gmail: ${isGmailAccount}, UIDs: [${uids.join(',')}]`);

    // Add delete flag
    imap.addFlags(uids, '\\Deleted', (err) => {
      if (err) {
        reject(new Error(`Mark emails as deleted failed: ${err.message}`));
        return;
      }

      // Execute permanent delete
      imap.expunge((expungeErr) => {
        if (expungeErr) {
          reject(new Error(`Permanently delete emails failed: ${expungeErr.message}`));
          return;
        }
        console.log(`[ContactBackupRestore] Successfully deleted ${uids.length} email(s), UIDs: [${uids.join(',')}]`);

        // Gmail double insurance: additionally move to "Deleted Items" folder
        if (isGmailAccount) {
          console.log(`[ContactBackupRestore] Gmail account, double-delete safeguard: move to deleted items folder`);
          // Gmail's deleted items folder may be "[Gmail]/Trash" or "[Google Mail]/Trash"
          const trashFolders = ['[Gmail]/Trash', '[Google Mail]/Trash', 'Trash', 'Deleted Messages'];

          // Try moving to an existing folder
          let moved = false;
          for (const trashFolder of trashFolders) {
            try {
              moveEmailsToFolder(imap, uids, trashFolder).then(() => {
                console.log(`[ContactBackupRestore] Gmail double-delete succeeded: emails moved to ${trashFolder}`);
              }).catch((moveErr) => {
                console.warn(`[ContactBackupRestore] Move to ${trashFolder} failed: ${moveErr.message}`);
              });
              moved = true;
              break;
            } catch (e) {
              // continue trying next folder
            }
          }

          if (!moved) {
            console.warn(`[ContactBackupRestore] Gmail double-delete: failed to move to any deleted items folder`);
          }
        }

        resolve(uids.length);
      });
    });
  });
}

/**
 * Restore contact backup (single execution, no retry logic)
 * @param {Object} config - IMAP config
 * @returns {Promise<Object>} Restore result
 */
async function restoreContactBackupOnce(config) {
  const result = {
    success: false,
    message: '',
    emailFound: false,
    attachmentDownloaded: false,
    contactsMerged: false,
    added: 0,
    updated: 0,
    skipped: 0,
    deleted: 0
  };

  let imap = null;
  let attachmentPath = null;

  try {
    // Create IMAP connection
    imap = new Imap({
      user: config.username,
      password: config.password,
      host: config.host,
      port: config.port,
      tls: config.tls,
      tlsOptions: { rejectUnauthorized: false }
    });

    // Connect to IMAP
    await new Promise((resolve, reject) => {
      imap.once('ready', resolve);
      imap.once('error', reject);
      imap.connect();
    });

    // Open mailink_info folder
    await new Promise((resolve, reject) => {
      imap.openBox('mailink_info', false, (err, box) => {
        if (err) reject(err);
        else resolve(box);
      });
    });

    // 1. Search backup emails (sender must be currently logged-in user)
    const backupUids = await searchBackupEmails(imap, config.username);

    if (!backupUids || backupUids.length === 0) {
      result.message = 'No contact backup email found';
      imap.end();
      return result;
    }

    result.emailFound = true;
    console.log(`[ContactBackupRestore] Found ${backupUids.length} backup email(s), UIDs: [${backupUids.join(',')}]`);

    // Get latest 4 emails
    const latest4Uids = backupUids.slice(0, 4);
    console.log(`[ContactBackupRestore] Take latest 4 emails, UIDs: [${latest4Uids.join(',')}]`);

    // Keep latest 2, delete extras (3rd, 4th, and older)
    const uidsToKeep = latest4Uids.slice(0, 2);
    const uidsToDelete = backupUids.slice(2); // 3rd and older

    console.log(`[ContactBackupRestore] Keep latest 2 emails, UIDs: [${uidsToKeep.join(',')}]`);
    console.log(`[ContactBackupRestore] Prepare to delete ${uidsToDelete.length} old email(s), UIDs: [${uidsToDelete.join(',')}]`);

    // Delete extra emails
    if (uidsToDelete.length > 0) {
      try {
        result.deleted = await deleteEmails(imap, uidsToDelete, config);
        console.log(`[ContactBackupRestore] Successfully deleted ${result.deleted} old backup email(s)`);
      } catch (deleteErr) {
        console.warn(`[ContactBackupRestore] Delete old emails failed (non-blocking): ${deleteErr.message}`);
        // delete failure does not affect recovery flow，continue execution
      }
    }

    // Use latest email (1st) to download attachment
    const latestUid = uidsToKeep[0];
    console.log(`[ContactBackupRestore] Use latest email UID=${latestUid} to download attachment`);

    // 2. Get email attachment info
    const emailInfo = await getEmailWithAttachments(imap, latestUid);

    if (!emailInfo || !emailInfo.attachments || emailInfo.attachments.length === 0) {
      result.message = 'No attachment in backup email';
      imap.end();
      return result;
    }

    // 3. Download attachment - prefer .csv files
    let targetAttachment = emailInfo.attachments[0];

    // Find attachment with .csv suffix (real backup file)
    const csvAttachment = emailInfo.attachments.find(att =>
      att.filename && att.filename.toLowerCase().endsWith('.csv')
    );

    if (csvAttachment) {
      targetAttachment = csvAttachment;
      console.log(`[ContactBackupRestore] Select CSV backup file: ${targetAttachment.filename}`);
    } else {
      console.log(`[ContactBackupRestore] CSV file not found, use first attachment: ${targetAttachment.filename}`);
    }

    attachmentPath = await downloadAttachment(imap, latestUid, targetAttachment, config.username);
    result.attachmentDownloaded = true;

    // Close IMAP connection
    imap.end();

    // 4. Read and parse CSV file
    const csvContent = await fsPromises.readFile(attachmentPath, 'utf-8');
    const contacts = parseCSV(csvContent);

    // 5. Merge into database
    const dbPath = pathUtils.getUserDbPath(config.username);
    const mergeResult = await mergeContactsToDatabase(dbPath, contacts);

    result.contactsMerged = true;
    result.added = mergeResult.added;
    result.updated = mergeResult.updated;
    result.skipped = mergeResult.skipped;
    result.success = true;
    result.message = `Contacts restored successfully: added ${mergeResult.added}, updated ${mergeResult.updated}, skipped ${mergeResult.skipped}${result.deleted > 0 ? `, cleaned old backups ${result.deleted}` : ''}`;

    // Keep temporary file for testing/viewing
    console.log(`[ContactBackupRestore] Keep temporary file for testing: ${attachmentPath}`);

    return result;

  } catch (error) {
    result.message = `Restore failed: ${error.message}`;

    if (imap) {
      try { imap.end(); } catch (e) {}
    }

    // Keep temporary file for testing/viewing (keep even if failed)
    if (attachmentPath) {
      console.log(`[ContactBackupRestore] Restore failed, keep temporary file for debugging: ${attachmentPath}`);
    }

    // Attach original error to result for retry logic to judge
    result._error = error;
    return result;
  }
}

/**
 * Restore contact backup (with retry logic)
 * For temporary errors like System busy! caused by IMAP concurrent connection limits, retry with increasing intervals
 * @param {Object} params - Restore parameters {config}
 * @returns {Promise<Object>} Restore result
 */
async function restoreContactBackup(params) {
  const { config } = params;
  let lastResult = null;

  for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    // On non-first attempts, wait with increasing interval (wait for main connection to release IMAP resources)
    if (attempt > 0) {
      const delay = RETRY_CONFIG.delays[attempt - 1] || RETRY_CONFIG.delays[RETRY_CONFIG.delays.length - 1];
      console.log(`[ContactBackupRestore] Retry attempt ${attempt}, wait ${delay / 1000}s...`);
      await sleep(delay);
    }

    lastResult = await restoreContactBackupOnce(config);

    // Return directly on success or non-retryable error
    if (lastResult.success || !isRetryableError(lastResult._error)) {
      if (attempt > 0 && lastResult.success) {
        console.log(`[ContactBackupRestore] Retry attempt ${attempt} succeeded`);
      }
      // Clean internal fields
      delete lastResult._error;
      return lastResult;
    }

    console.log(`[ContactBackupRestore] Attempt ${attempt + 1} failed (retryable error: ${lastResult._error?.message}), ${attempt < RETRY_CONFIG.maxRetries ? 'will retry' : 'max retries reached'}`);
  }

  // All retries exhausted, clean internal fields and return
  delete lastResult._error;
  return lastResult;
}

// Listen to messages from the main thread
parentPort.on('message', async ({ id, taskType, params }) => {
  try {
    let data;
    if (taskType === 'restore-contacts') {
      data = await restoreContactBackup(params);
    } else {
      throw new Error(`Unknown task type: ${taskType}`);
    }
    parentPort.postMessage({ id, success: true, data });
  } catch (error) {
    parentPort.postMessage({
      id,
      success: false,
      error: error.message
    });
  }
});
