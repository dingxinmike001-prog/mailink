/**

 * IMAP email service module

 * Responsible for IMAP email fetch, parse, store, and delete operations

 */

const Imap = require('imap');

const path = require('path');

const TPishSQLite = require('../sqlite/tpish-sqlite');



// Import the logger module

const logger = require('../logger');



// Import path utilities

const pathUtils = require('../../shared/path/path-utils');



// Import IPC manager

const { registerHandler } = require('../../shared/ipc/ipc-manager');



// Import unified Worker manager factory

const { createWorkerManager } = require('../../shared/worker/worker-factory');



// Import rate limiter

const { RateLimiter } = require('../utils/rate-limiter');



// Import config builder utilities

const { buildSmtpConfig, buildImapConfig } = require('../utils/config-builder');



// Import database helper

const { getDatabase, saveEmailToDatabase, batchSaveEmailsToDatabase, flushEmailBuffer } = require('./imap-database');



// Import connection manager

const connectionManager = require('./imap-connection-manager');



// Import contact backup restore module

const { restoreContactBackup } = require('./contact-backup-restore');



// Import contact backup module

const { backupContacts } = require('./contact-backup');



// Import email-to-chat message module

const { insertEmailsAsChatMessages, processNewEmailsAndNotify } = require('./email-to-chat-message');



// Create rate limiter instance (3-second interval)

const fetchRateLimiter = new RateLimiter({

    intervalMs: 3000,

    autoWait: true,

    logger: (msg) => logger.debug(msg)

});



// Create SMTP Worker manager instance (used to warm up SMTP during IMAP login)

const smtpWorkerManager = createWorkerManager('smtp');



// Store timestamp of last email fetch per user (for rate limiting)

const lastFetchTimes = new Map();



/**

 * IPC handler: test IMAP connection

 * @param {Object} event - Electron IPC event object

 * @param {Object} config - IMAP config {username, password, host, port, tls}

 * @returns {Promise<Object>} Connection result and status info

 */

