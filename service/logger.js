const fs = require('fs');
const path = require('path');
const pathUtils = require('../shared/path/path-utils.js');

/**
 * Unified logging system
 * Supports different log levels (debug, info, warn, error)
 * Supports console and file output
 */
class Logger {
    // Store logger instances for different mailboxes
    static instances = new Map();
    // In-process instance counter, used to distinguish multiple instances in the same process
    static processInstanceCounter = 0;
    
    constructor(moduleName = 'default', options = {}) {
        this.moduleName = moduleName;
        
        // Determine log directory: if username is provided, use user-specific log directory
        let logDir;
        if (options.username) {
            logDir = pathUtils.getUserLogDir(options.username);
        } else {
            logDir = options.logDir || path.join(pathUtils.getResourcesDir(), 'users', 'log');
        }
        
        this.options = {
            logLevel: options.logLevel || 'info', // Default log level
            outputToFile: options.outputToFile !== false, // Default output to file
            outputToConsole: options.outputToConsole !== false, // Default output to console
            logDir: logDir, // Log directory
            customFilename: options.customFilename, // Custom log file name
            username: options.username, // Email address used to generate log file names containing the email
            sender: options.sender, // Sender email address
            receiver: options.receiver, // Recipient email address
            instanceId: options.instanceId, // Instance identifier used to distinguish multiple instances
            ...options
        };
        
        this.logLevels = {
            debug: 0,
            info: 1,
            warn: 2,
            error: 3
        };
        
        // Get instance identifier: prefer custom id, then env var, then PID+counter, finally timestamp+random
        this.instanceId = this._getInstanceId();
        
        // Note: log directory is now created uniformly at app startup by app-initializer.js
        // No longer recreate here, only simple existence check (for dev mode or abnormal cases)
        this._checkLogDir();
        
        // Log file name: prefer custom file name, otherwise generate from moduleName, username, sender, receiver, and instanceId
        let logFilename = this.options.customFilename;
        if (!logFilename) {
            const parts = [moduleName];
            
            // Add username (current user)
            if (this.options.username) {
                const sanitizedUsername = this.options.username.replace(/@/g, '_at_');
                parts.push(sanitizedUsername);
            }
            
            // Add sender
            if (this.options.sender && this.options.sender !== this.options.username) {
                const sanitizedSender = this.options.sender.replace(/@/g, '_at_');
                parts.push(`sender_${sanitizedSender}`);
            }
            
            // Add receiver
            if (this.options.receiver && this.options.receiver !== this.options.username) {
                const sanitizedReceiver = this.options.receiver.replace(/@/g, '_at_');
                parts.push(`receiver_${sanitizedReceiver}`);
            }
            
            // Add instanceId
            parts.push(this.instanceId);
            
            logFilename = `${parts.join('_')}.log`;
        }
        this.logFile = path.join(this.options.logDir, logFilename);
    }
    
