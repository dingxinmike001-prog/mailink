const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const { UnifiedDB } = require('./sqlite-unified');
const { DBLogger } = require('./db-logger');
const logger = require('../logger');

// Import path utility module
const pathUtils = require('../../shared/path/path-utils');

// Import IPC manager
const { registerHandler } = require('../../shared/ipc/ipc-manager');

// Import the IMAP flag sync service
const { syncReadStatusToServer, batchSyncReadStatusToServer } = require('../mail/imap-flags-sync');

// Import the JSON Processor Manager for large data processing
const jsonProcessor = require('../workers/json-processor-manager');

// Import the SQLite batch operation manager
const { getInstance: getBatchManager } = require('./sqlite-batch-manager');

// Import the contact backup module
const { backupContacts } = require('../mail/contact-backup');

// ========== Auto-backup contact changes (debounced) ==========
const _contactBackupTimers = new Map(); // username -> timer
const _CONTACT_BACKUP_DEBOUNCE_MS = 3000; // 3-second debounce

/**
 * Get the user's SMTP config from config.db
 * @param {string} username - user email
 * @returns {Promise<Object|null>} SMTP config object, or null
 */
async function _getSmtpConfigForUser(username) {
  try {
    const configDbPath = pathUtils.getConfigDbPath();
    const rows = await UnifiedDB.query(configDbPath,
      'SELECT smtpHost, smtpPort, username, password, tls FROM email WHERE username = ?',
      [username]
    );
    if (!rows || rows.length === 0) return null;
    const row = rows[0];
    return {
      host: row.smtpHost,
      port: row.smtpPort,
      secure: row.smtpPort === 465,
      username: row.username,
      password: row.password
    };
  } catch (err) {
    logger.warn(`[ContactAutoBackup] Failed to get SMTP config: ${err.message}`);
    return null;
  }
}

/**
 * Debounced trigger for contact backup
 * Multiple contact changes within a short time only trigger one backup, non-blocking, does not affect main operations
 * @param {string} username - user email
 */
function _scheduleContactBackup(username) {
  // Clear existing timer
  if (_contactBackupTimers.has(username)) {
    clearTimeout(_contactBackupTimers.get(username));
  }

  const timer = setTimeout(async () => {
    _contactBackupTimers.delete(username);
    try {
      const smtpConfig = await _getSmtpConfigForUser(username);
      if (!smtpConfig) {
        logger.warn(`[ContactAutoBackup] No SMTP config, skipping auto backup: ${username}`);
        return;
      }
      logger.info(`[ContactAutoBackup] Starting contact auto backup: ${username}`);
      const result = await backupContacts(username, smtpConfig);
      if (result.success) {
        logger.info(`[ContactAutoBackup] Auto backup completed: ${result.message}`);
      } else {
        logger.warn(`[ContactAutoBackup] Auto backup failed: ${result.error}`);
      }
    } catch (err) {
      logger.warn(`[ContactAutoBackup] Auto backup exception (non-blocking): ${err.message}`);
    }
  }, _CONTACT_BACKUP_DEBOUNCE_MS);

  _contactBackupTimers.set(username, timer);
}

/**
 * Parse split email fields from row data (attachments and headers are JSON TEXT)
 * @param {Object} row - email row data (contains txtbody, htmbody, attachments, headers, priority)
 * @returns {Object} parsed object { text, html, attachments, headers, priority }
 */
function parseSplitFields(row) {
  let attachments = [];
  let headers = {};

  // Parse attachments JSON
  if (row.attachments && typeof row.attachments === 'string') {
    try {
      attachments = JSON.parse(row.attachments);
    } catch (e) {
      attachments = [];
    }
  } else if (Array.isArray(row.attachments)) {
    attachments = row.attachments;
  }

  // Parse headers JSON
  if (row.headers && typeof row.headers === 'string') {
    try {
      headers = JSON.parse(row.headers);
    } catch (e) {
      headers = {};
    }
  } else if (row.headers && typeof row.headers === 'object') {
    headers = row.headers;
  }

  return {
    text: row.txtbody || '',
    html: row.htmbody || '',
    attachments,
    headers,
    priority: row.priority || ''
  };
}

/**
 * Batch parse split email fields
 * @param {Array} rows - email row data
 * @returns {Array} parsed row data
 */
function parseSplitFieldsInBatches(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return rows;
  }
  return rows.map(row => ({
    ...row,
    _parsed: parseSplitFields(row)
  }));
}

/**
 * Check whether table exists
 * @param {string} dbPath - database file path
 * @param {string} tableName - table name
 * @returns {Promise<boolean>} - whether it exists
 */
async function tableExists(dbPath, tableName) {
  try {
    const result = await UnifiedDB.get(dbPath, 
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      [tableName]
    );
    return !!result;
  } catch (error) {
    logger.error(`[tableExists] Error checking table ${tableName}: ${error.message}`);
    return false;
  }
}



/**
 * Ensure database table structure exists(with retry and verification mechanism)
 * Key improvement: Batch execute all table creation commands on a single connection, avoid SQLite multi-connection isolation issues
 * @param {string} dbPath - database file path
 * @param {number} maxRetries - max retry count
 */
async function ensureDatabaseSchema(dbPath, maxRetries = 3) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Ensure the directory for the database file exists (async)
      const dbDir = path.dirname(dbPath);
      try {
        await fsPromises.mkdir(dbDir, { recursive: true });
        logger.info(`[ensureDatabaseSchema] Created database directory: ${dbDir}`);
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }

      // Build the array of all table creation commands (executed on a single connection)
      const createTableCommands = [
        // recv table
        {
          sql: `CREATE TABLE IF NOT EXISTS recv (
            id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
            txtbody TEXT NOT NULL DEFAULT '',
            htmbody TEXT NOT NULL DEFAULT '',
            attachments TEXT NOT NULL DEFAULT '[]',
            headers TEXT NOT NULL DEFAULT '{}',
            priority TEXT NOT NULL DEFAULT '',
            createtime integer NOT NULL DEFAULT 0,
            message_id TEXT NOT NULL DEFAULT '',
            imap_uid TEXT NOT NULL DEFAULT '',
            subject TEXT NOT NULL DEFAULT '',
            sender TEXT NOT NULL DEFAULT '',
            recipient TEXT NOT NULL DEFAULT '',
            received_time integer NOT NULL DEFAULT 0,
            is_signaling INTEGER NOT NULL DEFAULT 0,
            is_read INTEGER NOT NULL DEFAULT 0
          )`
        },
        // recv table indexes
        { sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_recv_message_id_unique ON recv(message_id) WHERE message_id != ''` },
        { sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_recv_imap_uid_unique ON recv(imap_uid) WHERE imap_uid != ''` },
        { sql: `CREATE INDEX IF NOT EXISTS idx_recv_sender ON recv(sender)` },
        { sql: `CREATE INDEX IF NOT EXISTS idx_recv_received_time ON recv(received_time)` },
        { sql: `CREATE INDEX IF NOT EXISTS idx_recv_is_signaling ON recv(is_signaling)` },
        
        // send table
        {
          sql: `CREATE TABLE IF NOT EXISTS send (
            id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
            txtbody TEXT NOT NULL DEFAULT '',
            htmbody TEXT NOT NULL DEFAULT '',
            attachments TEXT NOT NULL DEFAULT '[]',
            headers TEXT NOT NULL DEFAULT '{}',
            priority TEXT NOT NULL DEFAULT '',
            createtime integer NOT NULL DEFAULT 0
          )`
        },
        
        // message table
        {
          sql: `CREATE TABLE IF NOT EXISTS message (
            id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
            msgid TEXT NOT NULL DEFAULT '',
            emid TEXT NOT NULL DEFAULT '',
            fromer TEXT NOT NULL DEFAULT '',
            toer TEXT NOT NULL DEFAULT '',
            content TEXT DEFAULT '',
            createtime integer NOT NULL DEFAULT 0,
            type integer NOT NULL DEFAULT 0,
            status integer NOT NULL DEFAULT 0,
            is_read integer NOT NULL DEFAULT 0,
            read_time integer NOT NULL DEFAULT 0
          )`
        },
        { sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_message_unique_msgid ON message(fromer, toer, msgid) WHERE msgid <> ''` },
        { sql: `CREATE INDEX IF NOT EXISTS idx_message_emid ON message(emid) WHERE emid <> ''` },
        
        // contact table (critical table, previously error-prone location)
        {
          sql: `CREATE TABLE IF NOT EXISTS contact (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nickname TEXT NOT NULL,
            rmkname TEXT NOT NULL DEFAULT '',
            username TEXT NOT NULL,
            avatar TEXT NOT NULL DEFAULT '',
            avgray TEXT NOT NULL DEFAULT '',
            status INTEGER NOT NULL DEFAULT 20,
            updatetime INTEGER NOT NULL DEFAULT 0,
            msgtime INTEGER NOT NULL DEFAULT 0,
            UNIQUE (username ASC)
          )`
        },
        
        // signaling_cache table
        {
          sql: `CREATE TABLE IF NOT EXISTS signaling_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cache_name TEXT NOT NULL,
            email_id TEXT NOT NULL,
            last_access_time INTEGER NOT NULL,
            created_time INTEGER NOT NULL,
            UNIQUE (cache_name, email_id)
          )`
        },
        { sql: `CREATE INDEX IF NOT EXISTS idx_signaling_cache_name ON signaling_cache(cache_name)` },
        { sql: `CREATE INDEX IF NOT EXISTS idx_signaling_cache_lru ON signaling_cache(cache_name, last_access_time)` },
        
        // transfer_metadata table
        {
          sql: `CREATE TABLE IF NOT EXISTS transfer_metadata (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            msg_id TEXT NOT NULL,
            file_name TEXT NOT NULL,
            file_path TEXT NOT NULL DEFAULT '',
            total_size INTEGER NOT NULL DEFAULT 0,
            received_size INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending',
            metadata TEXT,
            createtime INTEGER NOT NULL DEFAULT 0,
            UNIQUE (msg_id, file_name)
          )`
        },
        { sql: `CREATE INDEX IF NOT EXISTS idx_transfer_status ON transfer_metadata(status)` }
      ];

      // Batch execute all commands on a single connection
      logger.info(`[ensureDatabaseSchema] Starting batch creation of database tables for: ${dbPath}`);
      const results = await UnifiedDB.executeBatch(dbPath, createTableCommands);
      
      // Check batch execution results
      let failedCommands = 0;
      for (let i = 0; i < results.length; i++) {
        if (!results[i].success) {
          failedCommands++;
          logger.warn(`[ensureDatabaseSchema] Command ${i + 1} failed: ${results[i].error}`);
        }
      }
      
      if (failedCommands > 0) {
        logger.warn(`[ensureDatabaseSchema] ${failedCommands} out of ${results.length} commands failed`);
      }

      // Wait for database operations to fully sync (critical: ensure data is written to disk)
      // SQLite WAL mode needs this delay so new connections can see created tables
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify that critical tables were actually created
      const requiredTables = ['recv', 'send', 'message', 'contact', 'signaling_cache', 'transfer_metadata'];
      const missingTables = [];
      
      for (const tableName of requiredTables) {
        const exists = await tableExists(dbPath, tableName);
        if (!exists) {
          missingTables.push(tableName);
        }
      }
      
      if (missingTables.length > 0) {
        throw new Error(`Tables not created successfully: ${missingTables.join(', ')}`);
      }

      logger.info(`[ensureDatabaseSchema] Database schema successfully ensured for: ${dbPath} (attempt ${attempt}/${maxRetries})`);
      return; // Success, return directly
      
    } catch (error) {
      lastError = error;
      logger.warn(`[ensureDatabaseSchema] Attempt ${attempt}/${maxRetries} failed: ${error.message}`);
      
      if (attempt < maxRetries) {
        const delay = attempt * 500; // Incremental delay: 500ms, 1000ms, 1500ms
        logger.info(`[ensureDatabaseSchema] Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  // All retries failed
  logger.error(`[ensureDatabaseSchema] All ${maxRetries} attempts failed: ${lastError.message}`);
  throw lastError;
}