registerHandler('login-imap-connection', async (event, config) => {

  // Create logger instance with username at login start

  const userDefaultLogger = logger.Logger.getInstance('default', { username: config.username });

  // Get or create IMAP logger instance for current mailbox

  const imapLogger = require('./imap-logger').getInstance(config.username);

  

  // Use logger instance with username to log login start

  userDefaultLogger.info('Testing IMAP connection...', { username: config.username, host: config.host });

  

  // ✅ New: warm up SMTP immediately at IMAP login start (non-blocking, async in background)

  // SMTP warm-up and IMAP connection are parallel, total time is max(IMAP time, SMTP time)

  userDefaultLogger.debug('Starting parallel SMTP prewarm while IMAP login is in progress...');

  smtpWorkerManager.sendTask({

    taskType: 'prewarm-smtp',

    config: config,  // Use the same config, including username, password, smtpHost, smtpPort, etc.

    emailData: null

  }).then((result) => {

    if (result && result.success) {

      userDefaultLogger.debug('SMTP prewarm completed', {

        cached: result.data?.cached,

        duration: 'parallel with IMAP login'

      });

    } else {

      userDefaultLogger.warn('SMTP prewarm encountered issue', {

        error: result?.error

      });

    }

  }).catch((err) => {

    // SMTP warm-up failure does not affect IMAP login, only log warning

    userDefaultLogger.warn('SMTP prewarm request error (non-blocking)', {

      error: err?.message

    });

  });



  // ✅ New: asynchronously create mailink_info folder at IMAP login start (non-blocking, background)

  // Wait for IMAP connection to be established before creating folder

  const createMailinkFolderAsync = async () => {

    try {

      // Wait for IMAP connection to establish (up to 30 seconds)

      let attempts = 0;

      const maxAttempts = 30;

      while (attempts < maxAttempts) {

        const status = connectionManager.getStatus(config.username);

        if (status.connected) {

          break;

        }

        await new Promise(resolve => setTimeout(resolve, 1000));

        attempts++;

      }



      if (attempts >= maxAttempts) {

        userDefaultLogger.warn('[createMailinkFolder] waitingIMAPconnection timeout, skipped folder creation');

        return;

      }



      // Create mailink_info folder

      const folderName = 'mailink_info';

      userDefaultLogger.debug(`[createMailinkFolder] started creating folder: ${folderName}`);

      const result = await connectionManager.createFolder(config.username, folderName);



      if (result.success) {

        if (result.created) {

          userDefaultLogger.info(`[createMailinkFolder] folder created successfully: ${folderName}`);

        } else {

          userDefaultLogger.debug(`[createMailinkFolder] folder already exists: ${folderName}`);

        }

      } else {

        userDefaultLogger.warn(`[createMailinkFolder] folder creation failed: ${result.error}`);

      }

    } catch (err) {

      // Folder creation failure does not affect IMAP login, only log warning

      userDefaultLogger.warn('[createMailinkFolder] folder creation exception (non-blocking)', {

        error: err?.message

      });

    }

  };



  // Start async folder creation (do not wait)

  createMailinkFolderAsync();

  

  // Clear log directory via worker thread (wait for completion before continuing)

  userDefaultLogger.info('Sending clear logs request to worker thread...');

  try {

    const clearResult = await imapManagementWorkerManager.sendTask({

      action: 'clearLogs',

      config: { username: config.username } // Pass only necessary config

    }, 10000); // 10-second timeout



    if (clearResult && clearResult.message) {

      userDefaultLogger.info('Log directory clear result:', clearResult.message);

      if (clearResult.errors && clearResult.errors.length > 0) {

        userDefaultLogger.warn('Some log files could not be deleted:', clearResult.errors);

      }

    } else {

      userDefaultLogger.info('Log directory clear request completed');

    }

  } catch (err) {

    const errorMsg = err?.message || err?.toString() || 'Unknown error';

    userDefaultLogger.error('Failed to clear log directory via worker:', errorMsg);

    // clear log failure does not affect login flow，continue execution

  }



  // Create log files distinguished by email account (after clearing log directory)

  userDefaultLogger.info('Creating log files for IMAP account...', { username: config.username });



  // Create log file

  userDefaultLogger.createLogFile();



  // Use connection manager to create or reuse long-lived connection

  const { imap, box } = await connectionManager.getConnection(config);



  // Get connection status (including IDLE support info)

  const status = connectionManager.getStatus(config.username);



  userDefaultLogger.info('IMAP long connection established');



  // Return login success result

  const loginResult = {

    success: true,

    message: 'IMAP connection successful (long connection)',

    inboxInfo: {

      total: box.messages.total,

      unread: box.messages.new

    },

    supportsIdle: status.supportsIdle || false,  // whether supportedIDLEmode

    idleEnabled: status.idleEnabled || false     // Whether IDLE mode is enabled

  };



  // Execute contact backup restore and backup asynchronously (does not block login flow)

  userDefaultLogger.info('[ContactBackupRestore] started contact backup restore flow (background async)');

  restoreContactBackup(config, event).then(async (restoreResult) => {

    if (restoreResult.success) {

      userDefaultLogger.info(`[ContactBackupRestore] restore succeeded: ${restoreResult.message}`);

    } else if (restoreResult.emailFound) {

      userDefaultLogger.warn(`[ContactBackupRestore] restore not fully successful: ${restoreResult.message}`);

    } else {

      userDefaultLogger.info(`[ContactBackupRestore] no restore needed: ${restoreResult.message}`);

    }



    // After restore completes, execute contact backup (regardless of restore success or need)

    userDefaultLogger.info('[ContactBackup] restore flow completed, started executing contact backup');

    try {

      // Use config builder utility to create SMTP and IMAP configurations

      const smtpConfig = buildSmtpConfig(config);

      const imapConfig = buildImapConfig(config);



      const backupResult = await backupContacts(config.username, smtpConfig, imapConfig);

      if (backupResult.success) {

        userDefaultLogger.info(`[ContactBackup] backup completed: ${backupResult.message}`);

      } else {

        userDefaultLogger.warn(`[ContactBackup] backup failed: ${backupResult.error}`);

      }

    } catch (backupErr) {

      userDefaultLogger.warn(`[ContactBackup] backup process error (non-blocking): ${backupErr.message}`);

    }

  }).catch((err) => {

    userDefaultLogger.warn(`[ContactBackupRestore] restore process error (non-blocking): ${err.message}`);



    // Try to execute backup even if restore throws an exception

    userDefaultLogger.info('[ContactBackup] restore flow exception, still trying to execute contact backup');

    try {

      // Use config builder utility to create SMTP and IMAP configurations

      const smtpConfig = buildSmtpConfig(config);

      const imapConfig = buildImapConfig(config);



      backupContacts(config.username, smtpConfig, imapConfig).then((backupResult) => {

        if (backupResult.success) {

          userDefaultLogger.info(`[ContactBackup] backup completed: ${backupResult.message}`);

        } else {

          userDefaultLogger.warn(`[ContactBackup] backup failed: ${backupResult.error}`);

        }

      }).catch((backupErr) => {

        userDefaultLogger.warn(`[ContactBackup] backup process error (non-blocking): ${backupErr.message}`);

      });

    } catch (e) {

      userDefaultLogger.warn(`[ContactBackup] backup initialization failed (non-blocking): ${e.message}`);

    }

  });



  return loginResult;

});



