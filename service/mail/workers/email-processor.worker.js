/**
 * Email processing Worker
 * Responsible for asynchronously parsing email content and saving to database
 * Runs in independent threads to avoid blocking main thread
 */

const { parentPort, workerData } = require('worker_threads');
const { simpleParser } = require('mailparser');
const { Readable } = require('stream');
const path = require('path');

// Add project root directory to module search path
const projectRoot = path.resolve(__dirname, '../../../');
require('module').Module.globalPaths.push(projectRoot);

// Import required modules
const logger = require('../../logger');
const { isDangerousExtension, isDangerousMimeType } = require('../../security/file-security-node');

// Worker ID
const workerId = workerData?.workerId || 0;

/**
 * Send log message to main thread
 * @param {string} level - Log level (info, warn, error)
 * @param {string} message - Log message
 */
function sendLog(level, message) {
  parentPort.postMessage({
    type: 'log',
    level,
    message: `[EmailProcessor#${workerId}] ${message}`
  });
}

/**
 * Convert Buffer to Readable stream
 * @param {Buffer} buffer - Data buffer
 * @returns {Readable} - Readable stream
 */
function bufferToStream(buffer) {
  return new Readable({
    read() {
      this.push(buffer);
      this.push(null);
    }
  });
}

/**
 * Extract priority information from email headers
 * @param {Object} headers - Email header object
 * @returns {Object} - Priority info and key headers
 */
function extractPriorityInfo(headers) {
  let priority = null;
  const extractedHeaders = {};
  
  if (!headers) return { priority, headers: extractedHeaders };
  
  // Handle headers as Map or plain object
  let headersMap = {};
  if (headers instanceof Map) {
    headersMap = Object.fromEntries(headers);
  } else if (typeof headers === 'object') {
    headersMap = headers;
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
  
  // Extract key headers
  if (headersMap['priority']) extractedHeaders['priority'] = headersMap['priority'];
  if (headersMap['x-priority'] || headersMap['X-Priority']) {
    extractedHeaders['x-priority'] = headersMap['x-priority'] || headersMap['X-Priority'];
  }
  if (headersMap['importance'] || headersMap['Importance']) {
    extractedHeaders['importance'] = headersMap['importance'] || headersMap['Importance'];
  }
  
  return { priority, headers: extractedHeaders };
}

/**
 * Extract email address text
 * @param {Object|string|Array} fromField - Sender field
 * @returns {string} - Formatted email address
 */
function getEmailText(fromField) {
  if (!fromField) return '';
  if (typeof fromField === 'string') return fromField;
  if (Array.isArray(fromField) && fromField.length > 0) {
    return fromField.map(addr => {
      if (typeof addr === 'string') return addr;
      if (addr.text) return addr.text;
      if (addr.address) return addr.address;
      return '';
    }).join(', ');
  }
  if (fromField.text) return fromField.text;
  if (fromField.address) return fromField.address;
  return '';
}

/**
 * Extract sender email address
 * @param {Object|string} fromField - Sender field
 * @returns {string} - Email address
 */
function extractEmailAddress(fromField) {
  if (!fromField) return '';
  
  if (typeof fromField === 'string') {
    const emailMatch = fromField.match(/<([^>]+)>/);
    if (emailMatch && emailMatch[1]) return emailMatch[1];
    if (fromField.includes('@')) return fromField.trim();
    return fromField;
  }
  
  if (fromField.address) return fromField.address;
  if (fromField.value && Array.isArray(fromField.value) && fromField.value.length > 0) {
    return fromField.value[0].address || '';
  }
  
  return '';
}

/**
 * Process attachments
 * @param {Array} attachments - Raw attachment array
 * @param {boolean} isSignaling - Whether it is a signaling email
 * @returns {Array} - Processed attachment array
 */
function processAttachments(attachments, isSignaling) {
  if (!attachments || !Array.isArray(attachments)) return [];
  
  const processedAttachments = [];
  
  for (const att of attachments) {
    // Security check: filter dangerous attachments
    const isDangerousFile = isDangerousExtension(att.filename) ||
                            isDangerousMimeType(att.contentType, att.filename);
    if (isDangerousFile) {
      sendLog('warn', `🚫 Blocked dangerous attachment: filename=${att.filename}, type=${att.contentType}`);
      continue;
    }
    
    if (isSignaling) {
      // Signaling email: extract full attachment content
      processedAttachments.push({
        filename: att.filename,
        contentType: att.contentType,
        content: att.content, // Buffer type
        size: att.size,
        cid: att.cid
      });
    } else {
      // Normal emails: extract only metadata
      processedAttachments.push({
        filename: att.filename,
        contentType: att.contentType,
        size: att.size,
        cid: att.cid
      });
    }
  }
  
  return processedAttachments;
}

/**
 * Parse email
 * @param {Object} params - Parse parameters
 * @returns {Promise<Object>} - Parsed email data
 */
async function parseEmail(params) {
  const { streamBuffer, uid, username } = params;
  const startTime = Date.now();
  
  sendLog('info', `Start parsing email UID=${uid}, buffer size=${streamBuffer?.length || 0} bytes`);
  
  try {
    // Convert Buffer to Readable stream
    const stream = bufferToStream(streamBuffer);
    
    // Add timeout protection using Promise.race
    const simpleParserPromise = simpleParser(stream);
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Email parsing timeout (15s)')), 15000);
    });
    
    // Wait for parsing to complete or timeout
    const parsed = await Promise.race([simpleParserPromise, timeoutPromise]);
    
    // Detect whether it is a signaling email
    const { SIGNALING_EMAIL_PREFIX } = require('../../../shared/config/signaling-constants');
    const isSignaling = parsed.subject && parsed.subject.startsWith(SIGNALING_EMAIL_PREFIX);
    
    // Extract priority information
    const { priority, headers } = extractPriorityInfo(parsed.headers);
    
    // Process attachments
    const attachments = processAttachments(parsed.attachments, isSignaling);
    
    // Build email data
    const emailData = {
      uid: uid,
      username: username,
      subject: parsed.subject || (isSignaling ? '' : 'No Subject'),
      from: getEmailText(parsed.from) || (isSignaling ? '' : 'Unknown Sender'),
      to: getEmailText(parsed.to),
      cc: getEmailText(parsed.cc),
      date: parsed.date || new Date(),
      receivedDate: parsed.receivedDate || parsed.date || new Date(),
      text: parsed.text || '',
      html: isSignaling ? '' : (parsed.html || ''),
      messageId: parsed.messageId || '',
      attachments: attachments,
      priority: priority,
      headers: headers,
      isSignaling: isSignaling
    };
    
    const duration = Date.now() - startTime;
    sendLog('info', `Email parsing completed UID=${uid}, signaling=${isSignaling}, attachments=${attachments.length}, duration=${duration}ms`);
    
    return {
      success: true,
      emailData,
      duration
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    sendLog('error', `Email parsing failed UID=${uid}: ${error.message}, duration=${duration}ms`);
    throw error;
  }
}

