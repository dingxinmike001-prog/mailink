const UserLogger = require('../user-logger');

class DBLogger extends UserLogger {
    static instances = new Map();

    constructor(options = {}) {
        super('database', options);
        this.username = options.username || null;
    }

    static getInstance(username = null) {
        const key = `${username}`;
        if (!DBLogger.instances.has(key)) {
            DBLogger.instances.set(key, new DBLogger({ username }));
        }
        return DBLogger.instances.get(key);
    }

    log(msg) {
        this.loggerInstance.info(msg);
    }

    logTableCheck(dbPath, tableName, exists) {
        this.log(`[${dbPath}] Table Check: '${tableName}' - Exists: ${exists}`);
    }

    logTableCreated(dbPath, tableName) {
        this.log(`[${dbPath}] Table Created: '${tableName}'`);
    }

    logSaveMessage(dbPath, email, contentLength) {
        this.log(`[${dbPath}] Saving Message: Email=${email}, ContentLength=${contentLength}`);
    }
}

module.exports = DBLogger.getInstance();
module.exports.DBLogger = DBLogger;
