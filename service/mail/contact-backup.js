/**

 * Contact backup module

 * Exports contact data as an SQL file and sends backup email via SMTP

 * Executes via Worker thread to avoid blocking the main process

 */

const path = require('path');

const logger = require('../logger');



// Import path utility module

const pathUtils = require('../../shared/path/path-utils');



// Import IPC manager

const { registerHandler } = require('../../shared/ipc/ipc-manager');



// Import unified Worker manager factory

const { createWorkerManager } = require('../../shared/worker/worker-factory');



// Create contact backup Worker manager instance

const contactBackupWorkerManager = createWorkerManager('contactBackup');



/**

 * Execute contact backup (via Worker thread)

 * @param {string} username - Username

 * @param {Object} smtpConfig - SMTP config

 * @param {Object} imapConfig - IMAP config (optional, used to move emails)

 * @returns {Promise<Object>} - Backup result

 */

async function backupContacts(username, smtpConfig, imapConfig = null) {

  const userLogger = logger.Logger.getInstance('default', { username });

  userLogger.info('[ContactBackup] started contact backup flow (Worker mode)');



  try {

    // Get database path

    const dbPath = pathUtils.getUserDbPath(username);



    // Execute the full backup flow via Worker thread (export + send email)

    const result = await contactBackupWorkerManager.sendTask({

      taskType: 'backup-contacts',

      params: {

        dbPath,

        username,

        smtpConfig

      }

    }, 120000); // 120-second timeout



    if (result.success) {

      userLogger.info('[ContactBackup] contact backup completed');



      // ✅ New: after backup email is sent successfully, move email to mailink_info folder

      if (imapConfig && !result.skipped) {

        userLogger.info('[ContactBackup] started moving backup emails tomailink_infofolder');

        

        // Record email send time for more precise time-window search

        const emailSentTime = new Date();

        

        // Use retry-enabled email move

        moveBackupEmailWithRetry(username, imapConfig, emailSentTime).then(moveResult => {

          if (moveResult.success) {

            userLogger.info(`[ContactBackup] backup emails moved successfully: ${moveResult.moved || 0} `);

          } else {

            userLogger.warn(`[ContactBackup] backup emails move failed: ${moveResult.error}`);

          }

        }).catch(err => {

          userLogger.warn(`[ContactBackup] move backup email exception (non-blocking): ${err.message}`);

        });

      }



      return { success: true, message: result.message, messageId: result.messageId };

    } else {

      userLogger.warn(`[ContactBackup] backup failed: ${result.error}`);

      return { success: false, error: result.error };

    }

  } catch (error) {

    userLogger.error(`[ContactBackup] backup flow failed: ${error.message}`);

    return { success: false, error: error.message };

  }

}



/**

 * Client-side secondary verification function - verify whether emails are backup emails

 * @param {Array} emails - List of searched emails

 * @param {Array} uids - List of email UIDs

 * @param {string} username - Username

 * @param {Date} emailSentTime - Email send time

 * @returns {Array} - List of verified UIDs

 */

function validateBackupEmails(emails, uids, username, emailSentTime) {

  const validatedUids = [];

  const userLogger = logger.Logger.getInstance('default', { username });

  

  userLogger.info(`[ContactBackup] started verifying ${emails.length} emails, username: ${username}, sent time: ${emailSentTime ? emailSentTime.toISOString() : 'not provided'}`);

  

  for (const email of emails) {

    let isValid = true;

    const failedChecks = [];

    

    // Check 1: subject must contain mailink_bak_contacts

    const subjectValid = email.subject && email.subject.includes('mailink_bak_contacts');

    if (!subjectValid) {

      isValid = false;

      failedChecks.push(`subject mismatch: expected to contain"mailink_bak_contacts", actual="${email.subject || 'no subject'}"`);

    }

    

    // Check 2: sender must match the current user

    const fromValid = email.from && email.from.includes(username);

    if (!fromValid) {

      isValid = false;

      failedChecks.push(`sender mismatch: expected to contain"${username}", actual="${email.from || 'no sender'}"`);

    }

    

    // Check 3: recipient must include the current user (backup email sent to self)

    const toValid = email.to && email.to.includes(username);

    if (!toValid) {

      isValid = false;

      failedChecks.push(`recipient mismatch: expected to contain"${username}", actual="${email.to || 'no recipient'}"`);

    }

    

    // Record detailed verification results

    if (isValid) {

      validatedUids.push(email.uid);

      userLogger.info(`[ContactBackup] email UID=${email.uid} verification passed: subject="${email.subject}", from="${email.from}", to="${email.to}", date="${email.date}"`);

    } else {

      userLogger.warn(`[ContactBackup] email UID=${email.uid} verification failed:\n  - ${failedChecks.join('\n  - ')}`);

    }

  }

  

  userLogger.info(`[ContactBackup] verification completed: ${validatedUids.length}/${emails.length} emails passed verification, passUIDs: [${validatedUids.join(',')}]`);

  

  return validatedUids;

}



