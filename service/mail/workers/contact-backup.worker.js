/**
 * Contact backup Worker
 * Execute contact export and backup email sending in Worker threads
 * Avoid blocking main process
 */
const { parentPort } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const nodemailer = require('nodemailer');

// Import unified database module (can be used directly in Worker)
const { UnifiedDB } = require('../../sqlite/sqlite-unified');

/**
 * Force merge WAL data into main database file
 * @param {string} dbPath - Database file path
 */
async function forceWalCheckpoint(dbPath) {
  try {
    // Use UnifiedDB to execute WAL checkpoint command
    // PRAGMA wal_checkpoint(TRUNCATE) forces all WAL data into main database and truncates WAL file
    await UnifiedDB.execute(dbPath, 'PRAGMA wal_checkpoint(TRUNCATE)');
    parentPort.postMessage({ log: '[ContactBackup] WAL data merged into main database' });
  } catch (error) {
    // WAL merge failure does not block backup flow, just log a warning
    parentPort.postMessage({ log: `[ContactBackup] WAL merge warning: ${error.message}` });
  }
}

/**
 * Export contact data as CSV
 * @param {string} dbPath - Database file path
 * @param {string} username - Email username
 * @returns {Promise<string>} - CSV content
 */
async function exportContactsToCSV(dbPath, username) {
  // Check whether database file exists
  try {
    await fsPromises.access(dbPath);
  } catch (error) {
    throw new Error(`Database file does not exist: ${dbPath}`);
  }

  // Force merge WAL data before export to ensure all data is in main database file
  await forceWalCheckpoint(dbPath);

  // Get all contact data
  const contacts = await getAllContacts(dbPath);

  if (!contacts || contacts.length === 0) {
    return '# No contacts found in database\n';
  }

  // CSV header
  const headers = ['id', 'nickname', 'rmkname', 'username', 'avgray', 'status', 'updatetime'];

  // Generate CSV content
  let csvContent = [];

  // Add file header comment
  csvContent.push(`# Mailink Contacts Backup`);
  csvContent.push(`# Generated: ${new Date().toISOString()}`);
  csvContent.push(`# User: ${username}`);
  csvContent.push(`# Total records: ${contacts.length}`);
  csvContent.push('');

  // Add CSV header
  csvContent.push(headers.join(','));

  // Add data rows
  for (const contact of contacts) {
    const row = headers.map(header => {
      const val = contact[header];
      if (val === null || val === undefined) {
        return '';
      }
      // Handle fields containing commas, newlines, or double quotes
      const strVal = String(val);
      if (strVal.includes(',') || strVal.includes('\n') || strVal.includes('"')) {
        // Replace double quotes with two double quotes and wrap with double quotes
        return '"' + strVal.replace(/"/g, '""') + '"';
      }
      return strVal;
    });
    csvContent.push(row.join(','));
  }

  return csvContent.join('\n');
}

/**
 * Get all contact data
 * @param {string} dbPath - Database path
 * @returns {Promise<Array>} - Contact array
 */
async function getAllContacts(dbPath) {
  const rows = await UnifiedDB.query(dbPath,
    `SELECT id, nickname, rmkname, username, avgray, status, updatetime FROM contact ORDER BY id`
  );
  return rows || [];
}

/**
 * Send contact backup email
 * @param {string} username - Sender email
 * @param {Object} smtpConfig - SMTP config
 * @param {string} csvContent - CSV content
 * @returns {Promise<Object>} - Send result
 */
async function sendBackupEmail(username, smtpConfig, csvContent) {
  // Create SMTP transporter
  const transporter = nodemailer.createTransport({
    host: smtpConfig.host || 'smtp.qq.com',
    port: smtpConfig.port || 465,
    secure: (smtpConfig.port || 465) === 465,
    auth: {
      user: smtpConfig.username,
      pass: smtpConfig.password
    },
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 60000
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `contacts_backup_${timestamp}.csv`;
  const unixTimestamp = Math.floor(Date.now() / 1000);

  const mailOptions = {
    from: username,
    to: username, // send to self
    subject: 'mailink_bak_contacts',
    text: 'You can manually move to mailink_info (on the server). Please keep the latest 2 copies. These are contacts automatically backed up by the Mailink email chat software you are using. Do not delete all of them!',
    html: '<p>You can manually move to mailink_info (on the server). Please keep the latest 2 copies. These are contacts automatically backed up by the Mailink email chat software you are using. Do not delete all of them!</p>',
    attachments: [
      {
        filename: filename,
        content: csvContent,
        contentType: 'text/csv'
      }
    ]
  };

  const info = await transporter.sendMail(mailOptions);

  // Close transporter
  transporter.close();

  return { success: true, messageId: info.messageId };
}

/**
 * Check whether database and table exist and have data
 * @param {string} dbPath - Database file path
 * @returns {Promise<Object>} - Check result {valid: boolean, reason: string}
 */
async function checkDatabaseAndTable(dbPath) {
  // 1. Check whether database file exists
  try {
    await fsPromises.access(dbPath);
  } catch (error) {
    return { valid: false, reason: 'Database file does not exist' };
  }

  // 2. Check whether contact table exists
  const tableInfo = await UnifiedDB.get(dbPath,
    `SELECT name FROM sqlite_master WHERE type='table' AND name='contact'`
  );
  
  if (!tableInfo) {
    return { valid: false, reason: 'contact table does not exist' };
  }

  // 3. Check whether table has data
  const countResult = await UnifiedDB.get(dbPath,
    `SELECT COUNT(*) as count FROM contact`
  );
  
  if (!countResult || countResult.count === 0) {
    return { valid: false, reason: 'contact table is empty, no data to backup' };
  }

  return { valid: true, reason: `contact table has ${countResult.count} record(s)` };
}

/**
 * Execute full contact backup flow
 * @param {Object} params - Backup parameters
 * @returns {Promise<Object>} - Backup result
 */
async function backupContacts(params) {
  const { dbPath, username, smtpConfig } = params;

  try {
    // 0. Check whether database and table exist and have data
    const checkResult = await checkDatabaseAndTable(dbPath);
    if (!checkResult.valid) {
      return {
        success: true,
        skipped: true,
        message: `Backup skipped: ${checkResult.reason}`
      };
    }

    // 1. Export contacts as CSV (executed in Worker, does not block main process)
    const csvContent = await exportContactsToCSV(dbPath, username);

    // 2. Send backup email
    const sendResult = await sendBackupEmail(username, smtpConfig, csvContent);

    return {
      success: true,
      message: 'Contacts backup sent successfully',
      messageId: sendResult.messageId
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// Listen to messages from the main thread
parentPort.on('message', async ({ id, taskType, params }) => {
  try {
    let data;
    if (taskType === 'backup-contacts') {
      data = await backupContacts(params);
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