// Close all connections when app quits
app.on('quit', async () => {
  try {
    // Flush all pending batch operation buffers
    logger.info('[SQLite] Flushing all pending batch operations before shutdown...');
    const batchManager = getBatchManager();
    await batchManager.closeAllWorkers();
    logger.info('[SQLite] All batch operations flushed successfully');
  } catch (error) {
    logger.error(`[SQLite] Error flushing batch operations: ${error.message}`);
  }

  try {
    // Close all database connections
    await UnifiedDB.closeAllConnections();
    logger.info('[SQLite] All database connections closed');
  } catch (error) {
    logger.error(`[SQLite] Error closing database connections: ${error.message}`);
  }
});



// IPC handler: check and create database file
registerHandler('checkAndCreateDatabase', async (event, emailUsername) => {
  // First asynchronously create all directory structures needed by the user
  const dirs = await pathUtils.createUserDirectoriesAsync(emailUsername);
  logger.info(`[checkAndCreateDatabase] User directories created/verified for ${emailUsername}:`, dirs);

  // Use userData directory to match imap-database.js
  const dbPath = pathUtils.getUserDbPath(emailUsername);
  const dbFilename = path.basename(dbPath);

  // Check if database file exists (asynchronous)
  let fileExists = false;
  try {
    await fsPromises.access(dbPath);
    fileExists = true;
  } catch {
    fileExists = false;
  }

  // Ensure database table structure exists
  await ensureDatabaseSchema(dbPath);

  return {
    filename: dbFilename,
    path: dbPath,
    created: !fileExists,
    directories: dirs
  };
});

// IPC handler: save chat message
registerHandler('save-chat-message', async (event, { fromer, toer, content, type, status, msgid, emid }) => {
  logger.info(`[save-chat-message] Params: fromer=${fromer}, toer=${toer}, type=${type}, status=${status}, msgid=${msgid}, emid=${emid}`);

  const currentUserEmail = type === 1 ? fromer : toer;
  const dbPath = pathUtils.getUserDbPath(currentUserEmail);
  const dbFilename = path.basename(dbPath);

  const dbLogger = DBLogger.getInstance(currentUserEmail);

  const nowMs = BigInt(Date.now());
  const hrTime = process.hrtime.bigint();
  const createtime = (nowMs * 1000000n + (hrTime % 1000000n)).toString();

  dbLogger.logSaveMessage(dbPath, fromer, content.length);

  // 1. Check for existing message with same msgid
  let existingMessage = null;
  if (msgid) {
    existingMessage = await UnifiedDB.withORM(dbPath, async (orm) => {
      const table = await orm.table('message');
      // Check all message types, not just type=2
      // Check the full message context: msgid + (fromer && toer)
      let where = await table.where({ msgid });
      // Add fromer and toer checks to ensure it is the same message
      if (fromer) where = await where.where('fromer = ?', fromer);
      if (toer) where = await where.where('toer = ?', toer);
      return await where.find();
    });
  }

  if (existingMessage) {
    await UnifiedDB.withORM(dbPath, async (orm) => {
      const table = await orm.table('message');
      await table.update(existingMessage.id, {
        content,
        status: status || existingMessage.status,
      });
    });

    dbLogger.log(`[${dbPath}]Message updated successfully.ID: ${existingMessage.id}`);
    logger.info(`[save-chat-message] Updated existing message: id=${existingMessage.id}, fromer=${fromer}, toer=${toer}`);
    return {
      id: existingMessage.id,
      dbName: dbFilename,
      tableName: 'message',
      updated: true
    };
  } else {
    const is_read = type === 1 ? 1 : 0;
    const newMessage = {
      fromer,
      toer: toer || '',
      content,
      createtime,
      type,
      status: status || 0,
      msgid: msgid || '',
      emid: emid || '',
      is_read,
      read_time: 0
    };

    const newId = await UnifiedDB.withORM(dbPath, async (orm) => {
      const table = await orm.table('message');
      return await table.insertGetId(newMessage);
    });

    // Update the contact's msgtime field
    try {
      const contactEmail = type === 1 ? toer : fromer;
      if (contactEmail) {
        await UnifiedDB.withORM(dbPath, async (orm) => {
          return await orm.table('contact')
            .whereRaw('lower(username) = lower(?)', [contactEmail])
            .update({ msgtime: createtime });
        });
        logger.info(`[save-chat-message] Updated contact msgtime: contact=${contactEmail}, msgtime=${createtime}`);
      }
    } catch (contactError) {
      logger.warn(`[save-chat-message] Failed to update contact msgtime: ${contactError.message}`);
    }

    dbLogger.log(`[${dbPath}]Message saved successfully.ID: ${newId}`);
    logger.info(`[save-chat-message] Inserted new message: id=${newId}, fromer=${fromer}, toer=${toer}, status=${status}, dbPath=${dbPath}`);
    return {
      id: newId,
      dbName: dbFilename,
      tableName: 'message'
    };
  }
});

// IPC handler: Get unsent messages
// Status values: 0 = unsent, 50 = sending (awaiting ACK), 100 = confirmed
registerHandler('get-unsent-messages', async (event, { fromer, toer }) => {
  const dbPath = pathUtils.getUserDbPath(fromer);
  logger.info(`[get-unsent-messages] Query params: fromer=${fromer}, toer=${toer}, dbPath=${dbPath}`);

  const rows = await UnifiedDB.withORM(dbPath, async (orm) => {
    return await orm.table('message')
      .where({ fromer, toer })
      .whereLt('status', 100)
      .order('createtime ASC')
      .select();
  });
  logger.info(`[get-unsent-messages] Result count: ${rows.length}, dbPath=${dbPath}`);
  return rows;
});

// IPC handler: Get pending image messages for WebRTC signaling
// Status values: 0 = unsent, 50 = sending (awaiting ACK), 100 = confirmed
// This is used to attach pending images to WebRTC signaling emails
registerHandler('get-pending-images', async (event, { fromer, toer }) => {
  const dbPath = pathUtils.getUserDbPath(fromer);

  const rows = await UnifiedDB.withORM(dbPath, async (orm) => {
    return await orm.table('message')
      .where({ fromer, toer })
      .whereLt('status', 100)
      .where(function() {
        this.whereLike('content', '%image-message%')
            .orWhereLike('content', '%image-file-display%');
      })
      .order('createtime ASC')
      .select();
  });
  logger.debug(`get-pending-images result count: ${rows.length}`);
  
  // Extract image metadata from content
  const imageMessages = rows.map(row => {
    try {
      const content = row.content || '';
      let imageId = row.msgid;
      let filename = 'image.png';
      
      const componentOfferMatch = content.match(/offer="([^"]+)"/);
      
      if (componentOfferMatch) {
        try {
          const offerJson = componentOfferMatch[1]
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&');
          const offer = JSON.parse(offerJson);
          imageId = offer.id || row.msgid;
          filename = offer.filename || 'image.png';
        } catch (e) {
          logger.warn(`Failed to parse offer JSON: ${e.message}`);
        }
      }
      
      return {
        ...row,
        imageId,
        filename
      };
    } catch (e) {
      return row;
    }
  });
  
  return imageMessages;
});