/**
 * Save email to database
 * @param {Object} emailData - Email data
 * @returns {Promise<Object>} - Save result
 */
async function saveEmailToDatabase(emailData) {
  const startTime = Date.now();
  
  try {
    // Check whether it is a signaling email; signaling emails are not written to recv table
    if (emailData.isSignaling) {
      sendLog('info', `Signaling email skipped saving to database UID=${emailData.uid}`);
      return {
        success: true,
        emailId: null,
        duration: Date.now() - startTime,
        skipped: true,
        reason: 'signaling_email_not_saved'
      };
    }
    
    // Dynamically import database module (avoid loading during Worker initialization)
    const { saveEmailToDatabase: dbSaveEmail } = require('../imap-database');
    const pathUtils = require('../../../shared/path/path-utils');
    
    const dbPath = pathUtils.getUserDbPath(emailData.username);
    
    // Save email
    const result = await dbSaveEmail(dbPath, {
      subject: emailData.subject,
      from: { text: emailData.from },
      to: { text: emailData.to },
      cc: emailData.cc ? { text: emailData.cc } : null,
      date: emailData.date,
      text: emailData.text,
      html: emailData.html,
      messageId: emailData.messageId,
      attachments: emailData.attachments,
      priority: emailData.priority,
      headers: emailData.headers
    }, emailData.uid);
    
    const duration = Date.now() - startTime;
    sendLog('info', `Email saved UID=${emailData.uid}, ID=${result}, duration=${duration}ms`);
    
    return {
      success: true,
      emailId: result,
      duration
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    sendLog('error', `Email save failed UID=${emailData.uid}: ${error.message}, duration=${duration}ms`);
    throw error;
  }
}

/**
 * Handle email task
 * @param {Object} taskData - Task data
 * @returns {Promise<Object>} - Processing result
 */
async function processEmailTask(taskData) {
  const { action, params } = taskData;
  
  switch (action) {
    case 'parse':
      return await parseEmail(params);
    
    case 'parseAndSave':
      const parseResult = await parseEmail(params);
      if (parseResult.success) {
        const saveResult = await saveEmailToDatabase(parseResult.emailData);
        return {
          success: true,
          emailId: saveResult.emailId,
          emailData: parseResult.emailData,
          parseDuration: parseResult.duration,
          saveDuration: saveResult.duration,
          saveResult: saveResult
        };
      }
      return parseResult;
    
    case 'batchParseAndSave':
      return await batchProcessEmails(params);
    
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

/**
 * Batch process emails
 * @param {Object} params - Batch processing parameters
 * @returns {Promise<Object>} - Batch processing result
 */
async function batchProcessEmails(params) {
  const { emails, username } = params;
  const results = {
    success: true,
    total: emails.length,
    parsed: 0,
    saved: 0,
    skipped: 0,
    failed: 0,
    errors: []
  };
  
  sendLog('info', `Start batch processing ${emails.length} email(s)`);
  
  for (const email of emails) {
    try {
      const result = await processEmailTask({
        action: 'parseAndSave',
        params: {
          streamBuffer: email.streamBuffer,
          uid: email.uid,
          username: username
        }
      });
      
      if (result.success) {
        results.parsed++;
        if (result.saveResult?.skipped) {
          results.skipped++;
        } else {
          results.saved++;
        }
      } else {
        results.failed++;
      }
    } catch (error) {
      results.failed++;
      results.errors.push({
        uid: email.uid,
        error: error.message
      });
      sendLog('error', `Batch processing failed UID=${email.uid}: ${error.message}`);
    }
  }
  
  sendLog('info', `Batch processing completed: total=${results.total}, success=${results.saved}, skipped=${results.skipped}, failed=${results.failed}`);
  
  return results;
}

// Listen to main thread messages
parentPort.on('message', async (message) => {
  const { taskId, data } = message;
  const startTime = Date.now();
  
  sendLog('info', `Received task ${taskId}`);
  
  try {
    const result = await processEmailTask(data);
    
    const duration = Date.now() - startTime;
    sendLog('info', `Task ${taskId} completed, duration=${duration}ms`);
    
    parentPort.postMessage({
      taskId,
      success: true,
      data: result
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    sendLog('error', `Task ${taskId} failed: ${error.message}, duration=${duration}ms`);
    
    parentPort.postMessage({
      taskId,
      success: false,
      error: error.message
    });
  }
});

// Send ready message
sendLog('info', 'Email processing Worker ready');
parentPort.postMessage({ success: true, data: 'Email processor worker ready' });
