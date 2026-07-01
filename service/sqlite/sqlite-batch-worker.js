/**
 * SQLite batch operation Worker
 * Process database batch operations in an independent thread, avoid blocking the main thread
 * handle: batch insert, batch update, large-data transactions
 */

const sqlite3 = require('better-sqlite3');
const { parentPort } = require('worker_threads');
const path = require('path');
const logger = require('../logger');

class SQLiteBatchWorker {
  constructor() {
    this.db = null;
    this.dbPath = null;
  }

  /**
   * Initialize database connection
   * @param {string} dbPath - database file path
   */
  initializeDB(dbPath) {
    logger.info(`[SQLiteBatchWorker] Initializing database: ${dbPath}`);
    
    if (this.db) {
      logger.info('[SQLiteBatchWorker] Closing existing database connection');
      this.db.close();
    }
    
    this.dbPath = dbPath;
    
    try {
      // Configure SQLite to improve batch operation performance
      logger.info('[SQLiteBatchWorker] Creating new SQLite connection...');
      this.db = new sqlite3(dbPath);
      logger.info('[SQLiteBatchWorker] SQLite connection created successfully');
      
      // Performance optimization settings
      logger.info('[SQLiteBatchWorker] Applying performance optimizations...');
      this.db.pragma('journal_mode = WAL');           // Write-ahead logging mode for better concurrency
      this.db.pragma('synchronous = NORMAL');         // Don't sync to disk on every operation
      this.db.pragma('cache_size = 10000');           // Increase cache size
      this.db.pragma('temp_store = MEMORY');          // Use memory for temporary storage
      this.db.pragma('mmap_size = 30000000');         // Memory-mapped I/O
      this.db.pragma('page_size = 4096');             // Page size optimization
      this.db.pragma('busy_timeout = 5000');          // Busy timeout
      logger.info('[SQLiteBatchWorker] Performance optimizations applied');
      
      // Verify the database connection
      const testResult = this.db.prepare('SELECT 1 as test').get();
      logger.info(`[SQLiteBatchWorker] Database connection test: ${testResult.test === 1 ? 'PASSED' : 'FAILED'}`);
      
      return true;
    } catch (error) {
      logger.error(`[SQLiteBatchWorker] Failed to initialize database: ${error.message}`);
      logger.error(`[SQLiteBatchWorker] Error stack: ${error.stack}`);
      this.db = null;
      throw error;
    }
  }