// IPC handler: Update message status
registerHandler('update-message-status', async (event, { id, msgid, status, fromer, dbUser }) => {
  // Prefer dbUser (explicitly specifies database owner), otherwise fall back to fromer
  const owner = dbUser || fromer;
  const dbPath = pathUtils.getUserDbPath(owner);

  // Get the database logger instance
  const dbLogger = DBLogger.getInstance(owner);

  let changes = 0;
  await UnifiedDB.withORM(dbPath, async (orm) => {
    if (msgid) {
      changes = await orm.table('message')
        .where({ msgid, fromer })
        .update({ status });
    } else {
      changes = await orm.table('message')
        .where({ id })
        .update({ status });
    }
  });

  dbLogger.log(`[${dbPath}]Message status updated.${msgid ? 'MsgID: ' + msgid : 'ID: ' + id}, Status: ${status}`);
  return { changes };
});

// IPC handler: Update message content
registerHandler('update-chat-message-content', async (event, { msgid, fromer, toer, content, dbUser }) => {
  const owner = dbUser || fromer;
  const dbPath = pathUtils.getUserDbPath(owner);
  const dbLogger = DBLogger.getInstance(owner);

  dbLogger.log(`[update-chat-message-content] Starting to update message content: msgid=${msgid}, fromer=${fromer}, toer=${toer}, dbUser=${dbUser}`);
  dbLogger.log(`[update-chat-message-content] Message content length: ${content?.length || 0}`);
  dbLogger.log(`[update-chat-message-content] First 200 characters of message content: ${content?.substring(0, 200) || 'empty'}`);

  const checkSql = `SELECT id FROM message WHERE msgid = ? AND fromer = ? LIMIT 1`;
  const existingRows = await UnifiedDB.query(dbPath, checkSql, [msgid, fromer]);

  dbLogger.log(`[update-chat-message-content] Query existing message result: rows=${existingRows.length}`);
  if (existingRows.length === 0) {
    dbLogger.log(`[update-chat-message-content] ❌ Message not found, cannot update: msgid=${msgid}, fromer=${fromer}`);
    return { changes: 0, error: 'Message not found' };
  }

  const sql = `UPDATE message SET content = ? WHERE msgid = ? AND fromer = ? AND toer = ?`;
  const params = [content, msgid, fromer, toer];

  dbLogger.log(`[update-chat-message-content] Executing SQL: ${sql}`);
  const result = await UnifiedDB.execute(dbPath, sql, params);

  dbLogger.log(`[update-chat-message-content] ✅ Message content update completed: msgid=${msgid}, Changes: ${result.changes}`);
  return { changes: result.changes };
});

// IPC handler: Delete chat message
registerHandler('delete-chat-message', async (event, msgId, dbUser) => {
  if (!msgId) {
    logger.warn('delete-chat-message: msgId is required');
    return { success: false, error: 'msgId is required' };
  }

  // Prefer the passed-in dbUser; if absent, try to get all database paths from the connection pool
  const dbPaths = [];
  
  if (dbUser) {
    dbPaths.push(pathUtils.getUserDbPath(dbUser));
  } else {
    // Get all known database paths from the connection pool status
    const poolStatus = UnifiedDB.getPoolStatus();
    dbPaths.push(...Object.keys(poolStatus));
  }

  // If no database paths are found, return a warning
  if (dbPaths.length === 0) {
    logger.warn(`delete-chat-message: No database paths found for msgId: ${msgId}`);
    return { success: false, error: 'No database available', deleted: 0 };
  }

  let totalDeleted = 0;
  const results = [];

  for (const dbPath of dbPaths) {
    try {
      // Check if database file exists (asynchronous)
      try {
        await fsPromises.access(dbPath);
      } catch {
        continue;
      }

      // Delete by msgid
      const changes = await UnifiedDB.withORM(dbPath, async (orm) => {
        return await orm.table('message')
          .where({ msgid: msgId })
          .delete();
      });
      
      if (changes > 0) {
        totalDeleted += changes;
        results.push({ dbPath, changes });
        const dbLogger = DBLogger.getInstance(path.basename(dbPath).replace('_emails.db', ''));
        dbLogger.log(`[${dbPath}]Message deleted. MsgID: ${msgId}, Changes: ${changes}`);
      }
    } catch (error) {
      logger.error(`[${dbPath}]Failed to delete message: ${error.message}`);
    }
  }

  if (totalDeleted === 0) {
    logger.warn(`No message found to delete with msgId: ${msgId}`);
  }

  return { success: totalDeleted > 0, deleted: totalDeleted, details: results };
});

// IPC handler: Get chat message by msgid
registerHandler('get-chat-message-by-msgid', async (event, { msgid, dbUser }) => {
  if (!msgid) {
    logger.warn('get-chat-message-by-msgid: msgid is required');
    return null;
  }

  const owner = dbUser;
  if (!owner) {
    logger.warn('get-chat-message-by-msgid: dbUser is required');
    return null;
  }

  const dbPath = pathUtils.getUserDbPath(owner);

  try {
    // Query messages, preferring those where the current user is the recipient
    const sql = `SELECT * FROM message WHERE msgid = ? ORDER BY 
      CASE 
        WHEN toer = ? THEN 0 
        WHEN fromer = ? THEN 1 
        ELSE 2 
      END 
      LIMIT 1`;
    const message = await UnifiedDB.get(dbPath, sql, [msgid, owner, owner]);

    if (message) {
      logger.debug(`get-chat-message-by-msgid found: ${msgid}, status: ${message.status}`);
    } else {
      logger.debug(`get-chat-message-by-msgid not found: ${msgid}`);
    }

    return message;
  } catch (error) {
    logger.error(`get-chat-message-by-msgid error: ${error.message}`);
    return null;
  }
});

// IPC handler: Get history messages
registerHandler('get-history-messages', async (event, { myEmail, targetEmail }) => {
  const dbPath = pathUtils.getUserDbPath(myEmail);

  const sql = `SELECT * FROM message
               WHERE (fromer = ? AND toer = ?)
                  OR (fromer = ? AND toer = ?)
               ORDER BY createtime DESC, id DESC
               LIMIT 100`;
  logger.debug(`Executing get-history-messages. SQL: "${sql}", Params: [${myEmail}, ${targetEmail}, ${targetEmail}, ${myEmail}]`);

  const rows = await UnifiedDB.query(dbPath, sql, [myEmail, targetEmail, targetEmail, myEmail]);
  logger.debug(`get - history - messages result count: ${rows.length}`);

  // Fix placeholder images in mailink_picture messages
  const fixedRows = await fixPlaceholderImages(rows, myEmail);

  return fixedRows;
});

/**
 * Fix placeholder images in messages
 * Check whether images in email-image-message are placeholders(src=""), If so, try to complete from local files
 * @param {Array} messages - message array
 * @param {string} username - username
 * @returns {Promise<Array>} fixed message array
 */
async function fixPlaceholderImages(messages, username) {
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  const recvsDir = pathUtils.getUserRecvsDir(username);
  const httpServerManager = require('../http/http-server-manager');
  const httpPort = httpServerManager.getHttpServerPort() || 8080;

  const fixedMessages = [];

  for (const msg of messages) {
    if (!msg.content || !msg.content.includes('email-image-message')) {
      fixedMessages.push(msg);
      continue;
    }

    // Check whether it is a placeholder image (src="")
    const hasPlaceholderImage = msg.content.includes('src=""') || msg.content.includes("src=''");
    if (!hasPlaceholderImage) {
      fixedMessages.push(msg);
      continue;
    }

    try {
      // Extract email-uid and attachment-filename
      const uidMatch = msg.content.match(/data-email-uid="(\d+)"/);
      const filenameMatch = msg.content.match(/data-attachment-filename="([^"]+)"/);

      if (!uidMatch || !filenameMatch) {
        logger.warn(`[fixPlaceholderImages] Cannot extract uid or filename: msgid=${msg.msgid}`);
        fixedMessages.push(msg);
        continue;
      }

      const uid = uidMatch[1];
      const filename = filenameMatch[1];
      const uidPrefixedName = `${uid}_${filename}`;
      const recvsFilePath = path.join(recvsDir, uidPrefixedName);

      // Check whether the local file exists
      try {
        await fsPromises.access(recvsFilePath);
      } catch {
        // File does not exist, keep as-is
        fixedMessages.push(msg);
        continue;
      }

      // File exists, build the image URL
      const imageUrl = `http://127.0.0.1:${httpPort}/${username}/files/recvs/${encodeURIComponent(uidPrefixedName)}`;

      // Check whether the thumbnail exists
      const thumbnailGenerator = require('../images/thumbnail-generator');
      const thumbnailFileName = thumbnailGenerator.getThumbnailFileName(uidPrefixedName);
      const thumbnailPath = path.join(recvsDir, thumbnailFileName);
      let imgSrc = imageUrl;

      try {
        await fsPromises.access(thumbnailPath);
        const thumbnailUrl = `http://127.0.0.1:${httpPort}/${username}/files/recvs/${encodeURIComponent(thumbnailFileName)}`;
        imgSrc = thumbnailUrl;
      } catch {
        // thumbnail does not exist，use original image
      }

      // Replace placeholders in content
      let newContent = msg.content
        .replace(/src=""/g, `src="${imgSrc}"`)
        .replace(/src=''/g, `src='${imgSrc}'`)
        .replace(/data-original-src=""/g, `data-original-src="${imageUrl}"`)
        .replace(/data-original-src=''/g, `data-original-src='${imageUrl}'`);

      // Also update the database
      try {
        const dbPath = pathUtils.getUserDbPath(username);
        await UnifiedDB.execute(dbPath, 'UPDATE message SET content = ? WHERE msgid = ?', [newContent, msg.msgid]);
        logger.info(`[fixPlaceholderImages] Fixed placeholder image: msgid=${msg.msgid}, uid=${uid}, filename=${filename}`);
      } catch (dbError) {
        logger.warn(`[fixPlaceholderImages] Database update failed: msgid=${msg.msgid}, error=${dbError.message}`);
      }

      fixedMessages.push({ ...msg, content: newContent });
    } catch (error) {
      logger.error(`[fixPlaceholderImages] Failed to fix placeholder image: msgid=${msg.msgid}, error=${error.message}`);
      fixedMessages.push(msg);
    }
  }

  return fixedMessages;
}

