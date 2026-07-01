const nodemailer = require('nodemailer');
const logger = require('../logger');
const { parentPort } = require('worker_threads');
const SmtpLogger = require('./smtp-logger');
const { validateEmailAttachment } = require('../security/file-security-node');

// Cache SMTP transporter objects for different accounts to enable connection reuse
const transporters = new Map();

// Read SMTP debug config from environment variables
const SMTP_DEBUG_ENABLED = process.env.SMTP_DEBUG === 'true' || process.env.SMTP_DEBUG === '1';
const SMTP_LOGGER_ENABLED = process.env.SMTP_LOGGER === 'true' || process.env.SMTP_LOGGER === '1';

if (SMTP_DEBUG_ENABLED) {
  logger.info(`[SMTP Worker] SMTP debug mode enabled via environment variable`);
}

// Verify email address format
function isValidEmail(email) {
    if (!email || typeof email !== 'string') {
        return false;
    }
    // Standard email address regex
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

// Connection pool health check and cleanup mechanism
setInterval(() => {
  logger.info(`🔍 Performing SMTP transporter health check, current transporters count: ${transporters.size}`);
  
  // Iterate over all transporters and check health status
  for (const [accountKey, transporter] of transporters.entries()) {
    try {
      // Get SMTP logger instance, use accountKey as sender identifier
      const smtpLogger = SmtpLogger.getInstance(accountKey, 'health-check');
      
      // Simple health check: verify connection availability
      transporter.verify((error) => {
        if (error) {
          smtpLogger.warn(`🩺 Transporter is unhealthy, removing from cache:`, error.message);
          transporters.delete(accountKey);
        } else {
          smtpLogger.debug(`🩺 Transporter is healthy`);
        }
      });
    } catch (error) {
      const smtpLogger = SmtpLogger.getInstance(accountKey, 'health-check');
      smtpLogger.error(`🩺 Error during health check:`, error.message);
      transporters.delete(accountKey);
    }
  }
}, 30 * 60 * 1000); // Execute health check every 30 minutes

/**
 * Generate appropriate priority headers based on email type
 * @param {boolean} isSignaling - Whether it is a WebRTC signaling email
 * @param {Object} logger - Logger
 * @returns {Object} Email header object
 */
function getEmailHeaders(isSignaling, logger) {
  // Base headers: applicable to all emails
  const baseHeaders = {
    'X-Mailer': 'Mailink-SMTP',
    'X-Originating-IP': `[${getClientIP()}]`,
  };

  if (isSignaling) {
    // WebRTC signaling emails: critical priority
    // Use multiple standard and non-standard headers to ensure maximum compatibility
    return {
      ...baseHeaders,
      // ===== Standard RFC fields =====
      'X-Priority': '1',              // RFC 2156: 1=Highest, 5=Lowest
      'Importance': 'high',           // RFC 2421: low/normal/high
      'Precedence': 'urgent',         // RFC 2076: standard urgent precedence
      'Priority': 'urgent',           // fallback field
      
      // ===== Microsoft/Outlook compatibility =====
      'X-MSMail-Priority': 'High',    // Outlookrecognition priority
      
      // ===== Custom Mailink fields =====
      'X-Mailink-Signaling': 'true',  // mark as signaling email
      'X-Mailink-Priority': 'critical',
      'X-Mailink-Timeout-Tolerance': '10000',  // allow10seconds delay
      
      // ===== Other hint fields =====
      'X-Urgency': '1',               // custom urgency level
      'Content-Transfer-Encoding': '7bit',  // avoid encoding delay
    };
  } else {
    // Normal emails: standard priority
    return {
      ...baseHeaders,
      'X-Priority': '3',              // normal priority
      'Importance': 'normal',
      'Content-Transfer-Encoding': '7bit',
    };
  }
}

/**
 * Get client IP (for log tracking)
 * @returns {string} IP address
 */
function getClientIP() {
  try {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        // Skip internal and IPv6 addresses
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
  } catch (e) {
    // ignore fetchIP error
  }
  return '127.0.0.1';
}

/**
 * Extract signal type from email subject
 * @param {string} subject - Email subject
 * @returns {string} Signal type: discover/offer/answer/unknown
 */
function extractSignalType(subject) {
  if (!subject) return 'unknown';
  
  if (subject.includes('-discover-')) return 'discover';
  if (subject.includes('-offer-')) return 'offer';
  if (subject.includes('-answer-')) return 'answer';
  if (subject.includes('-candidates-')) return 'candidates';
  
  return 'unknown';
}

/**
 * Execute email send operation
 * @param {Object} config - Email config {username, password, smtpHost, smtpPort}
 * @param {Object} emailData - Email data {to, subject, body/text/html}
 * @returns {Promise<Object>} Send result
 */
async function sendMail(config, emailData) {
  const accountKey = config.username;
  const sender = config.username;
  const receiver = emailData.to;
  let retryCount = 0;
  const maxRetries = 3;
  
  // Get SMTP logger instance; log filename contains sender and receiver addresses
  const smtpLogger = SmtpLogger.getInstance(sender, receiver);
  
  // Verify recipient address format
  if (!isValidEmail(emailData.to)) {
    const errorMsg = `Invalid email address format: ${emailData.to}`;
    smtpLogger.error(`❌ ${errorMsg}`);
    throw new Error(errorMsg);
  }
  
  // Exponential backoff strategy: 500ms, 1000ms, 2000ms
  const getRetryDelay = (count) => {
    const delays = [500, 1000, 2000];
    return delays[count] || 2000;
  };

  // Simulate network status detection
  const checkNetworkStatus = () => {
    // In Node.js environment, we can simulate network detection in a simple way
    // Can be extended as needed in real applications
    return { 
      isOnline: true,
      type: 'unknown',
      effectiveType: '4g' 
    };
  };

  const performSend = async () => {
    try {
      // Network status detection
      const networkStatus = checkNetworkStatus();
      smtpLogger.info(`Network status before sending: ${JSON.stringify(networkStatus)}`);
      
      if (!networkStatus.isOnline) {
        smtpLogger.warn(`Network is offline, delaying send attempt`);
        throw new Error('Network is offline');
      }
      
      let transporter = transporters.get(accountKey);

      if (!transporter) {
        smtpLogger.info(`Creating new SMTP transporter with connection pool (debug: ${SMTP_DEBUG_ENABLED})`);
        transporter = nodemailer.createTransport({
          host: config.smtpHost || 'smtp.qq.com',
          port: config.smtpPort || 465,
          secure: (config.smtpPort || 465) === 465,
          pool: true,
          maxConnections: 5,
          maxMessages: 100,
          idleTimeout: 30000, // 30 seconds idle timeout to reduce stale connections
          auth: {
            user: config.username,
            pass: config.password
          },
          connectionTimeout: 15000, // adjust to15second(s)
          greetingTimeout: 15000, // adjust to15second(s)
          socketTimeout: 30000,
          // Enable verbose debug logs based on environment variable
          logger: SMTP_LOGGER_ENABLED,
          debug: SMTP_DEBUG_ENABLED
        });
        transporters.set(accountKey, transporter);
        
        // Listen to SMTP transporter events to record detailed logs
        transporter.on('idle', () => {
          smtpLogger.debug('SMTP transporter is idle');
        });
        
        transporter.on('error', (err) => {
          smtpLogger.error('SMTP transporter error:', err.message);
        });
      }

      const mailOptions = {
        from: config.username,
        to: emailData.to,
        subject: emailData.subject
      };

      const startTime = Date.now();
      smtpLogger.info(`📤 Starting to send email with subject "${emailData.subject}" (Retry: ${retryCount}, Network: ${networkStatus.effectiveType})`);
      smtpLogger.debug(`Mail options: ${JSON.stringify(mailOptions)}`);

      // Set email priority headers
      const { SIGNALING_EMAIL_PREFIX } = require('../../shared/config/signaling-constants');
      const isSignalingEmail = emailData.subject && emailData.subject.startsWith(SIGNALING_EMAIL_PREFIX);
      mailOptions.headers = getEmailHeaders(isSignalingEmail, smtpLogger);
      
      if (isSignalingEmail) {
        smtpLogger.debug(`📨 Setting signaling email with critical priority headers`);
      }

      // Prefer HTML content (styled content generated by rich text editor)
      // If both text and html exist, send both and let email client choose display
      if (emailData.html) {
        mailOptions.html = emailData.html;
      }
      if (emailData.text) {
        mailOptions.text = emailData.text;
      } else if (emailData.body) {
        mailOptions.text = emailData.body;
      }
      
      // If neither text nor html exists, ensure at least one content exists
      if (!mailOptions.text && !mailOptions.html) {
        mailOptions.text = '';
      }

      // Add attachment support
      if (emailData.attachments && Array.isArray(emailData.attachments)) {
        smtpLogger.info(`📎 Adding ${emailData.attachments.length} attachments to email`);

        // Security check: verify each attachment
        const safeAttachments = [];
        for (const att of emailData.attachments) {
          const validation = await validateEmailAttachment(att);
          if (!validation.allowed) {
            smtpLogger.warn(`🚫 intercepted dangerous attachment: ${att.filename}, reason: ${validation.reasons.join(', ')}`);
            // Continue processing other attachments but skip dangerous ones
            continue;
          }
          safeAttachments.push(att);
        }

        // Verify attachment format and log
        safeAttachments.forEach((att, idx) => {
          if (att.path) {
            smtpLogger.info(`  📄 Attachment ${idx + 1}: ${att.filename}, path: ${att.path}`);
          } else if (att.content) {
            smtpLogger.info(`  📄 Attachment ${idx + 1}: ${att.filename}, content type: ${typeof att.content}, size: ${att.content.length || 'unknown'}`);
          } else {
            smtpLogger.warn(`  ⚠️ Attachment ${idx + 1}: ${att.filename}, unknown format`);
          }
        });
        mailOptions.attachments = safeAttachments;
      }

      const info = await transporter.sendMail(mailOptions);
      const endTime = Date.now();
      const duration = endTime - startTime;
      smtpLogger.info(`✅ Email sent successfully in ${duration}ms: ${info.messageId}`);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      // Detect protocol errors often caused by stale connections in a pool
      const isProtocolError = error.message && (
        error.message.includes('250 OK') ||
        error.message.includes('Mail command failed') ||
        /\x00/.test(error.message) // Check for null bytes/garbage
      );

      const shouldRetry = retryCount < maxRetries && (
        isProtocolError ||
        error.code === 'EENVELOPE' ||
        error.code === 'ECONNECTION' ||
        error.code === 'ETIMEOUT'
      );

      if (shouldRetry) {
        retryCount++;
        const delay = getRetryDelay(retryCount - 1); // -1 because we're about to retry
        smtpLogger.warn(`⚠️ SMTP error detected, will retry in ${delay}ms (${retryCount}/${maxRetries}):`, {
          code: error.code,
          message: error.message,
          delay,
          subject: emailData.subject
        });

        // Clear transporter from cache to force recreation on retry
        transporters.delete(accountKey);
        
        // Exponential backoff delay
        await new Promise(resolve => setTimeout(resolve, delay));
        
        return performSend();
      }

      smtpLogger.error(`❌ Email send failed after ${retryCount + 1} attempts:`, {
        message: error.message,
        stack: error.stack,
        code: error.code,
        command: error.command,
        response: error.response,
        responseCode: error.responseCode,
        subject: emailData.subject
      });
      throw error;
    }
  };

  return performSend();
}

/**
 * Warm up SMTP connection pool
 * @param {Object} config - Email config
 */
async function prewarmSmtp(config) {
  try {
    const accountKey = config.username;
    const sender = config.username;
    // No recipient during warm-up, use "prewarm" as identifier
    const smtpLogger = SmtpLogger.getInstance(sender, 'prewarm');
    
    if (transporters.has(accountKey)) {
      smtpLogger.debug(`SMTP transporter already exists, skipping pre-warm`);
      return { success: true, cached: true };
    }

    smtpLogger.info(`Pre-warming SMTP transporter (debug: ${SMTP_DEBUG_ENABLED})`);
    const transporter = nodemailer.createTransport({
      host: config.smtpHost || 'smtp.qq.com',
      port: config.smtpPort || 465,
      secure: (config.smtpPort || 465) === 465,
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
      idleTimeout: 30000,
      auth: {
        user: config.username,
        pass: config.password
      },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 30000,
      // Enable verbose debug logs based on environment variable
      logger: SMTP_LOGGER_ENABLED,
      debug: SMTP_DEBUG_ENABLED
    });

    transporters.set(accountKey, transporter);

    // The verify here is optional; it forces establishing a physical connection
    // If verify is not called, the pool lazily loads physical connection until first send
    // To achieve true instant send, we call verify
    transporter.verify((error) => {
      if (error) {
        smtpLogger.warn(`SMTP pre-warm verification failed:`, error.message);
      } else {
        smtpLogger.info(`SMTP pool is ready and verified`);
      }
    });

    return { success: true };
  } catch (error) {
    const sender = config.username;
    const smtpLogger = SmtpLogger.getInstance(sender, 'prewarm');
    smtpLogger.error(`SMTP pre-warm failed:`, error.message);
    return { success: false, error: error.message };
  }
}

// Listen to messages from the main thread
parentPort.on('message', async ({ id, taskType, config, emailData }) => {
  try {
    let data;
    if (taskType === 'sendmail') {
      data = await sendMail(config, emailData);
    } else if (taskType === 'prewarm-smtp') {
      data = await prewarmSmtp(config);
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