// Create IMAP management Worker manager (used for clearing logs, searching/deleting emails, deleting by UID)

const imapManagementWorkerManager = createWorkerManager('imapManagement');



// Create signaling email dedicated Worker manager (used for fetching signaling emails)

const imapSignalingWorkerManager = createWorkerManager('imapSignaling');



// Create normal email dedicated Worker manager (used for fetching normal emails)

const imapNormalWorkerManager = createWorkerManager('imapNormal');



// Create email body download Worker manager

const fetchEmailBodyWorkerManager = createWorkerManager('fetchEmailBody');



/**

 * Fetch signaling emails using a dedicated Worker thread

 * @param {Object} config - IMAP configuration

 * @param {number} minutes - Fetch emails within how many minutes

 * @returns {Promise<Array>} - Parsed email array

 */

const fetchSignalingEmailsWithWorker = async (config, minutes) => {

  return imapSignalingWorkerManager.sendTask({

    action: 'fetchSignalingEmails',

    config,

    minutes

  }, 60000); // Set signaling email timeout to 60 seconds

};



/**

 * Fetch normal emails using a dedicated Worker thread

 * @param {Object} config - IMAP configuration

 * @param {number} minutes - Fetch emails within how many minutes (normal emails use 7 days)

 * @returns {Promise<Array>} - Parsed email array

 */

const fetchNormalEmailsWithWorker = async (config, minutes) => {

  return imapNormalWorkerManager.sendTask({

    action: 'fetchNormalEmails',

    config,

    minutes: minutes || 10080 // Use passed parameters, default to 7 days

  }, 300000);

};



/**

 * IPC handler: connect to IMAP and fetch emails

 * Use separate Workers based on the onlySignaling parameter:

 * - onlySignaling=true: use signaling email dedicated Worker (imapSignalingWorkerManager)

 * - onlySignaling=false: use normal email dedicated Worker (imapNormalWorkerManager)

 */