// IPC handler: Clear chat history
registerHandler('clear-chat-history', async (event, { myEmail, targetEmail }) => {
  if (!myEmail || !targetEmail) {
    logger.warn('clear-chat-history: myEmail and targetEmail are required');
    return { success: false, error: 'myEmail and targetEmail are required', deleted: 0 };
  }

  const dbPath = pathUtils.getUserDbPath(myEmail);

  try {
    // 1. First get the list of message IDs to delete
    const selectSql = `SELECT msgid FROM message 
                       WHERE (fromer = ? AND toer = ?)
                          OR (fromer = ? AND toer = ?)`;
    const messagesToDelete = await UnifiedDB.query(dbPath, selectSql, [myEmail, targetEmail, targetEmail, myEmail]);
    const msgIds = messagesToDelete.map(row => row.msgid).filter(id => id);
    
    // 2. Delete records from the message table
    const deleteMsgSql = `DELETE FROM message 
                          WHERE (fromer = ? AND toer = ?)
                             OR (fromer = ? AND toer = ?)`;
    const result = await UnifiedDB.execute(dbPath, deleteMsgSql, [myEmail, targetEmail, targetEmail, myEmail]);
    
    const deletedCount = result.changes || 0;
    
    // 3. Delete related transfer_metadata records
    let deletedTransferCount = 0;
    if (msgIds.length > 0) {
      // Use parameterized queries and process in batches to avoid too many SQL parameters
      const batchSize = 100;
      for (let i = 0; i < msgIds.length; i += batchSize) {
        const batch = msgIds.slice(i, i + batchSize);
        const placeholders = batch.map(() => '?').join(',');
        const deleteTransferSql = `DELETE FROM transfer_metadata WHERE msg_id IN (${placeholders})`;
        const transferResult = await UnifiedDB.execute(dbPath, deleteTransferSql, batch);
        deletedTransferCount += transferResult.changes || 0;
      }
    }
    
    const dbLogger = DBLogger.getInstance(path.basename(dbPath).replace('_emails.db', ''));
    dbLogger.log(`[${dbPath}]Chat history cleared. Between ${myEmail} and ${targetEmail}, deleted messages: ${deletedCount}, deleted transfer_metadata: ${deletedTransferCount}`);
    
    logger.info(`[clear-chat-history] Cleared chat history between ${myEmail} and ${targetEmail}, deleted messages: ${deletedCount}, deleted transfer_metadata: ${deletedTransferCount}`);
    
    return { success: true, deleted: deletedCount, deletedTransfer: deletedTransferCount };
  } catch (error) {
    logger.error(`[clear-chat-history] Failed to clear chat history: ${error.message}`);
    return { success: false, error: error.message, deleted: 0 };
  }
});

// IPC handler: Get contacts
registerHandler('get-contacts', async (event, username, options = {}) => {
  const dbPath = pathUtils.getUserDbPath(username);
  const { includeBlacklist = false } = options; // By default, do not return blacklisted contacts

  try {
    // Ensure database table structure exists (with retry mechanism)
    await ensureDatabaseSchema(dbPath);

    // Verify again whether contact table exists
    const contactTableExists = await tableExists(dbPath, 'contact');
    if (!contactTableExists) {
      logger.error(`[get-contacts] contact table does not exist after ensureDatabaseSchema: ${dbPath}`);
      // Try to force create contact table
      await UnifiedDB.execute(dbPath, `CREATE TABLE IF NOT EXISTS contact (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nickname TEXT NOT NULL,
        rmkname TEXT NOT NULL DEFAULT '',
        username TEXT NOT NULL,
        avatar TEXT NOT NULL DEFAULT '',
        avgray TEXT NOT NULL DEFAULT '',
        status INTEGER NOT NULL DEFAULT 20,
        UNIQUE (username ASC)
      )`);
    }

    const rows = await UnifiedDB.withORM(dbPath, async (orm) => {
      let query = orm.table('contact');

      // Only show valid contacts (status >= 0)
      query = query.where([['status', '>=', 0]]);

      // Exclude the current logged-in user's own email address
      const currentUserEmail = username.trim().toLowerCase();
      query = query.whereRaw('lower(username) != lower(?)', [currentUserEmail]);

      return await query
        .order('msgtime DESC')
        .order('status DESC')
        .order('nickname ASC')
        .select();
    });

    logger.info(`[get-contacts] Successfully retrieved ${rows.length} contacts for ${username} (includeBlacklist: ${includeBlacklist})`);

    return rows.map(row => ({
      id: row.id,
      nickname: row.nickname,
      rmkname: row.rmkname || '',
      username: row.username,
      avatar: row.avatar,
      status: row.status !== undefined ? row.status : 20,
      updatetime: row.updatetime || 0,
      msgtime: row.msgtime || 0
    }));
  } catch (error) {
    logger.error(`[get-contacts] Error getting contacts for ${username}: ${error.message}`);
    // Return an empty array instead of throwing an error to avoid crashing the frontend
    return [];
  }
});

// IPC handler: Add contact
registerHandler('add-contact', async (event, username, contactData) => {
  const dbPath = pathUtils.getUserDbPath(username);

  try {
    // Ensure database table structure exists (with retry mechanism)
    await ensureDatabaseSchema(dbPath);

    // Verify again whether contact table exists
    const contactTableExists = await tableExists(dbPath, 'contact');
    if (!contactTableExists) {
      logger.error(`[add-contact] contact table does not exist after ensureDatabaseSchema: ${dbPath}`);
      // Try to force create contact table
      await UnifiedDB.execute(dbPath, `CREATE TABLE IF NOT EXISTS contact (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nickname TEXT NOT NULL,
        rmkname TEXT NOT NULL DEFAULT '',
        username TEXT NOT NULL,
        avatar TEXT NOT NULL DEFAULT '',
        avgray TEXT NOT NULL DEFAULT '',
        status INTEGER NOT NULL DEFAULT 20,
        UNIQUE (username ASC)
      )`);
    }

    if (!contactData || !contactData.username) {
      throw new Error('contactData.username is required');
    }

    // Restriction: cannot add the currently logged-in IMAP account email address as a contact
    const currentUserEmail = username.trim().toLowerCase();
    const contactEmail = contactData.username.trim().toLowerCase();
    if (contactEmail === currentUserEmail) {
      logger.warn(`[add-contact] Cannot add self as contact: ${contactData.username}`);
      throw new Error('Cannot add self as contact');
    }

    // First check whether the contact exists
    const existingContact = await UnifiedDB.withORM(dbPath, async (orm) => {
      return await orm.table('contact')
        .whereRaw('lower(username) = lower(?)', [contactData.username])
        .find();
    });

  let result;
  const now = Date.now();
  if (existingContact) {
    const updateData = {};
    if (contactData.nickname !== undefined) {
      updateData.nickname = contactData.nickname;
    }
    // Support setting rmkname (remark name) via the UI
    if (contactData.rmkname !== undefined) {
      updateData.rmkname = contactData.rmkname;
    } else if (contactData.nickname !== undefined) {
      // UI passes rmkname (name field) and also sets nickname
      updateData.rmkname = contactData.nickname;
    }
    if (contactData.avatar !== undefined) {
      updateData.avatar = contactData.avatar || '';
    }
    if (contactData.avgray !== undefined) {
      updateData.avgray = contactData.avgray || '';
    }
    if (contactData.status !== undefined) {
      updateData.status = contactData.status;
    } else if (existingContact.status < 0) {
      // If status is not specified but existing status < 0 (blacklist), automatically change to 20 (restore as friend)
      updateData.status = 20;
      logger.info(`[add-contact] Auto-restoring contact status from ${existingContact.status} to 20 for ${contactData.username}`);
    }
    // Set updatetime when updating
    updateData.updatetime = now;

    if (Object.keys(updateData).length === 0) {
      return { changes: 0 };
    }

    const changes = await UnifiedDB.withORM(dbPath, async (orm) => {
      return await orm.table('contact')
        .where({ id: existingContact.id })
        .update(updateData);
    });
    result = changes;
    logger.info(`[${dbPath}]Contact updated successfully.Changes: ${result}`);
  } else {
    // Contact does not exist, perform insert operation
    const normalizedUsername = String(contactData.username).trim();
    const nickname = contactData.nickname !== undefined
      ? contactData.nickname
      : (normalizedUsername.includes('@') ? normalizedUsername.split('@')[0] : normalizedUsername);
    // rmkname: prefer when passed by UI, otherwise keep consistent with nickname
    const rmkname = contactData.rmkname !== undefined
      ? contactData.rmkname
      : nickname;

    // When adding a new contact, status defaults to 20 (friend)
    const status = contactData.status !== undefined ? contactData.status : 20;

    const newId = await UnifiedDB.withORM(dbPath, async (orm) => {
      return await orm.table('contact').insertGetId({
        nickname: nickname || '',
        rmkname: rmkname || '',
        username: contactData.username,
        avatar: contactData.avatar || '',
        avgray: contactData.avgray || '',
        status: status,
        updatetime: now
      });
    });
    result = { id: newId, changes: 1 };
    logger.info(`[${dbPath}]Contact added successfully.ID: ${newId}, status=${status}`);
  }

    // Trigger automatic backup after contact changes (debounced, non-blocking)
    _scheduleContactBackup(username);

    return result;
  } catch (error) {
    logger.error(`[add-contact] Error adding contact for ${username}: ${error.message}`);
    throw error;
  }
});

