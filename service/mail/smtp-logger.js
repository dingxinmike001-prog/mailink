/**
 * SMTP logger
 * Responsible for logging SMTP email send-related logs; log filenames contain sender and receiver addresses
 */
const UserLogger = require('../user-logger');

class SmtpLogger extends UserLogger {
    static instances = new Map();

    constructor(options = {}) {
        const { sender, receiver, username } = options;
        // Use sender as the main identifier because username usually equals sender
        const logOptions = {
            ...options,
            username: sender || username,
            sender,
            receiver
        };
        super('smtp', logOptions);
        this.sender = sender;
        this.receiver = receiver;
        this.loggerInstance.info(`SMTPlogger initialized - sender: ${sender || 'unknown'}, recipient: ${receiver || 'unknown'}`);
    }

    /**
     * Get or create SMTP logger instance
     * @param {string} sender - Sender email address
     * @param {string} receiver - Receiver email address
     * @param {Object} options - Other options
     * @returns {SmtpLogger} Logger instance
     */
    static getInstance(sender, receiver, options = {}) {
        // Use combination of sender and receiver as key
        const key = `${sender || 'unknown'}_${receiver || 'unknown'}`;
        if (!SmtpLogger.instances.has(key)) {
            SmtpLogger.instances.set(key, new SmtpLogger({
                ...options,
                sender,
                receiver
            }));
        }
        return SmtpLogger.instances.get(key);
    }

    /**
     * Log email send start
     * @param {Object} emailData - Email data
     */
    logSendStart(emailData) {
        this.loggerInstance.info(`started sending email - sender: ${this.sender}, recipient: ${this.receiver}, subject: ${emailData.subject}`);
    }

    /**
     * Log email send success
     * @param {string} messageId - Email ID
     * @param {number} duration - Send duration (ms)
     */
    logSendSuccess(messageId, duration) {
        this.loggerInstance.info(`email sent successfully - sender: ${this.sender}, recipient: ${this.receiver}, emailID: ${messageId}, elapsed: ${duration}ms`);
    }

    /**
     * Log email send failure
     * @param {Error} error - Error information
     * @param {number} retryCount - Retry count
     */
    logSendFailure(error, retryCount = 0) {
        this.loggerInstance.error(`email sent failed - sender: ${this.sender}, recipient: ${this.receiver}, retry count: ${retryCount}, error: ${error.message}`);
    }

    /**
     * Log SMTP connection status
     * @param {string} status - Connection status
     * @param {Object} details - Detailed information
     */
    logConnectionStatus(status, details = {}) {
        this.loggerInstance.info(`SMTPconnection status - sender: ${this.sender}, @:  ${status}, details: ${JSON.stringify(details)}`);
    }

    // Override log methods to add sender and receiver information
    debug(message, data = {}) {
        this.loggerInstance.debug(`[${this.sender}->${this.receiver}] ${message}`, data);
    }

    info(message, data = {}) {
        this.loggerInstance.info(`[${this.sender}->${this.receiver}] ${message}`, data);
    }

    warn(message, data = {}) {
        this.loggerInstance.warn(`[${this.sender}->${this.receiver}] ${message}`, data);
    }

    error(message, data = {}) {
        this.loggerInstance.error(`[${this.sender}->${this.receiver}] ${message}`, data);
    }
}

module.exports = SmtpLogger;