  /**
   * Batch insert email records
   * @param {Array} emails - email data array
   * @returns {Object} - {success: boolean, insertedCount: number, errors: Array}
   */
  batchInsertEmails(emails) {
    logger.info(`[SQLiteBatchWorker] batchInsertEmails called, emails count: ${emails ? emails.length : 0}`);
    
    if (!this.db) {
      logger.error('[SQLiteBatchWorker] Database not initialized');
      return { success: false, error: 'Database not initialized' };
    }

    logger.info(`[SQLiteBatchWorker] Database path: ${this.dbPath}`);

    const results = {
      success: true,
      insertedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      errors: [],
      insertedIds: []
    };

    try {
      // 🔧 Use INSERT OR IGNORE to avoid duplicate inserts (based on message_id unique constraint)
      logger.info('[SQLiteBatchWorker] Preparing INSERT OR IGNORE statement...');
      const insertEmail = this.db.prepare(`
        INSERT OR IGNORE INTO recv (
          txtbody, htmbody, attachments, headers, priority,
          createtime, message_id, imap_uid, subject,
          sender, recipient, received_time, is_signaling, is_read
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      logger.info('[SQLiteBatchWorker] Statement prepared successfully');

      logger.info('[SQLiteBatchWorker] Starting transaction...');
      const transaction = this.db.transaction((emailsArray) => {
        logger.info(`[SQLiteBatchWorker] Transaction started, processing ${emailsArray.length} emails`);
        let insertedCount = 0;
        let failedCount = 0;
        let skippedCount = 0;
        let insertedIds = [];

        for (let i = 0; i < emailsArray.length; i++) {
          const email = emailsArray[i];
          try {
            // Validate email data integrity
            if (!email) {
              logger.warn(`[SQLiteBatchWorker] Email at index ${i} is null/undefined`);
              failedCount++;
              results.errors.push({
                email_id: `index_${i}`,
                error: 'Email data is null or undefined'
              });
              continue;
            }

            // Log key fields of the first and last emails for debugging
            if (i === 0 || i === emailsArray.length - 1) {
              logger.info(`[SQLiteBatchWorker] Processing email ${i}: message_id=${email.message_id}, sender=${email.sender}, subject=${email.subject?.substring(0, 50)}...`);
            }

            const result = insertEmail.run(
              email.txtbody,
              email.htmbody,
              email.attachments,
              email.headers,
              email.priority,
              email.createtime,
              email.message_id,
              email.imap_uid,
              email.subject,
              email.sender,
              email.recipient,
              email.received_time,
              email.is_signaling,
              email.is_read || 0
            );

            // 🔍 Check whether the insert actually happened (changes > 0 means success, =0 means ignored/duplicate)
            if (result.changes > 0) {
              insertedCount++;
              insertedIds.push(result.lastInsertRowid);
            } else {
              // IGNORED, which means duplicate data
              skippedCount++;
              logger.info(`[SQLiteBatchWorker] Email skipped (duplicate): message_id=${email.message_id}`);
            }
          } catch (error) {
            failedCount++;
            logger.error(`[SQLiteBatchWorker] Failed to insert email ${i}: ${error.message}`);
            logger.error(`[SQLiteBatchWorker] Email data: message_id=${email?.message_id}, sender=${email?.sender}`);
            results.errors.push({
              email_id: email?.message_id || `index_${i}`,
              error: error.message,
              stack: error.stack
            });
          }
        }

        logger.info(`[SQLiteBatchWorker] Transaction completed: inserted=${insertedCount}, skipped=${skippedCount}, failed=${failedCount}`);
        return { insertedCount, failedCount, skippedCount, insertedIds };
      });

      logger.info('[SQLiteBatchWorker] Executing transaction...');
      const transactionResult = transaction(emails);
      logger.info('[SQLiteBatchWorker] Transaction executed successfully');
      
      results.insertedCount = transactionResult.insertedCount;
      results.failedCount = transactionResult.failedCount;
      results.skippedCount = transactionResult.skippedCount;
      results.insertedIds = transactionResult.insertedIds;

      // Log deduplication info
      if (results.skippedCount > 0) {
        logger.info(`[SQLiteBatchWorker] Skipped ${results.skippedCount} duplicate emails during batch insert`);
      }

      logger.info(`[SQLiteBatchWorker] Final results: success=${results.success}, inserted=${results.insertedCount}, skipped=${results.skippedCount}, failed=${results.failedCount}, errors=${results.errors.length}`);

    } catch (error) {
      logger.error(`[SQLiteBatchWorker] Critical error in batchInsertEmails: ${error.message}`);
      logger.error(`[SQLiteBatchWorker] Error stack: ${error.stack}`);
      results.success = false;
      results.error = error.message;
      results.errorStack = error.stack;
    }

    return results;
  }

  /**
   * Batch update email read status
   * @param {Array} updates - [{message_id: string, is_read: 0|1},...]
   * @returns {Object} - {success: boolean, updatedCount: number}
   */
  batchUpdateReadStatus(updates) {
    if (!this.db) {
      return { success: false, error: 'Database not initialized' };
    }

    const results = {
      success: true,
      updatedCount: 0,
      failedCount: 0,
      errors: []
    };

    try {
      const updateStatus = this.db.prepare(`
        UPDATE recv SET is_read = ? WHERE message_id = ?
      `);

      const transaction = this.db.transaction((updatesArray) => {
        let updatedCount = 0;
        let failedCount = 0;

        for (const update of updatesArray) {
          try {
            const result = updateStatus.run(update.is_read, update.message_id);
            if (result.changes > 0) {
              updatedCount += result.changes;
            }
          } catch (error) {
            failedCount++;
            results.errors.push({
              message_id: update.message_id,
              error: error.message
            });
          }
        }

        return { updatedCount, failedCount };
      });

      const transactionResult = transaction(updates);
      results.updatedCount = transactionResult.updatedCount;
      results.failedCount = transactionResult.failedCount;

    } catch (error) {
      results.success = false;
      results.error = error.message;
    }

    return results;
  }

  /**
   * Batch delete data (used to clean up expired records)
   * @param {string} table - table name
   * @param {string} whereClause - WHERE clause
   * @param {Array} params - parameters
   * @returns {Object} - {success: boolean, deletedCount: number}
   */
  batchDelete(table, whereClause, params = []) {
    if (!this.db) {
      return { success: false, error: 'Database not initialized' };
    }

    try {
      const sql = `DELETE FROM ${table} WHERE ${whereClause}`;
      const stmt = this.db.prepare(sql);
      const result = stmt.run(...params);
      
      return {
        success: true,
        deletedCount: result.changes
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Batch insert or replace(UPSERT)
   * @param {Array} records - records array
   * @returns {Object} - {success: boolean, affectedCount: number}
   */
  batchUpsertContact(records) {
    if (!this.db) {
      return { success: false, error: 'Database not initialized' };
    }

    const results = {
      success: true,
      affectedCount: 0,
      failedCount: 0,
      errors: []
    };

    try {
      const upsert = this.db.prepare(`
        INSERT OR REPLACE INTO contact (nickname, rmkname, username, avatar)
        VALUES (?, ?, ?, ?)
      `);

      const transaction = this.db.transaction((recordsArray) => {
        let affectedCount = 0;
        let failedCount = 0;

        for (const record of recordsArray) {
          try {
            const result = upsert.run(
              record.nickname,
              record.nickname,
              record.username,
              record.avatar || ''
            );
            affectedCount += result.changes;
          } catch (error) {
            failedCount++;
            results.errors.push({
              username: record.username,
              error: error.message
            });
          }
        }

        return { affectedCount, failedCount };
      });

      const transactionResult = transaction(records);
      results.affectedCount = transactionResult.affectedCount;
      results.failedCount = transactionResult.failedCount;

    } catch (error) {
      results.success = false;
      results.error = error.message;
    }

    return results;
  }

  /**
   * Check whether email exists(based on message_id)
   * @param {string} messageId - email message_id
   * @returns {Object} - {success: boolean, exists: boolean}
   */
  checkEmailExists(messageId) {
    if (!this.db) {
      return { success: false, error: 'Database not initialized' };
    }

    try {
      const stmt = this.db.prepare('SELECT message_id FROM recv WHERE message_id = ?');
      const result = stmt.get(messageId);
      return {
        success: true,
        exists: !!result
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Save a single email to the database
   * @param {Object} email - emaildata
   * @returns {Object} - {success: boolean, insertedId: number|null}
   */
  saveSingleEmail(email) {
    if (!this.db) {
      return { success: false, error: 'Database not initialized' };
    }

    try {
      const insertEmail = this.db.prepare(`
        INSERT OR IGNORE INTO recv (
          txtbody, htmbody, attachments, headers, priority,
          createtime, message_id, imap_uid, subject,
          sender, recipient, received_time, is_signaling, is_read
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const result = insertEmail.run(
        email.txtbody,
        email.htmbody,
        email.attachments,
        email.headers,
        email.priority,
        email.createtime,
        email.message_id,
        email.imap_uid,
        email.subject,
        email.sender,
        email.recipient,
        email.received_time,
        email.is_signaling,
        email.is_read || 0
      );

      if (result.changes > 0) {
        return {
          success: true,
          insertedId: result.lastInsertRowid,
          wasInserted: true
        };
      } else {
        return {
          success: true,
          insertedId: null,
          wasInserted: false
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Auto-add contact(ifdoes not exist)
   * @param {Object} contactData - contactdata {email, name, dbPath}
   * @returns {Object} - {success: boolean, contactId: number|null, wasAdded: boolean}
   */
  autoAddSingleContact(contactData) {
    if (!this.db) {
      return { success: false, error: 'Database not initialized' };
    }

    try {
      const { email, name, currentUserEmail } = contactData;
      const normalizedEmail = email.trim().toLowerCase();

      // Cannot add self
      if (normalizedEmail === currentUserEmail) {
        return {
          success: true,
          contactId: null,
          wasAdded: false,
          skipped: true
        };
      }

      // Check if contact already exists
      const checkStmt = this.db.prepare('SELECT id FROM contact WHERE lower(username) = lower(?)');
      const existing = checkStmt.get(normalizedEmail);
      if (existing) {
        // ✅ If the contact already exists, skip processing without modifying any info
        return {
          success: true,
          contactId: existing.id,
          wasAdded: false,
          alreadyExists: true
        };
      }

      // If the contact does not exist, add it as a pending contact (status=-50)
      // Extract display name
      let nickname = name || '';
      if (!nickname && normalizedEmail.includes('@')) {
        nickname = normalizedEmail.split('@')[0];
      }

      // Insert new contact
      const insertStmt = this.db.prepare(`
        INSERT INTO contact (nickname, rmkname, username, avatar, status)
        VALUES (?, ?, ?, ?, ?)
      `);

      const result = insertStmt.run(
        nickname || '',
        nickname || '',
        email.trim(),
        '',
        -50  // ✅ New email sender is a pending contact (status=-50)
      );

      return {
        success: true,
        contactId: result.lastInsertRowid,
        wasAdded: true
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Database cleanup and optimization
   * @returns {Object} - {success: boolean, message: string}
   */
  vacuumAndOptimize() {
    if (!this.db) {
      return { success: false, error: 'Database not initialized' };
    }

    try {
      // VACUUM: reduce database file size and defragment
      this.db.exec('VACUUM');
      
      // Analyze to optimize the query plan
      this.db.exec('ANALYZE');
      
      return {
        success: true,
        message: 'Database vacuumed and analyzed'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get database statistics
   * @returns {Object} - statisticsinfo
   */
  getStats() {
    if (!this.db) {
      return { success: false, error: 'Database not initialized' };
    }

    try {
      const recvCount = this.db.prepare('SELECT COUNT(*) as count FROM recv').get();
      const sendCount = this.db.prepare('SELECT COUNT(*) as count FROM send').get();
      const messageCount = this.db.prepare('SELECT COUNT(*) as count FROM message').get();
      const contactCount = this.db.prepare('SELECT COUNT(*) as count FROM contact').get();

      return {
        success: true,
        stats: {
          recv: recvCount.count,
          send: sendCount.count,
          message: messageCount.count,
          contact: contactCount.count
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Close database connection
   */
  closeDB() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

// Create Worker instance
const worker = new SQLiteBatchWorker();

// Listen to messages from the main thread
parentPort.on('message', (message) => {
  const { type, dbPath, payload, id } = message;
  
  logger.info(`[SQLiteBatchWorker] Received message: type=${type}, id=${id}`);

  try {
    let result;

    switch (type) {
      case 'init':
        logger.info(`[SQLiteBatchWorker] Processing 'init' message for dbPath: ${dbPath}`);
        result = worker.initializeDB(dbPath);
        logger.info(`[SQLiteBatchWorker] 'init' completed, sending response`);
        parentPort.postMessage({ id, success: result, type: 'init' });
        break;

      case 'batchInsertEmails':
        logger.info(`[SQLiteBatchWorker] Processing 'batchInsertEmails' message, payload count: ${payload ? payload.length : 0}`);
        result = worker.batchInsertEmails(payload);
        logger.info(`[SQLiteBatchWorker] 'batchInsertEmails' completed, result: success=${result.success}, inserted=${result.insertedCount}`);
        parentPort.postMessage({ id, result, type: 'batchInsertEmails' });
        break;

      case 'batchUpdateReadStatus':
        result = worker.batchUpdateReadStatus(payload);
        parentPort.postMessage({ id, result, type: 'batchUpdateReadStatus' });
        break;

      case 'batchDelete':
        result = worker.batchDelete(payload.table, payload.whereClause, payload.params);
        parentPort.postMessage({ id, result, type: 'batchDelete' });
        break;

      case 'batchUpsertContact':
        result = worker.batchUpsertContact(payload);
        parentPort.postMessage({ id, result, type: 'batchUpsertContact' });
        break;

      case 'checkEmailExists':
        result = worker.checkEmailExists(payload);
        parentPort.postMessage({ id, result, type: 'checkEmailExists' });
        break;

      case 'saveSingleEmail':
        result = worker.saveSingleEmail(payload);
        parentPort.postMessage({ id, result, type: 'saveSingleEmail' });
        break;

      case 'autoAddSingleContact':
        result = worker.autoAddSingleContact(payload);
        parentPort.postMessage({ id, result, type: 'autoAddSingleContact' });
        break;

      case 'vacuumAndOptimize':
        result = worker.vacuumAndOptimize();
        parentPort.postMessage({ id, result, type: 'vacuumAndOptimize' });
        break;

      case 'getStats':
        result = worker.getStats();
        parentPort.postMessage({ id, result, type: 'getStats' });
        break;

      case 'close':
        worker.closeDB();
        parentPort.postMessage({ id, success: true, type: 'close' });
        break;

      default:
        parentPort.postMessage({
          id,
          error: `Unknown message type: ${type}`,
          type: 'error'
        });
    }
  } catch (error) {
    logger.error(`[SQLiteBatchWorker] Unhandled error processing message type=${type}, id=${id}: ${error.message}`);
    logger.error(`[SQLiteBatchWorker] Error stack: ${error.stack}`);
    parentPort.postMessage({
      id,
      error: error.message,
      errorStack: error.stack,
      type: 'error'
    });
  }
});