// IPC handler: Update contact (only update rmkname, using username as condition)
registerHandler('update-contact', async (event, username, contactData) => {
  const dbPath = pathUtils.getUserDbPath(username);

  try {
    // Ensure database table structure exists
    await ensureDatabaseSchema(dbPath);

    if (!contactData || !contactData.username) {
      throw new Error('contactData.username is required');
    }

    // Find the contact
    const existingContact = await UnifiedDB.withORM(dbPath, async (orm) => {
      return await orm.table('contact')
        .whereRaw('lower(username) = lower(?)', [contactData.username])
        .find();
    });

    if (!existingContact) {
      throw new Error(`Contact does not exist: ${contactData.username}`);
    }

    // Only update rmkname
    const updateData = {};
    if (contactData.rmkname !== undefined) {
      updateData.rmkname = contactData.rmkname;
    }

    if (Object.keys(updateData).length === 0) {
      return { changes: 0 };
    }

    // Use username as the update condition (rather than id)
    const changes = await UnifiedDB.withORM(dbPath, async (orm) => {
      return await orm.table('contact')
        .whereRaw('lower(username) = lower(?)', [contactData.username])
        .update(updateData);
    });

    logger.info(`[update-contact] Contact updated successfully. Username: ${contactData.username}, Changes: ${changes}`);

    // Trigger automatic backup after contact changes (debounced, non-blocking)
    _scheduleContactBackup(username);

    return { changes };
  } catch (error) {
    logger.error(`[update-contact] Error updating contact for ${username}: ${error.message}`);
    throw error;
  }
});

// IPC handler: Delete contact (soft delete - change status to blacklist)
registerHandler('delete-contact', async (event, username, contactEmail) => {
  const dbPath = pathUtils.getUserDbPath(username);

  // Ensure database table structure exists
  await ensureDatabaseSchema(dbPath);

  // Perform soft delete: change status to blacklist (-100)
  const now = Date.now();
  const changes = await UnifiedDB.withORM(dbPath, async (orm) => {
    return await orm.table('contact')
      .where({ username: contactEmail })
      .update({ status: -100, updatetime: now });
  });

  if (changes > 0) {
    logger.info(`[${dbPath}]Contact soft deleted (blacklisted).Email: ${contactEmail}`);
    // Trigger automatic backup after contact changes (debounced, non-blocking)
    _scheduleContactBackup(username);
  } else {
    logger.warn(`[${dbPath}]Contact not found for soft delete.Email: ${contactEmail}`);
  }

  return { changes, softDeleted: changes > 0, status: -100 };
});

// IPC handler: check whether cache key exists
registerHandler('sqlite-cache-has', async (event, { cacheName, key, userId }) => {
  // Get user-specific database path
  const dbPath = pathUtils.getUserDbPath(userId);

  const row = await UnifiedDB.withORM(dbPath, async (orm) => {
    return await orm.table('signaling_cache')
      .where({ cache_name: cacheName, email_id: key })
      .find();
  });
  return !!row;
});

// IPC handler: add key to cache
registerHandler('sqlite-cache-add', async (event, { cacheName, key, maxSize = 1000, userId }) => {
  const now = Date.now();

  // Get user-specific database path
  const dbPath = pathUtils.getUserDbPath(userId);

  // Use UnifiedDB.execute directly, no ORM transaction needed
  // Insert or update record
  await UnifiedDB.execute(dbPath,
    `INSERT OR REPLACE INTO signaling_cache
    (cache_name, email_id, last_access_time, created_time) 
     VALUES(?, ?, ?,
      CASE 
               WHEN EXISTS(SELECT 1 FROM signaling_cache WHERE cache_name = ? AND email_id = ?) 
               THEN(SELECT created_time FROM signaling_cache WHERE cache_name = ? AND email_id = ?) 
               ELSE ?
        END)`,
    [cacheName, key, now, cacheName, key, cacheName, key, now]
  );

  // Check and remove records that exceed capacity
  await UnifiedDB.execute(dbPath,
    `DELETE FROM signaling_cache 
     WHERE cache_name = ? AND id NOT IN(
          SELECT id FROM signaling_cache 
       WHERE cache_name = ?
          ORDER BY last_access_time DESC 
       LIMIT ?
     )`,
    [cacheName, cacheName, maxSize]
  );

  return true;
});

// IPC handler: clear cache
registerHandler('sqlite-cache-clear', async (event, { cacheName, userId }) => {
  // Get user-specific database path
  const dbPath = pathUtils.getUserDbPath(userId);

  await UnifiedDB.withORM(dbPath, async (orm) => {
    await orm.table('signaling_cache')
      .where({ cache_name: cacheName })
      .delete();
  });
  return true;
});

// IPC handler: Get transfer metadata for resumable transfer
registerHandler('get-transfer-metadata', async (event, { msgId, userId }) => {
  const dbPath = pathUtils.getUserDbPath(userId);

  try {
    // Ensure database table structure exists
    await ensureDatabaseSchema(dbPath);

    return await UnifiedDB.withORM(dbPath, async (orm) => {
      return await orm.table('transfer_metadata')
        .where({ msg_id: msgId })
        .find();
    });
  } catch (error) {
    logger.error(`get-transfer-metadata error: ${error.message}`);
    return null;
  }
});

// IPC handler: Find incomplete transfer metadata by file hash and size
registerHandler('find-incomplete-transfer-by-hash', async (event, { fileHash, size, userId, senderId }) => {
  const dbPath = pathUtils.getUserDbPath(userId);

  try {
    await ensureDatabaseSchema(dbPath);
    
    // We try to find a pending transfer with same hash and total_size
    // We use raw query because we need the > 0 and < total_size conditions
    let sql = `
      SELECT tm.* 
      FROM transfer_metadata tm
      JOIN message m ON tm.msg_id = m.msgid
      WHERE m.fromer = ?
        AND m.toer = ?
        AND tm.total_size = ?
        AND tm.received_size > 0 
        AND tm.received_size < tm.total_size
    `;
    
    // Check fileHash by searching within the message HTML content which has the serialized JSON offer
    const params = [senderId, userId, size];
    if (fileHash) {
      sql += ` AND m.content LIKE ?`;
      params.push(`%${fileHash}%`);
    }
    
    sql += ` ORDER BY tm.createtime DESC LIMIT 1`;
    
    const result = await UnifiedDB.get(dbPath, sql, params);
    
    if (result) {
      logger.info(`[SQLite] Smart match succeeded: old msgid=${result.msg_id}, rs=${result.received_size}/${result.total_size}, hash match: ${!!fileHash}`);
    } else {
      logger.info(`[SQLite] Smart match found no records: sender=${senderId}, size=${size}, hash=${fileHash}`);
    }
    
    return result;
  } catch (error) {
    logger.error(`find-incomplete-transfer-by-hash error: ${error.message}`);
    return null;
  }
});