    /**
     * Get instance identifier
     * Priority:
     * 1. Custom instanceId
     * 2. Environment variable MAILINK_INSTANCE_ID
     * 3. Process ID (PID) + in-process instance counter
     * 4. Timestamp + random
     */
    _getInstanceId() {
        // 1. Prefer custom instanceId
        if (this.options.instanceId) {
            return this.options.instanceId;
        }
        
        // 2. Use environment variable
        if (process.env.MAILINK_INSTANCE_ID) {
            return process.env.MAILINK_INSTANCE_ID;
        }
        
        // 3. Use PID + in-process instance counter
        if (process.pid) {
            Logger.processInstanceCounter++;
            return `pid_${process.pid}_${Logger.processInstanceCounter}`;
        }
        
        // 4. Generate timestamp+random
        return `inst_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    }
    
    /**
     * Check if log directory exists
     * Note: directory creation has been moved to app-initializer.js, this method only warns in abnormal cases
     */
    _checkLogDir() {
        try {
            if (!fs.existsSync(this.options.logDir)) {
                console.warn(`[Logger] Log directory does not exist: ${this.options.logDir}`);
                console.warn(`[Logger] Directory will be created automatically on first write`);
            }
        } catch (err) {
            console.error(`[Logger] Failed to check log directory: ${err.message}`);
        }
    }
    
    /**
     * Get formatted timestamp
     */
    _getTimestamp() {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        const ms = String(now.getMilliseconds()).padStart(3, '0');
        
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
    }
    
    /**
     * Check if log level should be output
     */
    _shouldLog(level) {
        return this.logLevels[level] >= this.logLevels[this.options.logLevel];
    }
    
    /**
     * Write log to file
     */
    _writeLog(level, message, ...args) {
        if (!this.options.outputToFile) return;
        
        const timestamp = this._getTimestamp();
        let logContent = `[${timestamp}] [${level.toUpperCase()}] [${this.moduleName}] ${message}`;
        
        // Handle extra arguments
        if (args.length > 0) {
            try {
                logContent += ' ' + JSON.stringify(args);
            } catch (e) {
                logContent += ' ' + args.toString();
            }
        }
        
        try {
            fs.appendFileSync(this.logFile, logContent + '\n', 'utf8');
        } catch (err) {
            console.error(`[Logger] Failed to write log to file: ${err.message}`);
        }
    }
    
    /**
     * Output log to console
     */
    _consoleLog(level, message, ...args) {
        if (!this.options.outputToConsole) return;
        
        const timestamp = this._getTimestamp();
        const consoleMessage = `[${timestamp}] [${level.toUpperCase()}] [${this.moduleName}] ${message}`;
        
        try {
            switch (level) {
                case 'debug':
                    console.debug(consoleMessage, ...args);
                    break;
                case 'info':
                    console.info(consoleMessage, ...args);
                    break;
                case 'warn':
                    console.warn(consoleMessage, ...args);
                    break;
                case 'error':
                    console.error(consoleMessage, ...args);
                    break;
                default:
                    console.log(consoleMessage, ...args);
            }
        } catch (consoleError) {
            // ignore console output errors such as EPIPE (broken pipe)
            // these errors usually occur when the app is closing or the console is disconnected
            // they do not affect normal app operation, so ignore them
        }
    }
    
    /**
     * Debug log
     */
    debug(message, ...args) {
        if (this._shouldLog('debug')) {
            this._consoleLog('debug', message, ...args);
            this._writeLog('debug', message, ...args);
        }
    }
    
    /**
     * Info log
     */
    info(message, ...args) {
        if (this._shouldLog('info')) {
            this._consoleLog('info', message, ...args);
            this._writeLog('info', message, ...args);
        }
    }
    
    /**
     * Warning log
     */
    warn(message, ...args) {
        if (this._shouldLog('warn')) {
            this._consoleLog('warn', message, ...args);
            this._writeLog('warn', message, ...args);
        }
    }
    
    /**
     * Error log
     */
    error(message, ...args) {
        if (this._shouldLog('error')) {
            this._consoleLog('error', message, ...args);
            this._writeLog('error', message, ...args);
        }
    }
    
    /**
     * Set log level
     */
    setLogLevel(level) {
        if (this.logLevels[level] !== undefined) {
            this.options.logLevel = level;
            this.info(`Log level set to ${level}`);
        } else {
            this.error(`Invalid log level: ${level}`);
        }
    }
    
    /**
     * Get or create logger instance for specified module and username
     * @param {string} moduleName - module name
     * @param {Object} options - options
     * @returns {Logger} logger instance
     */
    static getInstance(moduleName = 'default', options = {}) {
        // Use moduleName and username combination as key
        const key = `${moduleName}_${options.username || 'default'}`;
        if (!Logger.instances.has(key)) {
            Logger.instances.set(key, new Logger(moduleName, options));
        }
        return Logger.instances.get(key);
    }
    
    /**
     * Manually create log file
     * Ensure only create when file does not exist, avoid overwriting existing file
     */
    createLogFile() {
        if (!this.options.outputToFile) return;
        
        try {
            // Open file in append mode; create if it does not exist
            // Only create file, do not write any content
            fs.openSync(this.logFile, 'a');
        } catch (err) {
            console.error(`[Logger] Failed to create log file: ${err.message}`);
        }
    }
}

// Create default logger instance
const defaultLogger = new Logger('default');

// Export default logger instance; logger.error etc. can be called directly
module.exports = defaultLogger;

// Also export Logger class for creating custom logger instances
module.exports.Logger = Logger;