registerHandler('fetch-emails', async (event, config, minutes, onlySignaling) => {

  if (!config || typeof config !== 'object') {

    throw new Error('Invalid IMAP config');

  }

  if (!config.username) {

    throw new Error('Invalid IMAP config: missing username');

  }

  if (typeof minutes !== 'number' || Number.isNaN(minutes)) {

    minutes = 2;

  }

  onlySignaling = !!onlySignaling;



  const username = config.username;

  const now = Date.now();



  // Get user-specific logger instance

  const userLogger = logger.Logger.getInstance('default', { username: config.username });



  userLogger.info('Starting to fetch emails...', { username: username, minutes: minutes, onlySignaling: onlySignaling });



  // Use rate limiter to check email fetch frequency

  const rateLimitResult = await fetchRateLimiter.throttle(username);

  if (rateLimitResult.waitTime > 0) {

    userLogger.debug(`[fetch-emails] rate limit, waiting ${rateLimitResult.waitTime}ms then execute: ${username}`);

  }



  let db = null;

  try {

    // Initialize database connection

    db = getDatabase(config.username);



    // Choose corresponding Worker based on onlySignaling parameter

    let emails;

    if (onlySignaling) {

      userLogger.info('[fetch-emails] using signaling email dedicated Worker fetch email');

      emails = await fetchSignalingEmailsWithWorker(config, minutes);

    } else {

      userLogger.info('[fetch-emails] using regular email dedicated Worker fetch email');

      emails = await fetchNormalEmailsWithWorker(config, minutes);

    }

    if (!Array.isArray(emails)) {

      userLogger.warn('Worker returned non-array emails result', { username, minutes, onlySignaling });

      return [];

    }



    const validEmails = emails.filter(Boolean);

    userLogger.debug(`Fetched ${validEmails.length} emails`);



    // Save all emails to database (using batch operations - 40-60% performance improvement)

    let hasNewEmailsSaved = false;

    if (validEmails.length > 0) {

      try {

        // Save all emails using batch operations, enable buffering to accumulate batches

        const batchResult = await batchSaveEmailsToDatabase(config.username, validEmails, true);

        

        userLogger.info(`Email save summary: ${batchResult.savedCount} saved, ${batchResult.skippedCount} skipped/duplicates`);

        

        if (batchResult.errors && batchResult.errors.length > 0) {

          userLogger.warn(`Save errors: ${JSON.stringify(batchResult.errors.slice(0, 3))}`);

        }



        if (batchResult.savedCount > 0) {

          hasNewEmailsSaved = true;

        }



        // If new emails saved successfully, notify frontend to update unread count

        if (hasNewEmailsSaved && global.mainWindow && global.mainWindow.webContents) {

          try {

            global.mainWindow.webContents.send('recv-emails-updated', {

              username: config.username,

              newCount: batchResult.savedCount

            });

            userLogger.info(`[IMAP] notified renderer process to update unread count: ${config.username}, newly added: ${batchResult.savedCount}`);

          } catch (notifyError) {

            userLogger.error(`[IMAP] failed to notify renderer process to update unread count: ${config.username}`, notifyError);

          }

        }



        // ✅ Auto-insert chat messages for normal emails + trigger full notification flow (badge, icon flashing, voice prompt)

        // New function auto: filter unread emails + filter signaling emails + insert messages + trigger notifications

        if (!onlySignaling && validEmails.length > 0) {

          try {

            userLogger.info(`[ChatMessage] Starting to process ${validEmails.length} emails for chat messages with full notification`);

            

            // Use new handler: auto-process unread emails and trigger full notifications (badge+icon flashing+voice prompt)

            const result = await processNewEmailsAndNotify(config.username, validEmails, config);

            const msgStats = result.stats;

            

            userLogger.info(`[ChatMessage] Processing result: inserted=${msgStats.inserted}, skipped=${msgStats.skipped}, errors=${msgStats.errors.length}`);

            

            if (msgStats.inserted > 0) {

              userLogger.info(`[ChatMessage] ✅ Inserted ${msgStats.inserted} chat messages, skipped ${msgStats.skipped}`);

            } else if (msgStats.skipped > 0) {

              userLogger.info(`[ChatMessage] ⏭️ Skipped ${msgStats.skipped} emails (already read or non-valid contacts)`);

            }

            

            if (msgStats.errors.length > 0) {

              userLogger.warn(`[ChatMessage] ⚠️ Encountered ${msgStats.errors.length} errors during processing`);

            }

          } catch (error) {

            userLogger.error(`[ChatMessage] ❌ Error processing emails as chat messages: ${error.message}`, error);

          }

        } else {

          // Debug log: why it didn't execute

          if (onlySignaling) {

            userLogger.debug(`[ChatMessage] Skipped (onlySignaling=${onlySignaling})`);

          } else if (validEmails.length === 0) {

            userLogger.debug(`[ChatMessage] Skipped (validEmails.length=${validEmails.length})`);

          }

        }

      } catch (error) {

        userLogger.error(`Failed to batch save emails: ${error.message}`, { username: config.username });

        // Fallback to single-row save

        let savedCount = 0;

        let skippedCount = 0;

        const dbPath = pathUtils.getUserDbPath(config.username);



        for (const email of validEmails) {

          try {

            const result = await saveEmailToDatabase(dbPath, email, email.uid);

            if (result) {

              savedCount++;

              hasNewEmailsSaved = true;

            } else {

              skippedCount++;

            }

          } catch (saveError) {

            userLogger.error(`Failed to save email to database: ${saveError.message}`, { subject: email.subject });

            skippedCount++;

          }

        }



        userLogger.info(`Fallback save summary: ${savedCount} saved, ${skippedCount} skipped (using single-insert mode)`);



        if (hasNewEmailsSaved && global.mainWindow && global.mainWindow.webContents) {

          try {

            global.mainWindow.webContents.send('recv-emails-updated', {

              username: config.username,

              newCount: savedCount

            });

            userLogger.info(`[IMAP] notified renderer process to update unread count: ${config.username}, newly added: ${savedCount}`);

          } catch (notifyError) {

            userLogger.error(`[IMAP] failed to notify renderer process to update unread count: ${config.username}`, notifyError);

          }

        }



        // ✅ New: insert chat messages for normal emails (fallback mode)

        if (!onlySignaling && savedCount > 0 && validEmails.length > 0) {

          try {

            userLogger.info(`[ChatMessage] Starting to process ${validEmails.length} emails for chat messages (fallback mode)`);

            

            // Use new handler: auto-process unread emails and trigger full notifications (fallback mode)

            const result = await processNewEmailsAndNotify(config.username, validEmails, config);

            const msgStats = result.stats;

            

            userLogger.info(`[ChatMessage] Processing result (fallback): inserted=${msgStats.inserted}, skipped=${msgStats.skipped}, errors=${msgStats.errors.length}`);

            

            if (msgStats.inserted > 0) {

              userLogger.info(`[ChatMessage] ✅ Inserted ${msgStats.inserted} chat messages, skipped ${msgStats.skipped} (fallback mode)`);

            } else if (msgStats.skipped > 0) {

              userLogger.info(`[ChatMessage] ⏭️ Skipped ${msgStats.skipped} emails (fallback mode)`);

            }

          } catch (error) {

            userLogger.error(`[ChatMessage] Error processing emails as chat messages (fallback): ${error.message}`, error);

          }

        }

      }

    }



    // ✅ New: when fetching normal emails, try to move contact backup emails to mailink_info folder

    // Only execute during non-signaling email fetch to avoid duplicate operations

    if (!onlySignaling) {

      userLogger.info('[ContactBackup] regular mail fetch completed, trying to move contact backup emails to mailink_info folder');

      

      // Execute email move asynchronously (does not block return result)

      const { moveBackupEmailToFolder } = require('./contact-backup');

      const imapConfig = {

        host: config.host,

        port: config.port,

        tls: config.tls,

        username: config.username,

        password: config.password

      };

      

      // Use a longer time window for search (within 1 day) to catch previously unmoved backup emails

      const searchStartTime = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago

      

      moveBackupEmailToFolder(username, imapConfig, null).then(moveResult => {

        if (moveResult.success) {

          if (moveResult.moved > 0) {

            userLogger.info(`[ContactBackup] moved backup emails successfully while fetching: ${moveResult.moved} emails moved to mailink_info`);

          } else {

            userLogger.debug(`[ContactBackup] no backup emails to move found while fetching`);

          }

        } else {

          userLogger.warn(`[ContactBackup] failed to move backup emails while fetching: ${moveResult.error}`);

        }

      }).catch(err => {

        userLogger.warn(`[ContactBackup] exception moving backup emails while fetching (non-blocking): ${err.message}`);

      });

    }



    return validEmails;

  } finally {

    // Ensure database connection is closed in all cases

    if (db) {

      try {

        await db.close();

        userLogger.debug('Database connection closed successfully');

      } catch (closeErr) {

        userLogger.error('Error closing database:', closeErr);

      }

    }

  }

}, { timeout: 350000 });



