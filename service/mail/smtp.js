const logger = require('../logger');

const path = require('path');

const crypto = require('crypto');



// Import IPC manager

const { registerHandler } = require('../../shared/ipc/ipc-manager');



// Import unified Worker manager factory

const { createWorkerManager } = require('../../shared/worker/worker-factory');



// Import path utility module

const pathUtils = require('../../shared/path/path-utils');



// Import unified database module

const { UnifiedDB } = require('../sqlite/sqlite-unified');



// Create SMTP Worker manager instance (using unified Worker manager factory, Worker pool mode)

const smtpWorkerManager = createWorkerManager('smtp');



// Task tracking: store pending email send tasks

const pendingEmailTasks = new Map();



/**

 * Generate unique task ID

 */

function generateTaskId() {

  return `email_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

}



/**

 * Auto add/update contact

 * - If not exists, create new contact with status=0

 * - If exists but status<0, update to status=0

 * @param {string} senderEmail - Sender email (current user)

 * @param {string} recipientEmail - Recipient email

 */

async function autoAddContact(senderEmail, recipientEmail) {

  try {

    if (!senderEmail || !recipientEmail) {

      logger.warn(`[auto-add contact] missing parameter: sender=${senderEmail}, recipient=${recipientEmail}`);

      return;

    }



    // Restriction: cannot add self as contact

    if (senderEmail.trim().toLowerCase() === recipientEmail.trim().toLowerCase()) {

      logger.debug(`[auto-add contact] cannot add self as contact: ${recipientEmail}`);

      return;

    }



    // Get sender's database path

    const dbPath = pathUtils.getUserDbPath(senderEmail);



    // Check if contact already exists

    const existingContact = await UnifiedDB.withORM(dbPath, async (orm) => {

      return await orm.table('contact')

        .whereRaw('lower(username) = lower(?)', [recipientEmail])

        .find();

    });



    if (existingContact) {

      // If exists but status < 0, update to status=0

      if (existingContact.status < 0) {

        await UnifiedDB.execute(

          dbPath,

          'UPDATE contact SET status = 0, updatetime = ? WHERE id = ?',

          [Date.now(), existingContact.id]

        );

        logger.info(`[auto-add contact] restored contact status to valid: ${recipientEmail}, originalstatus=${existingContact.status}, newstatus=0`);

      } else {

        logger.info(`[auto-add contact] contact already exists and is valid: ${recipientEmail}, status=${existingContact.status}`);

      }

      return;

    }



    // Extract display name (extract username part from email address)

    const nickname = recipientEmail.includes('@') 

      ? recipientEmail.split('@')[0] 

      : recipientEmail;



    // Insert new contact (status=0 means valid)

    const newId = await UnifiedDB.withORM(dbPath, async (orm) => {

      return await orm.table('contact').insertGetId({

        nickname: nickname,

        rmkname: nickname,

        username: recipientEmail,

        avatar: '',

        status: 0,

        updatetime: Date.now()

      });

    });



    logger.info(`[auto-add contact] successfully added valid contact: ${recipientEmail}, ID: ${newId}, status=0`);

  } catch (error) {

    logger.error(`[auto-add contact] failed to add contact: ${error.message}`);

    // do not throw error，avoid affecting email sending flow

  }

}



/**

 * IPC handler: send email (async mode)

 * Changed to not wait for email send completion, return taskId immediately

 * Email is sent in background; client is proactively notified via IPC when done

 */

registerHandler('sendmail', async (event, config, emailData) => {

  // Role validation: if it is a discover email, check whether role is correct

  const { SIGNALING_EMAIL_PREFIX } = require('../../shared/config/signaling-constants');



  if (emailData.subject && emailData.subject.startsWith(SIGNALING_EMAIL_PREFIX + 'discover-')) {

    const myEmail = config.username;

    const toEmail = emailData.to;

    

    if (myEmail && toEmail && myEmail < toEmail) {

      logger.info(`[role validation] Sender (${myEmail} < ${toEmail}) skip discover email`);

      return { 

        success: false, 

        error: 'ROLE_CHECK_FAILED: Sender should not send discover email',

        role: 'sender',

        myEmail,

        toEmail

      };

    }

  }

  

  // Generate task ID

  const taskId = generateTaskId();

  const renderId = event.sender.id;

  

  logger.info(`📧 [async email] created email task: ${taskId}, recipient: ${emailData.to}`);

  

  // Return taskId immediately (do not wait for email send completion)

  // This avoids timeout caused by long IPC waiting

  setImmediate(() => {

    // Send email asynchronously in background

    smtpWorkerManager.sendTask({

      taskType: 'sendmail',

      config,

      emailData

    }).then(async result => {

      // Email sent successfully

      const successResult = {

        success: true,

        taskId,

        messageId: result.messageId,

        to: emailData.to,

        subject: emailData.subject

      };

      

      logger.info(`✅ [async email] task completed: ${taskId}, email sent to ${emailData.to}`);

      

      // Auto-add contact (if contact does not exist)

      await autoAddContact(config.username, emailData.to);

      

      // Proactively notify client via IPC that email sending is complete

      notifyEmailTaskResult(renderId, successResult);

      

      // Clean up task records

      pendingEmailTasks.delete(taskId);

    }).catch(error => {

      // Email send failed

      const errorResult = {

        success: false,

        taskId,

        error: error.message,

        to: emailData.to,

        subject: emailData.subject

      };

      

      logger.error(`❌ [async email] task failed: ${taskId}, error: ${error.message}`);

      

      // Proactively notify client via IPC that email sending failed

      notifyEmailTaskResult(renderId, errorResult);

      

      // Clean up task records

      pendingEmailTasks.delete(taskId);

    });

  });

  

  // Record task

  pendingEmailTasks.set(taskId, {

    to: emailData.to,

    subject: emailData.subject,

    createdAt: Date.now(),

    renderId

  });

  

  // Return immediately (user interface gets response immediately)

  return {

    success: true,

    taskId,

    message: 'email submitted, sending in background'

  };

});



/**

 * Proactively notify client of email task result via IPC

 */

function notifyEmailTaskResult(renderId, result) {

  try {

    const { BrowserWindow } = require('electron');

    const windows = BrowserWindow.getAllWindows();

    const targetWindow = windows.find(w => w.webContents.id === renderId);

    

    if (targetWindow) {

      // Send event to renderer process via IPC

      targetWindow.webContents.send('sendmail-result', result);

      logger.debug(`📤 [async email] notification sent to client: ${result.taskId}`);

    } else {

      logger.warn(`⚠️ [async email] target window not found: ${result.taskId}`);

    }

  } catch (error) {

    logger.error(`❌ [async email] notification failed: ${error.message}`);

  }

}



/**

 * Export task tracking functions for use by other modules

 */

module.exports = {

  generateTaskId,

  notifyEmailTaskResult,

  getPendingEmailTasks: () => pendingEmailTasks

};



/**

 * IPC handler: warm up SMTP connection pool

 */

registerHandler('prewarm-smtp', async (event, config) => {

  return smtpWorkerManager.sendTask({

    taskType: 'prewarm-smtp',

    config,

    emailData: null

  });

});



module.exports = {};