// IPC handler: Update or create transfer metadata
registerHandler('update-transfer-metadata', async (event, { msgId, fileName, filePath, totalSize, receivedSize, metadata, userId }) => {
  const dbPath = pathUtils.getUserDbPath(userId);
  const now = Date.now();

  try {
    // Ensure database table structure exists
    await ensureDatabaseSchema(dbPath);

    // Use INSERT OR REPLACE to simplify update logic
    const sql = `INSERT OR REPLACE INTO transfer_metadata
      (msg_id, file_name, file_path, total_size, received_size, status, metadata, createtime)
                 VALUES(?, ?, ?, ?, ?, 'pending', ?,
        COALESCE((SELECT createtime FROM transfer_metadata WHERE msg_id = ?), ?))`;

    const result = await UnifiedDB.execute(dbPath, sql, [
      msgId, fileName, filePath, totalSize, receivedSize, metadata, msgId, now
    ]);

    return { success: true, changes: result.changes };
  } catch (error) {
    logger.error(`update-transfer-metadata error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// IPC handler: Delete transfer metadata
registerHandler('delete-transfer-metadata', async (event, { msgId, userId }) => {
  const dbPath = pathUtils.getUserDbPath(userId);

  try {
    // Ensure database table structure exists
    await ensureDatabaseSchema(dbPath);

    const changes = await UnifiedDB.withORM(dbPath, async (orm) => {
      return await orm.table('transfer_metadata')
        .where({ msg_id: msgId })
        .delete();
    });
    return { success: true, changes };
  } catch (error) {
    logger.error(`delete-transfer-metadata error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// IPC handler: Delete pending images (clear sent images to prevent duplicate transmission)
registerHandler('delete-pending-images', async (event, { fromer, msgids }) => {
  const dbPath = pathUtils.getUserDbPath(fromer);
  
  if (!msgids || msgids.length === 0) {
    return { success: true, changes: 0 };
  }

  try {
    const changes = await UnifiedDB.withORM(dbPath, async (orm) => {
      return await orm.table('pending_images')
        .whereIn('msgid', msgids)
        .delete();
    });
    
    logger.info(`[SQLite] Cleared ${changes} sent images to prevent duplicate transmission: ${msgids.join(', ')}`);
    return { success: true, changes };
  } catch (error) {
    logger.error(`[SQLite] Failed to clear sent images:`, error);
    return { success: false, error: error.message };
  }
});

// IPC handler: Mark email message as read by emid (RFC Message-ID)
registerHandler('mark-email-message-read', async (event, { emid, dbUser }) => {
  if (!emid) {
    logger.warn('mark-email-message-read: emid is required');
    return { success: false, error: 'emid is required' };
  }

  const owner = dbUser;
  if (!owner) {
    logger.warn('mark-email-message-read: dbUser is required');
    return { success: false, error: 'dbUser is required' };
  }

  const dbPath = pathUtils.getUserDbPath(owner);

  const nowMs = BigInt(Date.now());
  const hrTime = process.hrtime.bigint();
  const readTime = (nowMs * 1000000n + (hrTime % 1000000n)).toString();

  try {
    // First check whether matching records exist
    const existingRecord = await UnifiedDB.withORM(dbPath, async (orm) => {
      return await orm.table('message')
        .where({ emid })
        .find();
    });

    if (!existingRecord) {
      logger.warn(`mark-email-message-read: no message found with emid=${emid}`);
      return { success: false, error: 'Message not found', changes: 0 };
    }

    logger.info(`mark-email-message-read: found message, current is_read=${existingRecord.is_read}, id=${existingRecord.id}`);

    const changes = await UnifiedDB.withORM(dbPath, async (orm) => {
      return await orm.table('message')
        .where({ emid })
        .update({ is_read: 1, read_time: readTime });
    });

    logger.info(`mark-email-message-read: emid=${emid}, changes=${changes}`);
    return { success: true, changes };
  } catch (error) {
    logger.error(`mark-email-message-read error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// IPC handler: Mark a single message as read
registerHandler('mark-message-read', async (event, { msgid, dbUser }) => {
  if (!msgid) {
    logger.warn('mark-message-read: msgid is required');
    return { success: false, error: 'msgid is required' };
  }

  const owner = dbUser;
  if (!owner) {
    logger.warn('mark-message-read: dbUser is required');
    return { success: false, error: 'dbUser is required' };
  }

  const dbPath = pathUtils.getUserDbPath(owner);

  const nowMs = BigInt(Date.now());
  const hrTime = process.hrtime.bigint();
  const readTime = (nowMs * 1000000n + (hrTime % 1000000n)).toString();

  const changes = await UnifiedDB.withORM(dbPath, async (orm) => {
    return await orm.table('message')
      .where({ msgid })
      .update({ is_read: 1, read_time: readTime });
  });

  logger.debug(`mark-message-read: msgid=${msgid}, changes=${changes}`);
  return { success: true, changes };
});

// IPC handler: Mark all messages from a contact as read
registerHandler('mark-all-messages-read', async (event, { myEmail, targetEmail }) => {
  if (!myEmail || !targetEmail) {
    logger.warn('mark-all-messages-read: myEmail and targetEmail are required');
    return { success: false, error: 'myEmail and targetEmail are required' };
  }

  const dbPath = pathUtils.getUserDbPath(myEmail);

  const nowMs = BigInt(Date.now());
  const hrTime = process.hrtime.bigint();
  const readTime = (nowMs * 1000000n + (hrTime % 1000000n)).toString();

  const changes = await UnifiedDB.withORM(dbPath, async (orm) => {
    return await orm.table('message')
      .where({ toer: myEmail, fromer: targetEmail, is_read: 0 })
      .update({ is_read: 1, read_time: readTime });
  });

  logger.debug(`mark-all-messages-read: myEmail=${myEmail}, targetEmail=${targetEmail}, changes=${changes}`);
  return { success: true, changes };
});

// IPC handler: Get unread message count grouped by contact
registerHandler('get-unread-count', async (event, { myEmail }) => {
  if (!myEmail) {
    logger.warn('get-unread-count: myEmail is required');
    return [];
  }

  const dbPath = pathUtils.getUserDbPath(myEmail);

  const sql = `SELECT fromer, COUNT(*) as unread_count 
               FROM message 
               WHERE toer = ? AND is_read = 0 
               GROUP BY fromer`;

  const rows = await UnifiedDB.query(dbPath, sql, [myEmail]);
  logger.debug(`get-unread-count: myEmail=${myEmail}, result count=${rows.length}`);
  return rows;
});

// IPC handler: Get total unread count for current user
registerHandler('get-total-unread-count', async (event, { myEmail }) => {
  if (!myEmail) {
    logger.warn('get-total-unread-count: myEmail is required');
    return { total: 0 };
  }

  const dbPath = pathUtils.getUserDbPath(myEmail);

  const sql = `SELECT COUNT(*) as total FROM message WHERE toer = ? AND is_read = 0`;
  const result = await UnifiedDB.get(dbPath, sql, [myEmail]);

  logger.debug(`get-total-unread-count: myEmail=${myEmail}, total=${result?.total || 0}`);
  return { total: result?.total || 0 };
});

// IPC handler: Get total unread count from recv table for current user
registerHandler('get-recv-unread-count', async (event, { myEmail }) => {
  if (!myEmail) {
    logger.warn('get-recv-unread-count: myEmail is required');
    return { total: 0 };
  }

  const dbPath = pathUtils.getUserDbPath(myEmail);

  try {
    // Ensure database table structure exists
    await ensureDatabaseSchema(dbPath);

    // Since each user's database is independent, all emails belong to the current user
    // The recipient field may be empty (email To field missing), so count all unread emails directly
    const sql = `SELECT COUNT(*) as total FROM recv WHERE is_read = 0`;
    const result = await UnifiedDB.get(dbPath, sql);

    logger.debug(`get-recv-unread-count: myEmail=${myEmail}, total=${result?.total || 0}`);
    return { total: result?.total || 0 };
  } catch (error) {
    logger.error(`get-recv-unread-count failed: ${error.message}`);
    return { total: 0 };
  }
});

// IPC handler: Mark recv email as read
registerHandler('mark-recv-email-read', async (event, { myEmail, emailId, imapConfig }) => {
  if (!myEmail || !emailId) {
    logger.warn('mark-recv-email-read: myEmail and emailId are required');
    return { success: false };
  }

  const dbPath = pathUtils.getUserDbPath(myEmail);

  try {
    // Ensure database table structure exists
    await ensureDatabaseSchema(dbPath);

    // First get the email's IMAP UID and message_id
    const emailRow = await UnifiedDB.get(dbPath, `SELECT imap_uid, message_id FROM recv WHERE id = ?`, [emailId]);
    const imapUid = emailRow?.imap_uid;
    const messageId = emailRow?.message_id;

    // Update local database recv table
    await UnifiedDB.execute(dbPath, `UPDATE recv SET is_read = 1 WHERE id = ?`, [emailId]);
    logger.debug(`mark-recv-email-read: myEmail=${myEmail}, emailId=${emailId}, imapUid=${imapUid}`);

    // Sync update corresponding chat messages in message table to read
    let messageUpdated = 0;
    if (messageId) {
      try {
        const nowMs = BigInt(Date.now());
        const hrTime = process.hrtime.bigint();
        const readTime = (nowMs * 1000000n + (hrTime % 1000000n)).toString();

        messageUpdated = await UnifiedDB.withORM(dbPath, async (orm) => {
          return await orm.table('message')
            .where({ emid: messageId })
            .update({ is_read: 1, read_time: readTime });
        });
        logger.debug(`mark-recv-email-read: Synced message read status, emid=${messageId}, updated=${messageUpdated}`);
      } catch (msgError) {
        logger.warn(`mark-recv-email-read: Failed to sync message read status: ${msgError.message}`);
      }
    }

    // If an IMAP UID exists and IMAP config is present, sync to the server
    let serverSynced = false;
    if (imapUid && imapConfig && imapConfig.username) {
      try {
        serverSynced = await syncReadStatusToServer(imapConfig, imapUid);
        logger.info(`mark-recv-email-read: Synced to server for UID ${imapUid}: ${serverSynced}`);
      } catch (syncError) {
        logger.error(`mark-recv-email-read: Failed to sync to server: ${syncError.message}`);
      }
    } else {
      logger.debug(`mark-recv-email-read: Skipping server sync - imapUid=${imapUid}, hasConfig=${!!imapConfig}`);
    }

    return { success: true, serverSynced, messageUpdated };
  } catch (error) {
    logger.error(`mark-recv-email-read failed: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// IPC handler: Batch mark recv emails as read
registerHandler('batch-mark-recv-emails-read', async (event, { myEmail, emailIds, imapConfig }) => {
  if (!myEmail || !emailIds || !Array.isArray(emailIds) || emailIds.length === 0) {
    logger.warn('batch-mark-recv-emails-read: myEmail and emailIds array are required');
    return { success: false };
  }

  const dbPath = pathUtils.getUserDbPath(myEmail);

  try {
    await ensureDatabaseSchema(dbPath);

    const placeholders = emailIds.map(() => '?').join(',');
    const emailRows = await UnifiedDB.query(dbPath, `SELECT id, imap_uid, message_id FROM recv WHERE id IN (${placeholders})`, emailIds);
    const imapUids = emailRows.map(row => row.imap_uid).filter(Boolean);
    const messageIds = emailRows.map(row => row.message_id).filter(Boolean);

    // Update local database recv table
    await UnifiedDB.execute(dbPath, `UPDATE recv SET is_read = 1 WHERE id IN (${placeholders})`, emailIds);
    logger.debug(`batch-mark-recv-emails-read: myEmail=${myEmail}, emailIds=${emailIds.length}, imapUids=${imapUids.length}`);

    // Sync update corresponding chat messages in message table to read
    let messageUpdatedCount = 0;
    if (messageIds.length > 0) {
      try {
        const nowMs = BigInt(Date.now());
        const hrTime = process.hrtime.bigint();
        const readTime = (nowMs * 1000000n + (hrTime % 1000000n)).toString();

        const msgPlaceholders = messageIds.map(() => '?').join(',');
        const msgResult = await UnifiedDB.execute(
          dbPath,
          `UPDATE message SET is_read = 1, read_time = ? WHERE emid IN (${msgPlaceholders})`,
          [readTime, ...messageIds]
        );
        messageUpdatedCount = msgResult?.changes || 0;
        logger.debug(`batch-mark-recv-emails-read: Synced message read status, messageIds=${messageIds.length}, updated=${messageUpdatedCount}`);
      } catch (msgError) {
        logger.warn(`batch-mark-recv-emails-read: Failed to sync message read status: ${msgError.message}`);
      }
    }

    let serverSyncResult = { success: false, syncedCount: 0, failedCount: 0 };
    if (imapUids.length > 0 && imapConfig && imapConfig.username) {
      try {
        serverSyncResult = await batchSyncReadStatusToServer(imapConfig, imapUids);
        logger.info(`batch-mark-recv-emails-read: Synced to server: ${JSON.stringify(serverSyncResult)}`);
      } catch (syncError) {
        logger.error(`batch-mark-recv-emails-read: Failed to sync to server: ${syncError.message}`);
      }
    } else {
      logger.debug(`batch-mark-recv-emails-read: Skipping server sync - imapUids=${imapUids.length}, hasConfig=${!!imapConfig}`);
    }

    return {
      success: true,
      serverSynced: serverSyncResult.success,
      serverSyncedCount: serverSyncResult.syncedCount,
      serverFailedCount: serverSyncResult.failedCount,
      messageUpdatedCount
    };
  } catch (error) {
    logger.error(`batch-mark-recv-emails-read failed: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// IPC handler: Mark all emails as read
registerHandler('mark-all-emails-as-read', async (event, { username, imapConfig }) => {
  if (!username) {
    logger.warn('mark-all-emails-as-read: username is required');
    return { success: false, error: 'username is required' };
  }

  const dbPath = pathUtils.getUserDbPath(username);

  try {
    // Ensure database table structure exists
    await ensureDatabaseSchema(dbPath);

    // First get IMAP UIDs of all unread emails
    const unreadRows = await UnifiedDB.query(dbPath,
      `SELECT id, imap_uid FROM recv WHERE is_read = 0 AND imap_uid != ''`
    );
    const imapUids = unreadRows.map(row => row.imap_uid).filter(Boolean);

    // Update the local database
    const result = await UnifiedDB.execute(dbPath, `UPDATE recv SET is_read = 1 WHERE is_read = 0`);
    const updatedCount = result?.changes || 0;
    logger.debug(`mark-all-emails-as-read: username=${username}, changes=${updatedCount}, imapUids=${imapUids.length}`);

    // Sync to the IMAP server
    let serverSyncResult = { success: false, syncedCount: 0, failedCount: 0 };
    if (imapUids.length > 0 && imapConfig && imapConfig.username) {
      try {
        serverSyncResult = await batchSyncReadStatusToServer(imapConfig, imapUids);
        logger.info(`mark-all-emails-as-read: Synced to server: ${JSON.stringify(serverSyncResult)}`);
      } catch (syncError) {
        logger.error(`mark-all-emails-as-read: Failed to sync to server: ${syncError.message}`);
      }
    } else {
      logger.debug(`mark-all-emails-as-read: Skipping server sync - imapUids=${imapUids.length}, hasConfig=${!!imapConfig}`);
    }

    return {
      success: true,
      count: updatedCount,
      serverSynced: serverSyncResult.success,
      serverSyncedCount: serverSyncResult.syncedCount,
      serverFailedCount: serverSyncResult.failedCount
    };
  } catch (error) {
    logger.error(`mark-all-emails-as-read failed: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// IPC handler: Get emails from local database with pagination
registerHandler('get-local-emails', async (event, { username, page = 1, pageSize = 20, search = '', sender = '', startTime = 0, endTime = 0 }) => {
  if (!username) {
    logger.warn('get-local-emails: username is required');
    return { emails: [], total: 0, page: 1, pageSize: 20, totalPages: 0 };
  }

  const dbPath = pathUtils.getUserDbPath(username);

  try {
    // Ensure database table structure exists
    await ensureDatabaseSchema(dbPath);

    // Build query conditions
    const conditions = [];
    const params = [];

    if (search) {
      conditions.push('(subject LIKE ? OR sender LIKE ?)');
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern);
    }

    if (sender) {
      conditions.push('sender = ?');
      params.push(sender);
    }

    if (startTime > 0) {
      conditions.push('received_time >= ?');
      params.push(startTime.toString());
    }

    if (endTime > 0) {
      conditions.push('received_time <= ?');
      params.push(endTime.toString());
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total record count
    const countSql = `SELECT COUNT(*) as total FROM recv ${whereClause}`;
    const countResult = await UnifiedDB.get(dbPath, countSql, params);
    const total = countResult?.total || 0;

    // Calculate pagination
    const totalPages = Math.ceil(total / pageSize);
    const validPage = Math.max(1, Math.min(page, totalPages || 1));
    const offset = (validPage - 1) * pageSize;

    // Get email list (in descending order by receive time)
    const sql = `SELECT id, message_id, imap_uid, subject, sender, recipient, received_time, is_signaling, is_read, txtbody, htmbody, attachments, headers, priority
                 FROM recv
                 ${whereClause}
                 ORDER BY received_time DESC
                 LIMIT ? OFFSET ?`;

    const rows = await UnifiedDB.query(dbPath, sql, [...params, pageSize, offset]);

    // Parse split email fields
    const parsedRows = parseSplitFieldsInBatches(rows);

    // Build email data
    const emails = parsedRows.map(row => {
      const parsed = row._parsed || {};

      // Process sender: if it contains < >, extract the email address
      let fromValue = row.sender;
      if (fromValue && fromValue.includes('<')) {
        const emailMatch = fromValue.match(/<([^>]+)>/);
        if (emailMatch && emailMatch[1]) {
          fromValue = emailMatch[1];
        }
      }

      return {
        id: row.id,
        uid: row.id,
        imapUid: row.imap_uid,
        messageId: row.message_id,
        subject: row.subject || '(No subject)',
        from: fromValue || '',
        to: row.recipient || '',
        date: row.received_time ? new Date(Number(BigInt(row.received_time) / BigInt(1000000))).toISOString() : '',
        text: parsed.text || '',
        html: parsed.html || '',
        isSignaling: row.is_signaling === 1,
        isRead: row.is_read === 1,
        attachments: parsed.attachments || [],
        priority: parsed.priority || null,
        headers: parsed.headers || {}
      };
    });

    logger.debug(`get-local-emails: username=${username}, page=${validPage}, total=${total}, returned=${emails.length}`);

    return {
      emails,
      total,
      page: validPage,
      pageSize,
      totalPages: totalPages || 1
    };
  } catch (error) {
    logger.error(`get-local-emails error: ${error.message}`);
    return { emails: [], total: 0, page: 1, pageSize, totalPages: 0 };
  }
});

// IPC handler: Get email detail from local database
registerHandler('get-local-email-detail', async (event, { username, emailId }) => {
  if (!username || !emailId) {
    logger.warn('get-local-email-detail: username and emailId are required');
    return null;
  }

  const dbPath = pathUtils.getUserDbPath(username);

  try {
    // Ensure database table structure exists
    await ensureDatabaseSchema(dbPath);

    const sql = `SELECT id, imap_uid, message_id, subject, sender, recipient, received_time, is_signaling, txtbody, htmbody, attachments, headers, priority
                 FROM recv
                 WHERE id = ?`;

    const row = await UnifiedDB.get(dbPath, sql, [emailId]);

    if (!row) {
      return null;
    }

    // Parse split email fields
    const parsed = parseSplitFields(row);

    const email = {
      id: row.id,
      uid: row.imap_uid || row.id,  // use IMAP UID，use database if it does not exist id
      imap_uid: row.imap_uid, // explicitly provide imap_uid
      messageId: row.message_id,
      subject: row.subject || '(No subject)',
      from: row.sender || '',
      to: row.recipient || '',
      date: row.received_time ? new Date(Number(BigInt(row.received_time) / BigInt(1000000))).toISOString() : '',
      text: parsed.text || '',
      html: parsed.html || '',
      isSignaling: row.is_signaling === 1,
      attachments: parsed.attachments || [],
      headers: parsed.headers || {}
    };

    // Debug log: check attachment download status
    if (email.attachments && email.attachments.length > 0) {
      email.attachments.forEach(att => {
        logger.info(`[get-local-email-detail] Attachment: ${att.filename}, downloaded: ${att.downloaded}, localPath: ${att.localPath}`);
      });
    }

    logger.debug(`get-local-email-detail: username=${username}, emailId=${emailId}`);
    return email;
  } catch (error) {
    logger.error(`get-local-email-detail error: ${error.message}`);
    return null;
  }
});

// IPC handler: Get email detail by message_id (RFC Message-ID, i.e. emid in message table)
registerHandler('get-local-email-by-message-id', async (event, { username, messageId }) => {
  if (!username || !messageId) {
    logger.warn('get-local-email-by-message-id: username and messageId are required');
    return null;
  }

  const dbPath = pathUtils.getUserDbPath(username);

  try {
    await ensureDatabaseSchema(dbPath);

    const sql = `SELECT id, imap_uid, message_id, subject, sender, recipient, received_time, is_signaling, txtbody, htmbody, attachments, headers, priority
                 FROM recv
                 WHERE message_id = ?`;

    const row = await UnifiedDB.get(dbPath, sql, [messageId]);

    if (!row) {
      logger.debug(`get-local-email-by-message-id: no email found for messageId=${messageId}`);
      return null;
    }

    const email = { ...row };

    // Parse attachment JSON
    if (email.attachments && typeof email.attachments === 'string') {
      try {
        email.attachments = JSON.parse(email.attachments);
      } catch (e) {
        email.attachments = [];
      }
    }

    // Compatibility field mapping (consistent with the email-detail component)
    email.from = email.sender || '';
    email.to = email.recipient || '';
    email.date = email.received_time ? new Date(Number(BigInt(email.received_time) / BigInt(1000000))).toISOString() : '';
    email.html = email.htmbody || '';
    email.text = email.txtbody || '';
    email.uid = email.id;

    return email;
  } catch (error) {
    logger.error(`get-local-email-by-message-id error: ${error.message}`);
    return null;
  }
});

// IPC handler: Update attachment download status
registerHandler('update-attachment-status', async (event, { username, emailId, filename, downloaded, localPath, fileHash }) => {
  if (!username || !emailId || !filename) {
    logger.warn('update-attachment-status: username, emailId and filename are required');
    return { success: false, error: 'username, emailId and filename are required' };
  }

  const dbPath = pathUtils.getUserDbPath(username);
  const path = require('path');
  const fileHashUtils = require(path.join(__dirname, '../files/file-hash-utils'));

  try {
    // Ensure database table structure exists
    await ensureDatabaseSchema(dbPath);

    // If it is a download-complete state, verify file integrity first
    if (downloaded && localPath) {
      try {
        const verifyResult = await fileHashUtils.verifyFileIntegrity(localPath, {});
        
        if (!verifyResult.exists || !verifyResult.isReadable) {
          logger.error(`[update-attachment-status] File verification failed: ${localPath}`);
          return { 
            success: false, 
            error: `File verification failed: ${verifyResult.error || 'File not readable'}` 
          };
        }
        logger.info(`[update-attachment-status] File verified: ${localPath}, size=${verifyResult.actualSize}, hash=${verifyResult.actualHash?.substring(0, 8)}...`);
      } catch (e) {
        logger.warn(`[update-attachment-status] File verification skipped: ${e.message}`);
        // do not interrupt flow，only log warning
      }
    }

    // Get attachment data for the current email
    const sql = `SELECT attachments FROM recv WHERE id = ?`;
    const row = await UnifiedDB.get(dbPath, sql, [emailId]);

    if (!row || !row.attachments) {
      return { success: false, error: 'Email not found or no attachments data' };
    }

    // Parse attachments JSON
    let attachmentsList;
    try {
      attachmentsList = typeof row.attachments === 'string' ? JSON.parse(row.attachments) : row.attachments;
    } catch (e) {
      logger.warn(`[update-attachment-status] Failed to parse attachments: ${e.message}`);
      return { success: false, error: 'Failed to parse attachments data' };
    }

    // Update attachment status
    if (attachmentsList && Array.isArray(attachmentsList)) {
      let updated = false;
      let targetAttachment = null;
      
      for (const att of attachmentsList) {
        if (att.filename === filename) {
          att.downloaded = downloaded;
          if (localPath) {
            att.localPath = localPath;
          }
          // Save file hash value (for subsequent verification)
          if (fileHash) {
            att.fileHash = fileHash;
          }
          // Record download time
          if (downloaded) {
            att.downloadedAt = new Date().toISOString();
          }
          targetAttachment = att;
          updated = true;
          break;
        }
      }

      if (!updated) {
        return { success: false, error: 'Attachment not found' };
      }

      // Save updated attachments data
      const updatedAttachments = JSON.stringify(attachmentsList);
      const updateSql = `UPDATE recv SET attachments = ? WHERE id = ?`;
      
      try {
        const changes = await UnifiedDB.execute(dbPath, updateSql, [updatedAttachments, emailId]);
        
        if (changes === 0) {
          return { success: false, error: 'No rows updated - email may have been deleted' };
        }

        // Verify whether the update succeeded (double check)
        const verifyRow = await UnifiedDB.get(dbPath, 
          `SELECT attachments FROM recv WHERE id = ?`, [emailId]
        );
        
        if (verifyRow && verifyRow.attachments) {
          const verifyAttachments = typeof verifyRow.attachments === 'string' ? JSON.parse(verifyRow.attachments) : verifyRow.attachments;
          const verifyAtt = verifyAttachments?.find(a => a.filename === filename);
          
          if (verifyAtt && verifyAtt.downloaded === downloaded) {
            logger.info(`[update-attachment-status] Verified: username=${username}, emailId=${emailId}, filename=${filename}, downloaded=${downloaded}`);
            return { success: true, attachment: targetAttachment };
          }
        }
        
        // Verification failed, return error
        return { success: false, error: 'Update verification failed' };
      } catch (dbError) {
        logger.error(`[update-attachment-status] Database error: ${dbError.message}`);
        return { success: false, error: `Database update failed: ${dbError.message}` };
      }
    } else {
      return { success: false, error: 'No attachments found in email' };
    }
  } catch (error) {
    logger.error(`[update-attachment-status] error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// IPC handler: Delete email from local database
// IPC handler: Verify attachment file physically exists on disk
registerHandler('verify-attachment-file', async (event, { localPath, expectedSize, expectedHash }) => {
  if (!localPath) return { exists: false };
  
  const fileHashUtils = require('../files/file-hash-utils');
  
  try {
    const stats = await fsPromises.stat(localPath);
    
    // Basic check
    const exists = true;
    const sizeMatches = !expectedSize || stats.size === expectedSize;
    
    let hashMatches = false;
    let actualHash = null;
    let isReadable = false;
    
    // Check file readability
    try {
      await fsPromises.access(localPath, fsPromises.constants?.R_OK || fs.constants.R_OK);
      isReadable = true;
      
      // If an expected hash is provided, compute and compare the file hash
      if (expectedHash) {
        actualHash = await fileHashUtils.calculateFileHash(localPath);
        hashMatches = actualHash === expectedHash;
      }
    } catch (e) {
      isReadable = false;
      logger.warn(`[verify-attachment-file] File not readable: ${localPath}`);
    }
    
    const isValid = exists && isReadable && sizeMatches && (!expectedHash || hashMatches);
    
    return { 
      exists, 
      isReadable,
      sizeMatches, 
      actualSize: stats.size,
      hashMatches,
      actualHash,
      isValid
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { exists: false, isValid: false };
    }
    logger.error(`[verify-attachment-file] Check failed: ${err.message}`);
    return { exists: false, isValid: false, error: err.message };
  }
});

// IPC handler: Calculate file hash
registerHandler('calculate-file-hash', async (event, { filePath }) => {
  if (!filePath) {
    return { success: false, error: 'filePath is required' };
  }
  
  const fileHashUtils = require('../files/file-hash-utils');
  
  try {
    const hash = await fileHashUtils.calculateFileHash(filePath);
    return { success: true, hash };
  } catch (error) {
    logger.error(`[calculate-file-hash] Failed: ${error.message}`);
    return { success: false, error: error.message };
  }
});


registerHandler('delete-local-email', async (event, { username, emailId }) => {
  if (!username || !emailId) {
    logger.warn('delete-local-email: username and emailId are required');
    return { success: false, error: 'username and emailId are required' };
  }

  const dbPath = pathUtils.getUserDbPath(username);

  try {
    // Ensure database table structure exists
    await ensureDatabaseSchema(dbPath);

    // First query email data to get attachment info
    const emailData = await UnifiedDB.withORM(dbPath, async (orm) => {
      const row = await orm.table('recv').where({ id: emailId }).find();
      return row;
    });

    let deletedAttachments = [];
    let failedAttachments = [];

    // If the email exists and has attachments, delete local attachment files (async to avoid blocking)
    if (emailData && emailData.attachments) {
      try {
        let attachmentsList = [];
        if (typeof emailData.attachments === 'string') {
          attachmentsList = JSON.parse(emailData.attachments);
        } else if (Array.isArray(emailData.attachments)) {
          attachmentsList = emailData.attachments;
        }
        if (attachmentsList && Array.isArray(attachmentsList)) {
          // Use Promise.all to delete attachments in parallel
          const deletePromises = attachmentsList.map(async (attachment) => {
            if (attachment.localPath) {
              try {
                await fsPromises.unlink(attachment.localPath);
                deletedAttachments.push(attachment.filename);
                logger.info(`[delete-local-email] Deleted attachment file: ${attachment.localPath}`);
              } catch (attError) {
                // Missing files are not considered errors
                if (attError.code !== 'ENOENT') {
                  failedAttachments.push({ filename: attachment.filename, error: attError.message });
                  logger.error(`[delete-local-email] Failed to delete attachment file: ${attachment.localPath}, error: ${attError.message}`);
                }
              }
            }
          });
          await Promise.all(deletePromises);
        }
      } catch (parseError) {
        logger.warn(`[delete-local-email] Failed to parse email attachments: ${parseError.message}`);
      }
    }

    // Delete database records
    const changes = await UnifiedDB.withORM(dbPath, async (orm) => {
      return await orm.table('recv').where({ id: emailId }).delete();
    });

    logger.info(`delete-local-email: username=${username}, emailId=${emailId}, changes=${changes}, deletedAttachments=${deletedAttachments.length}`);
    return {
      success: true,
      changes,
      deletedAttachments,
      failedAttachments: failedAttachments.length > 0 ? failedAttachments : undefined
    };
  } catch (error) {
    logger.error(`delete-local-email error: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// IPC handler: Get unique senders from local database
registerHandler('get-local-senders', async (event, { username }) => {
  if (!username) {
    logger.warn('get-local-senders: username is required');
    return [];
  }

  const dbPath = pathUtils.getUserDbPath(username);

  try {
    // Ensure database table structure exists
    await ensureDatabaseSchema(dbPath);

    const sql = `SELECT DISTINCT sender, COUNT(*) as count
                 FROM recv
                 WHERE sender != ''
                 GROUP BY sender
                 ORDER BY count DESC`;

    const rows = await UnifiedDB.query(dbPath, sql);

    const senders = rows.map(row => ({
      email: row.sender,
      count: row.count
    }));

    logger.debug(`get-local-senders: username=${username}, count=${senders.length}`);
    return senders;
  } catch (error) {
    logger.error(`get-local-senders error: ${error.message}`);
    return [];
  }
});