/**

 * IPC handler: fetch signaling and normal emails in parallel

 * Use two independent Workers simultaneously without blocking each other

 */

registerHandler('fetch-emails-parallel', async (event, config, signalingMinutes = 2) => {

  if (!config || typeof config !== 'object') {

    throw new Error('Invalid IMAP config');

  }

  if (!config.username) {

    throw new Error('Invalid IMAP config: missing username');

  }



  const username = config.username;

  const userLogger = logger.Logger.getInstance('default', { username });



  userLogger.info('[Parallel] Starting parallel fetch for signaling and normal emails...', { username, signalingMinutes });



  // Check email receiving rate limit

  const now = Date.now();

  const lastFetchTime = lastFetchTimes.get(username) || 0;

  const timeSinceLastFetch = now - lastFetchTime;



  if (timeSinceLastFetch < 3000) {

    const waitTime = 3000 - timeSinceLastFetch;

    userLogger.debug(`[Parallel] Rate limit, waiting ${waitTime}ms: ${username}`);

    lastFetchTimes.set(username, now + waitTime);

    await new Promise(resolve => setTimeout(resolve, waitTime));

  } else {

    lastFetchTimes.set(username, now);

  }



  let db = null;

  try {

    db = getDatabase(config.username);



    // Execute signaling and normal email fetch in parallel

    const startTime = Date.now();

    const [signalingResult, normalResult] = await Promise.allSettled([

      fetchSignalingEmailsWithWorker(config, signalingMinutes),

      fetchNormalEmailsWithWorker(config, 10080)

    ]);

    const duration = Date.now() - startTime;



    // Handle signaling email result

    let signalingEmails = [];

    if (signalingResult.status === 'fulfilled') {

      signalingEmails = Array.isArray(signalingResult.value) ? signalingResult.value.filter(Boolean) : [];

      userLogger.info(`[Parallel] Signaling emails fetched: ${signalingEmails.length} in ${duration}ms`);

    } else {

      userLogger.error(`[Parallel] Signaling emails fetch failed: ${signalingResult.reason?.message || signalingResult.reason}`);

    }



    // Handle normal email result

    let normalEmails = [];

    if (normalResult.status === 'fulfilled') {

      normalEmails = Array.isArray(normalResult.value) ? normalResult.value.filter(Boolean) : [];

      userLogger.info(`[Parallel] Normal emails fetched: ${normalEmails.length} in ${duration}ms`);

    } else {

      userLogger.error(`[Parallel] Normal emails fetch failed: ${normalResult.reason?.message || normalResult.reason}`);

    }



    // Merge all emails

    const allEmails = [...signalingEmails, ...normalEmails];



    // Batch save to database

    let hasNewEmailsSaved = false;

    if (allEmails.length > 0) {

      try {

        const batchResult = await batchSaveEmailsToDatabase(config.username, allEmails, true);

        userLogger.info(`[Parallel] Email save summary: ${batchResult.savedCount} saved, ${batchResult.skippedCount} skipped`);



        if (batchResult.errors && batchResult.errors.length > 0) {

          userLogger.warn(`[Parallel] Save errors: ${JSON.stringify(batchResult.errors.slice(0, 3))}`);

        }



        if (batchResult.savedCount > 0) {

          hasNewEmailsSaved = true;

        }



        // Notify frontend to update

        if (hasNewEmailsSaved && global.mainWindow && global.mainWindow.webContents) {

          try {

            global.mainWindow.webContents.send('recv-emails-updated', {

              username: config.username,

              newCount: batchResult.savedCount

            });

          } catch (notifyError) {

            userLogger.error(`[Parallel] Failed to notify UI: ${notifyError.message}`);

          }

        }

      } catch (error) {

        userLogger.error(`[Parallel] Failed to save emails: ${error.message}`);

      }

    }



    // Move contact backup emails asynchronously

    if (normalEmails.length > 0) {

      userLogger.info('[ContactBackup] Fetch complete, trying to move backup emails');

      const { moveBackupEmailToFolder } = require('./contact-backup');

      const imapConfig = { host: config.host, port: config.port, tls: config.tls, username, password: config.password };

      moveBackupEmailToFolder(username, imapConfig, null).catch(err => {

        userLogger.warn(`[ContactBackup] Move backup emails failed: ${err.message}`);

      });

    }



    return {

      signalingEmails,

      normalEmails,

      totalCount: allEmails.length,

      duration

    };



  } finally {

    if (db) {

      try {

        await db.close();

        userLogger.debug('[Parallel] Database connection closed');

      } catch (closeErr) {

        userLogger.error('[Parallel] Error closing database:', closeErr);

      }

    }

  }

}, { timeout: 350000 });



