/**
 * Database operation Worker
 * responsible for database-related CRUD operations
 */
const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const sqlite3 = require('better-sqlite3');

// Add verbose method for API compatibility
if (!sqlite3.verbose) {
  sqlite3.verbose = () => sqlite3;
}


// Add project root directory to module search path
const projectRoot = path.resolve(__dirname, '../../../');
require('module').Module.globalPaths.push(projectRoot);

// Import the logger module
const logger = require('../../logger');

/**
 * Handle database request
 * @param {Object} message - message object containing database operation parameters
 */
const handleDbRequest = async (message) => {
    const id = message?.id;
    const action = message?.action;
    const params = message ? { ...message } : {};
    if (params && typeof params === 'object') {
        delete params.id;
        delete params.action;
    }

    try {
        logger.info(`Database worker received request: ${action}, id: ${id}`);

        let result;

        switch (action) {
            case 'load-email-configs-from-db':
                result = await loadEmailConfigsFromDb(params);
                break;
            case 'save-email-config':
                result = await saveEmailConfig(params);
                break;
            case 'update-email-config':
                result = await updateEmailConfig(params);
                break;
            default:
                throw new Error(`Unsupported action: ${action}`);
        }
        
        // Return success result
        parentPort.postMessage({
            id,
            success: true,
            data: result
        });
    } catch (error) {
        logger.error('Database worker error:', error);
        
        // Return error result
        parentPort.postMessage({
            id,
            success: false,
            error: error?.message || String(error)
        });
    }
};

/**
 * Load mailbox config from database
 * @param {Object} params - operation parameters
 * @returns {Promise<Array>} mailbox config array
 */
const loadEmailConfigsFromDb = async (params) => {
    try {
        const { dbPath } = params;
        
        // Connect to config.db database (better-sqlite3 is synchronous)
        const db = new sqlite3(dbPath, { timeout: 5000 });
        
        // Enable WAL mode to support multi-process concurrent access
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        db.pragma('busy_timeout = 5000');
        
        // Query all mailbox configs, including the avatar field
        const sql = 'SELECT id, name, host, port, smtpHost, smtpPort, username, password, tls, avatar FROM email';
        const stmt = db.prepare(sql);
        const rows = stmt.all();
        
        // Convert the tls field to boolean
        const configs = rows.map(row => ({
            ...row,
            tls: row.tls === 1,
            id: row.id.toString() // Ensure id is a string type for consistency
        }));
        
        // Close database connection
        db.close();
        
        return configs;
    } catch (err) {
        logger.error('Database query failed:', err);
        throw err;
    }
};

/**
 * Save mailbox config to database
 * @param {Object} params - operation parameters
 * @returns {Promise<Object>} save result
 */
const saveEmailConfig = async (params) => {
    try {
        const { dbPath, config } = params;
        
        // Connect to config.db database (better-sqlite3 is synchronous)
        const db = new sqlite3(dbPath, { timeout: 5000 });
        
        // Enable WAL mode to support multi-process concurrent access
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        db.pragma('busy_timeout = 5000');
        
        // Insert mailbox config, including the avatar field
        const sql = `INSERT INTO email (name, host, port, smtpHost, smtpPort, username, password, tls, avatar) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const stmt = db.prepare(sql);
        const sqlParams = [
            config.name,
            config.host,
            config.port,
            config.smtpHost,
            config.smtpPort,
            config.username,
            config.password,
            config.tls ? 1 : 0, // convert boolean to integer
            config.avatar || '' // Use an empty string as the default value
        ];
        
        const result = stmt.run(sqlParams);
        logger.info(`Email config saved successfully, ID: ${result.lastInsertRowid}`);
        
        // Close database connection
        db.close();
        
        return { success: true, id: result.lastInsertRowid };
    } catch (err) {
        logger.error('Database insert failed:', err);
        throw err;
    }
};

/**
 * Update mailbox config in database
 * @param {Object} params - operation parameters
 * @returns {Promise<Object>} update result
 */
const updateEmailConfig = async (params) => {
    try {
        const { dbPath, configId, config } = params;
        
        logger.info(`Updating email config: id=${configId}, avatarLength=${config.avatar ? config.avatar.length : 0}`);
        
        // Connect to config.db database (better-sqlite3 is synchronous)
        const db = new sqlite3(dbPath, { timeout: 5000 });
        
        // Enable WAL mode to support multi-process concurrent access
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        db.pragma('busy_timeout = 5000');
        
        // Update mailbox config, including the avatar field
        const sql = `UPDATE email SET name = ?, host = ?, port = ?, smtpHost = ?, smtpPort = ?, username = ?, password = ?, tls = ?, avatar = ? 
                    WHERE id = ?`;
        const stmt = db.prepare(sql);
        const sqlParams = [
            config.name,
            config.host,
            config.port,
            config.smtpHost,
            config.smtpPort,
            config.username,
            config.password,
            config.tls ? 1 : 0, // convert boolean to integer
            config.avatar || '', // use empty string as default value
            configId
        ];
        
        const result = stmt.run(sqlParams);
        logger.info(`Email config updated successfully, ID: ${configId}`);
        
        // Close database connection
        db.close();
        
        return { success: true, id: configId };
    } catch (err) {
        logger.error('Database update failed:', err);
        throw err;
    }
};

// Listen to messages from the main thread
parentPort.on('message', handleDbRequest);

// Send ready message to the main thread
parentPort.postMessage({ success: true, data: 'Database worker ready' });
