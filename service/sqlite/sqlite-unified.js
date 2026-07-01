/**
 * Unified database operation API
 * Integrate ORM and native SQL operations, Provide a unified database access interface
 */

const sqlite3 = require('better-sqlite3');

// Add verbose method for API compatibility
if (!sqlite3.verbose) {
  sqlite3.verbose = () => sqlite3;
}

const TPishSQLite = require('./tpish-sqlite');
const { DBLogger } = require('./db-logger');
const path = require('path');

// Parse the username from the database path
function getUsernameFromDbPath(dbPath) {
  const filename = path.basename(dbPath);
  // Remove the _emails.db suffix
  return filename.replace('_emails.db', '');
}

/**
 * Database connection pool class - Adapter for better-sqlite3(synchronous API)
 */
class DatabasePool {
  constructor() {
    this.pools = new Map(); // Connection pools for different database files
    this.maxConnections = 5; // Maximum connections per database file
  }

  /**
   * Get a connection from the pool
   * @param {string} dbPath - database file path
   * @returns {Promise<{db: sqlite3.Database, release: Function}>} - database connection and release function
   */
  async getConnection(dbPath) {
    if (!this.pools.has(dbPath)) {
      this.pools.set(dbPath, {
        connections: [],
        waiting: [],
        inUse: 0
      });
    }

    const pool = this.pools.get(dbPath);

    // If an available connection exists, return it directly
    if (pool.connections.length > 0) {
      const db = pool.connections.pop();
      pool.inUse++;
      return {
        db,
        release: () => this.releaseConnection(dbPath, db)
      };
    }

    // If the maximum connection count has not been reached, create a new connection
    if (pool.inUse < this.maxConnections) {
      // better-sqlite3 creates connections synchronously
      const db = new sqlite3(dbPath, { timeout: 5000 });
      
      // Enable WAL mode to support multi-process concurrent access
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('busy_timeout = 5000');
      
      pool.inUse++;
      return {
        db,
        release: () => this.releaseConnection(dbPath, db)
      };
    }

    // Otherwise wait for an available connection
    return new Promise((resolve) => {
      pool.waiting.push(resolve);
    });
  }

  /**
   * Release connection back to the pool
   * @param {string} dbPath - database file path
   * @param {sqlite3.Database} db - databaseconnection
   */
  releaseConnection(dbPath, db) {
    const pool = this.pools.get(dbPath);
    if (!pool) return;

    pool.inUse--;

    // If there are waiting requests, assign the connection directly
    if (pool.waiting.length > 0) {
      const resolve = pool.waiting.shift();
      pool.inUse++;
      resolve({
        db,
        release: () => this.releaseConnection(dbPath, db)
      });
      return;
    }

    // Otherwise return the connection to the pool
    pool.connections.push(db);
  }

  /**
   * Close all connections
   * @param {string} [dbPath] - optional, specify the database file path; close all if not specified
   */
  async closeAll(dbPath) {
    if (dbPath) {
      // Close all connections for the specified database
      const pool = this.pools.get(dbPath);
      if (pool) {
        // Close idle connections
        for (const db of pool.connections) {
          db.close();
        }
        // Clear the waiting queue
        for (const resolve of pool.waiting) {
          resolve(null);
        }
        this.pools.delete(dbPath);
      }
    } else {
      // Close all connections for all databases
      for (const [path, pool] of this.pools.entries()) {
        for (const db of pool.connections) {
          db.close();
        }
        for (const resolve of pool.waiting) {
          resolve(null);
        }
      }
      this.pools.clear();
    }
  }
}

// Create the global connection pool instance
const connectionPool = new DatabasePool();

/**
 * Unified database operation class
 */
class UnifiedDB {
  /**
   * Get ORM instance(using connection pool)
   * @param {string} dbPath - database file path
   * @returns {Promise<{orm: TPishSQLite, release: Function}>} - ORM instance and release function
   */
  static async getORM(dbPath) {
    // Note: TPishSQLite needs the database file path, not a direct database instance
    // Because it uses Worker threads internally, the database instance cannot be passed
    const orm = new TPishSQLite(dbPath);
    // For Worker mode, no need to get a connection from the pool; return the ORM instance directly
    return {
      orm,
      release: () => {} // Empty release function because the Worker manages connections itself
    };
  }

  /**
   * Execute ORM operation(automatically manage connection)
   * @param {string} dbPath - database file path
   * @param {Function} operation - ORM operation function
   * @returns {Promise<any>} - operation result
   */
  static async withORM(dbPath, operation) {
    const { orm, release } = await this.getORM(dbPath);
    const username = getUsernameFromDbPath(dbPath);
    const logger = DBLogger.getInstance(username);
    try {
      return await operation(orm);
    } catch (error) {
      logger.log(`ORM operation failed: ${error.message}`);
      throw error;
    } finally {
      try {
        await orm.close();
      } catch (e) {
        // ignore close error
      }
      release();
    }
  }

  /**
   * Execute native SQL query(return multiple records)
   * @param {string} dbPath - database file path
   * @param {string} sql - SQL statement
   * @param {Array} [params] - SQL parameters
   * @returns {Promise<Array>} - query result
   */
  static async query(dbPath, sql, params = []) {
    const { db, release } = await connectionPool.getConnection(dbPath);
    const username = getUsernameFromDbPath(dbPath);
    const logger = DBLogger.getInstance(username);
    try {
      logger.log(`Executing query: ${sql}`);
      // Use better-sqlite3 synchronous API
      const stmt = db.prepare(sql);
      return stmt.all(params);
    } catch (err) {
      logger.log(`Query failed: ${err.message}`);
      throw err;
    } finally {
      release();
    }
  }