/**

 * IPC handler: search and delete IMAP emails

 */

registerHandler('search-and-delete-emails', async (event, config, sender, subjectPrefix, options = {}) => {

  const username = config.username;

  const now = Date.now();



  // Get user-specific logger instance

  const userLogger = logger.Logger.getInstance('default', { username: config.username });



  // Check email receiving rate limit

  const lastFetchTime = lastFetchTimes.get(username) || 0;

  const timeSinceLastFetch = now - lastFetchTime;



  if (timeSinceLastFetch < 3000) {

    // Calculate wait time

    const waitTime = 3000 - timeSinceLastFetch;

    userLogger.debug(`[search-and-delete-emails] rate limit, waiting ${waitTime}ms then execute: ${username}`);



    // Update last email receive time in advance (current time + wait time)

    lastFetchTimes.set(username, now + waitTime);



    // Wait enough time

    await new Promise(resolve => setTimeout(resolve, waitTime));

  } else {

    // Execute immediately and update timestamp to current time

    lastFetchTimes.set(username, now);

  }



  userLogger.info('Searching and deleting IMAP emails...', { username: username, sender: sender, subjectPrefix: subjectPrefix, options: options });



  // Use IMAP management Worker thread to execute search and delete operations

  return imapManagementWorkerManager.sendTask({

    action: 'searchAndDeleteEmails',

    config,

    sender,

    subjectPrefix,

    options

  });

});



