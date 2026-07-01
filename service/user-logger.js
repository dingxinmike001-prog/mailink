const logger = require('./logger');

class UserLogger {
    static instances = new Map();

    constructor(moduleName, options = {}) {
        this.moduleName = moduleName;
        this.options = {
            logLevel: options.logLevel || 'debug',
            ...options
        };

        // No longer use customFilename; let the Logger class handle instance identification itself
        this.loggerInstance = logger.Logger
            ? new logger.Logger(moduleName, {
                ...options
            })
            : logger;
    }

    static getInstance(moduleName, options = {}) {
        const username = options.username || null;
        const key = `${moduleName}_${username}`;
        if (!this.instances.has(key)) {
            this.instances.set(key, new this(moduleName, options));
        }
        return this.instances.get(key);
    }

    static createUserLogger(username, moduleName, options = {}) {
        return this.getInstance(moduleName, { ...options, username });
    }

    debug(message, ...args) {
        this.loggerInstance.debug(message, ...args);
    }

    info(message, ...args) {
        this.loggerInstance.info(message, ...args);
    }

    warn(message, ...args) {
        this.loggerInstance.warn(message, ...args);
    }

    error(message, ...args) {
        this.loggerInstance.error(message, ...args);
    }
}

module.exports = UserLogger;