  /**
   * Execute native SQL command(such asINSERT, UPDATE, DELETEetc.)
   * @param {string} dbPath - database file path
   * @param {string} sql - SQL statement
   * @param {Array} [params] - SQL parameters
   * @returns {Promise<{lastID: number, changes: number}>} - execution result
   */
  static async execute(dbPath, sql, params = []) {
    const { db, release } = await connectionPool.getConnection(dbPath);
    const username = getUsernameFromDbPath(dbPath);
    const logger = DBLogger.getInstance(username);
    try {
      logger.log(`Executing command: ${sql}`);
      // Use better-sqlite3 synchronous API
      const stmt = db.prepare(sql);
      const result = stmt.run(params);
      return {
        lastID: result.lastInsertRowid,
        changes: result.changes
      };
    } catch (err) {
      logger.log(`Command failed: ${err.message}`);
      throw err;
    } finally {
      release();
    }
  }

  /**
   * Execute native SQL query(return a single record)
   * @param {string} dbPath - database file path
   * @param {string} sql - SQL statement
   * @param {Array} [params] - SQL parameters
   * @returns {Promise<Object|null>} - query result
   */
  static async get(dbPath, sql, params = []) {
    const { db, release } = await connectionPool.getConnection(dbPath);
    const username = getUsernameFromDbPath(dbPath);
    const logger = DBLogger.getInstance(username);
    try {
      logger.log(`Executing get: ${sql}`);
      // Use better-sqlite3 synchronous API
      const stmt = db.prepare(sql);
      return stmt.get(params);
    } catch (err) {
      logger.log(`Get failed: ${err.message}`);
      throw err;
    } finally {
      release();
    }
  }

  /**
   * close all database connections
   */
  static async closeAllConnections() {
    await connectionPool.closeAll();
  }

  /**
   * Batch execute SQL commands on a single connection(solve multi-connection isolation issues)
   * This method ensures all commands execute on the same database connection, avoid WAL and transaction isolation issues
   * @param {string} dbPath - database file path
   * @param {Array<{sql: string, params?: Array}>} commands - SQL command array
   * @returns {Promise<Array>} - execution result array
   */
  static async executeBatch(dbPath, commands) {
    const { db, release } = await connectionPool.getConnection(dbPath);
    const username = getUsernameFromDbPath(dbPath);
    const logger = DBLogger.getInstance(username);
    const results = [];
    
    try {
      logger.log(`[executeBatch] Starting batch execution of ${commands.length} commands`);
      
      // Set journal_mode to WAL to improve concurrency (optional)
      // And set synchronous mode to NORMAL to speed up writes
      const pragmaCommands = [
        { sql: 'PRAGMA journal_mode=WAL', params: [] },
        { sql: 'PRAGMA synchronous=NORMAL', params: [] },
        { sql: 'PRAGMA foreign_keys=ON', params: [] }
      ];
      
      // First execute PRAGMA settings
      for (const pragma of pragmaCommands) {
        try {
          const stmt = db.prepare(pragma.sql);
          stmt.run(pragma.params);
        } catch (err) {
          logger.log(`[executeBatch] PRAGMA setting failed: ${err.message}, continuing...`);
        }
      }
      
      // Execute all commands in a transaction to ensure atomicity
      const beginStmt = db.prepare('BEGIN TRANSACTION');
      beginStmt.run();
      
      try {
        for (let i = 0; i < commands.length; i++) {
          const command = commands[i];
          const sql = command.sql || command;
          const params = command.params || [];
          
          try {
            logger.log(`[executeBatch] Command ${i + 1}/${commands.length}: ${sql.substring(0, 80)}`);
            const stmt = db.prepare(sql);
            const result = stmt.run(params);
            results.push({
              success: true,
              lastID: result.lastInsertRowid,
              changes: result.changes
            });
          } catch (err) {
            logger.log(`[executeBatch] Command ${i + 1} failed: ${err.message}`);
            // Log errors but continue executing other commands
            results.push({
              success: false,
              error: err.message
            });
            // do not throw exception，continue executing other commands
          }
        }
        
        // Commit the transaction
        const commitStmt = db.prepare('COMMIT');
        commitStmt.run();
        logger.log(`[executeBatch] Batch execution completed successfully`);
        
      } catch (err) {
        // Directory operation failed, rollback the transaction
        try {
          const rollbackStmt = db.prepare('ROLLBACK');
          rollbackStmt.run();
        } catch (rollbackErr) {
          logger.log(`[executeBatch] Rollback failed: ${rollbackErr.message}`);
        }
        throw err;
      }
      
      return results;
    } finally {
      release();
    }
  }

  /**
   * Get connection pool status
   * @returns {Object} - connection pool status info
   */
  static getPoolStatus() {
    const status = {};
    for (const [dbPath, pool] of connectionPool.pools.entries()) {
      status[dbPath] = {
        inUse: pool.inUse,
        available: pool.connections.length,
        waiting: pool.waiting.length
      };
    }
    return status;
  }
}

// Export the unified database operation API
module.exports = {
  UnifiedDB,
  connectionPool,
  // Export the raw ORM class for direct use
  TPishSQLite
};