/**

 * IPC handler: delete IMAP emails by UID

 */

registerHandler('delete-emails-by-uid', async (event, config, uids) => {

  const username = config.username;

  const now = Date.now();



  // Get user-specific logger instance

  const userLogger = logger.Logger.getInstance('default', { username: config.username });



  // Check email receiving rate limit

  const lastFetchTime = lastFetchTimes.get(username) || 0;

  const timeSinceLastFetch = now - lastFetchTime;



  if (timeSinceLastFetch < 3000) {

    // Calculate wait time

    const waitTime = 3000 - timeSinceLastFetch;

    userLogger.debug(`[delete-emails-by-uid] rate limit, waiting ${waitTime}ms then execute: ${username}`);



    // Update last email receive time in advance (current time + wait time)

    lastFetchTimes.set(username, now + waitTime);



    // Wait enough time

    await new Promise(resolve => setTimeout(resolve, waitTime));

  } else {

    // Execute immediately and update timestamp to current time

    lastFetchTimes.set(username, now);

  }



  // Ensure uids is an array

  const uidArray = Array.isArray(uids) ? uids : [uids];



  userLogger.info('Deleting IMAP emails by UID...', { username: username, uids: uidArray });



  // Use IMAP management Worker thread to execute delete operation

  return imapManagementWorkerManager.sendTask({

    action: 'deleteEmailsByUid',

    config,

    uids: uidArray

  });

});



/**

 * IPC handler: actively disconnect IMAP connection

 */

registerHandler('disconnect-imap', async (event, config) => {

  // Get user-specific logger instance

  const userLogger = logger.Logger.getInstance('default', { username: config.username });

  userLogger.info('Disconnecting IMAP...', { username: config.username });

  

  // Call connection manager to disconnect

  connectionManager.disconnect(config.username);

  return { success: true, message: 'IMAP connection disconnected' };

});



/**

 * IPC handler: get IMAP connection status

 */

registerHandler('get-imap-status', async (event, username) => {

  // Get user-specific logger instance

  const userLogger = logger.Logger.getInstance('default', { username: username });

  userLogger.info('Getting IMAP status...', { username: username });

  // Get connection status from connection manager

  return connectionManager.getStatus(username);

});