/**

 * Move backup email to the mailink_info folder

 * @param {string} username - Username

 * @param {Object} imapConfig - IMAP config

 * @param {Date} emailSentTime - Email send time (optional, for a more precise time window)

 * @returns {Promise<Object>} - Move result

 */

async function moveBackupEmailToFolder(username, imapConfig, emailSentTime = null) {

  const userLogger = logger.Logger.getInstance('default', { username });



  try {

    // Import connection manager

    const connectionManager = require('./imap-connection-manager');



    // Ensure IMAP connection is established

    let connInfo = connectionManager.getStatus(username);

    if (!connInfo.connected) {

      // If not connected, try to establish a connection

      userLogger.debug('[ContactBackup] IMAPnot connected, trying to establish connection');

      await connectionManager.getConnection(imapConfig);

    }



    // Use a wider time window: search from email send time or 5 minutes ago

    // This ensures emails can be found even if sending and indexing are delayed

    const searchStartTime = emailSentTime 

      ? new Date(emailSentTime.getTime() - 60000) // 1 minute before email was sent

      : new Date(Date.now() - 5 * 60000); // Or 5 minutes ago

    

    const searchCriteria = {

      subject: 'mailink_bak_contacts',

      from: username,

      since: searchStartTime

    };



    userLogger.debug(`[ContactBackup] searching backup emails, time window: ${searchStartTime.toISOString()}`);



    // Create verification function (bound with username and emailSentTime)

    const validatorFn = (emails, uids) => {

      return validateBackupEmails(emails, uids, username, emailSentTime);

    };



    // Search and move emails to mailink_info folder (with client-side secondary verification, take only the latest 1)

    const moveResult = await connectionManager.searchAndMoveEmails(

      username,

      searchCriteria,

      'mailink_info',

      validatorFn,  // pass in client validation function

      { limit: 1 }  // Take only the latest email

    );



    return moveResult;

  } catch (error) {

    userLogger.error(`[ContactBackup] move backup emails failed: ${error.message}`);

    return { success: false, error: error.message };

  }

}



/**

 * Email move with retry mechanism

 * @param {string} username - Username

 * @param {Object} imapConfig - IMAP config

 * @param {Date} emailSentTime - Email send time

 * @param {number} maxRetries - Maximum retry count

 * @param {number} retryDelay - Retry interval (milliseconds)

 * @returns {Promise<Object>} - Move result

 */

async function moveBackupEmailWithRetry(username, imapConfig, emailSentTime, maxRetries = 3, retryDelay = 2000) {

  const userLogger = logger.Logger.getInstance('default', { username });

  

  for (let attempt = 1; attempt <= maxRetries; attempt++) {

    userLogger.debug(`[ContactBackup] trying to move backup emails (${attempt}/${maxRetries})`);

    

    const result = await moveBackupEmailToFolder(username, imapConfig, emailSentTime);

    

    if (result.success && result.moved > 0) {

      return result;

    }

    

    // If no email found and retries remain, wait and retry

    if (attempt < maxRetries) {

      userLogger.debug(`[ContactBackup] no backup emails found, ${retryDelay}msthen retry...`);

      await new Promise(resolve => setTimeout(resolve, retryDelay));

    }

  }

  

  return { success: false, error: 'Max retries exceeded, no emails found' };

}



/**

 * IPC handler: execute contact backup

 */

registerHandler('backup-contacts', async (event, { username, smtpConfig }) => {

  if (!username || !smtpConfig) {

    throw new Error('Username and SMTP config are required');

  }



  return await backupContacts(username, smtpConfig);

});



module.exports = {

  backupContacts,

  moveBackupEmailToFolder,

  moveBackupEmailWithRetry

};

