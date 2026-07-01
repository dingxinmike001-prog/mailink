/**
 * IMAP session logger
 * Responsible for logging IMAP email reception, log filename includes sender and receiver addresses
 */
const UserLogger = require('../user-logger');

class ImapSessionLogger extends UserLogger {
    static instances = new Map();

    constructor(options = {}) {
        const { username, sender, receiver } = options;
        // Use username as the primary identifier; it is the current user's email address
        const logOptions = {
            ...options,
            username,
            sender,
            receiver
        };
        super('imap-session', logOptions);
        this.username = username;
        this.sender = sender;
        this.receiver = receiver;
        this.loggerInstance.info(`IMAPsession logger initialized - user: ${username}, sender: ${sender || 'unknown'}, recipient: ${receiver || username}`);
    }

    /**
     * Get or create IMAP session logger instance
     * @param {string} username - Current user email address
     * @param {string} sender - Sender email address
     * @param {string} receiver - Receiver email address (usually equals username)
     * @param {Object} options - Other options
     * @returns {ImapSessionLogger} Logger instance
     */
    static getInstance(username, sender, receiver, options = {}) {
        // Use combination of username, sender, and receiver as key
        const key = `${username || 'unknown'}_${sender || 'unknown'}_${receiver || 'unknown'}`;
        if (!ImapSessionLogger.instances.has(key)) {
            ImapSessionLogger.instances.set(key, new ImapSessionLogger({
                ...options,
                username,
                sender,
                receiver
            }));
        }
        return ImapSessionLogger.instances.get(key);
    }

    /**
     * Log email reception start
     * @param {Object} emailData - Email data
     */
    logReceiveStart(emailData) {
        this.loggerInstance.info(`started receiving emails - sender: ${this.sender}, subject: ${emailData.subject}`);
    }

    /**
     * Log successful email reception
     * @param {Object} emailData - Parsed email data
     * @param {number} duration - Reception duration (ms)
     */
    logReceiveSuccess(emailData, duration) {
        this.loggerInstance.info(`email received successfully - sender: ${this.sender}, subject: ${emailData.subject}, size: ${emailData.size || 0} bytes, elapsed: ${duration}ms`);
    }

    /**
     * Log failed email reception
     * @param {string} uid - Email UID
     * @param {Error} error - Error info
     */
    logReceiveFailure(uid, error) {
        this.loggerInstance.error(`email received failed - UID: ${uid}, sender: ${this.sender}, error: ${error.message}`);
    }

    /**
     * Log email deletion
     * @param {string} uid - Email UID
     */
    logDelete(uid) {
        this.loggerInstance.info(`email deleted - UID: ${uid}, sender: ${this.sender}`);
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

module.exports = ImapSessionLogger;