/**

 * Test whether IMAP connection config is correct

 * Only verify connection parameters, do not establish persistent connection

 * @param {Object} config - IMAP configuration {username, password, host, port, tls}

 * @returns {Promise<Object>} Test result

 */

function testImapConnectionOnly(config) {

  return new Promise((resolve, reject) => {

    const imap = new Imap({

      user: config.username,

      password: config.password,

      host: config.host,

      port: config.port,

      tls: config.tls || false,

      tlsOptions: {

        rejectUnauthorized: false

      },

      // Disable keepalive because this is only a connection test

      keepalive: false

    });



    let resolved = false;



    // Set connection timeout

    const timeout = setTimeout(() => {

      if (!resolved) {

        resolved = true;

        imap.destroy();

        reject(new Error('Connection test timed out (10s)'));

      }

    }, 10000);



    imap.once('ready', () => {

      if (!resolved) {

        resolved = true;

        clearTimeout(timeout);

        // Disconnect immediately after successful test, do not establish persistent connection

        imap.destroy();

        resolve({

          success: true,

          message: 'Connection test successful',

          host: config.host,

          port: config.port

        });

      }

    });



    imap.once('error', (error) => {

      if (!resolved) {

        resolved = true;

        clearTimeout(timeout);

        reject(error);

      }

    });



    imap.once('end', () => {

      // connection ended，no special handling

    });



    // Start connection

    imap.connect();

  });

}



/**

 * IPC handler: warm up IMAP connection

 * Only test whether connection config is correct, do not establish persistent connection

 */

registerHandler('pre-warm-imap-connection', async (event, config) => {

  // Get user-specific logger instance

  const userLogger = logger.Logger.getInstance('default', { username: config.username });

  userLogger.info('Testing IMAP connection configuration...', { username: config.username, host: config.host });

  try {

    // Only test connection, do not establish persistent connection

    const result = await testImapConnectionOnly(config);

    userLogger.debug('IMAP connection test successful');

    return { success: true, message: 'Connection test successful' };

  } catch (error) {

    userLogger.warn('IMAP connection test failed, will retry on login:', error.message);

    // Do not throw error on test failure to avoid affecting user experience

    return { success: false, message: `Connection test failed: ${error.message}` };

  }

});



/**

 * IPC handler: download email attachments

 * Use streaming download, supports large files and real progress

 */

registerHandler('download-email-attachment', async (event, { username, emailUid, filename, contentType, size, imapConfig }) => {

  const userLogger = logger.Logger.getInstance('default', { username: username });

  userLogger.info('Downloading email attachment (streaming)...', { username, emailUid, filename });



  try {

    const { downloadAttachmentStreaming } = require('./imap-attachment-downloader-streaming');

    const result = await downloadAttachmentStreaming({

      username,

      emailUid,

      filename,

      imapConfig,

      onProgress: (downloaded, total, percentage) => {

        // Send progress notification to renderer process

        try {

          event.sender.send('download-progress', {

            username,

            emailUid,

            filename,

            downloaded,

            total,

            percentage

          });

        } catch (e) {

          // ignore send error

        }

      }

    });



    userLogger.info('Attachment downloaded successfully', { savePath: result.savePath });

    return result;

  } catch (error) {

    userLogger.error('Failed to download attachment:', error);

    return { success: false, error: error.message };

  }

}, { timeout: 600000 }); // 10-minute timeout



registerHandler('fetch-email-body', async (event, { username, emailId, uid, config }) => {

  const userLogger = logger.Logger.getInstance('default', { username });

  userLogger.info(`Fetching email body via worker...`, { username, emailId, uid });



  try {

    const result = await fetchEmailBodyWorkerManager.sendTask({

      username,

      emailId,

      uid,

      config

    }, 300000); // Set 5-minute timeout



    userLogger.info(`Email body fetched successfully via worker`, { username, emailId, uid });

    return result;

  } catch (error) {

    userLogger.error(`Failed to fetch email body via worker: ${error.message}`);

    return { success: false, error: error.message };

  }

}, { timeout: 300000 }); // Set 5-minute timeout at IPC layer to match Worker layer



module.exports = {};

