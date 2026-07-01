/**
 * SQLite Worker for handling database operations in background thread
 */

const sqlite3 = require('better-sqlite3');
const { parentPort } = require('worker_threads');
const DBBase = require('./sqlite-base');

if (!sqlite3.verbose) {
  sqlite3.verbose = () => sqlite3;
}

class DB extends DBBase {
  constructor(fileOrDb) {
    super();
    if (typeof fileOrDb === 'string') {
      this.db = new sqlite3(fileOrDb, { timeout: 5000 });
      
      // Enable WAL mode to support multi-process concurrent access
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('busy_timeout = 5000');
      
      this.shouldClose = true;
    } else {
      this.db = fileOrDb;
      this.shouldClose = false;
    }
  }

  async select() {
    const sql = `SELECT * FROM ${this._table}${this._where}${this._order}${this._limit}`;
    return this._all(sql, this._params);
  }

  async find() {
    this.limit(1);
    const rows = await this.select();
    return rows[0] || null;
  }

  async insert(data = this._data, strict = false) {
    const keys = Object.keys(data);
    if (keys.length === 0) return 0;
    const placeholders = keys.map(() => '?').join(',');
    const values = Object.values(data);

    const sql = `INSERT INTO ${this._table} (${keys.join(',')}) VALUES (${placeholders})`;
    return this._run(sql, values, strict);
  }

  async insertGetId(data = this._data, strict = false) {
    const keys = Object.keys(data);
    if (keys.length === 0) return 0;
    const placeholders = keys.map(() => '?').join(',');
    const values = Object.values(data);

    const sql = `INSERT INTO ${this._table} (${keys.join(',')}) VALUES (${placeholders})`;
    try {
      const stmt = this.db.prepare(sql);
      const result = stmt.run(values);
      return result.lastInsertRowid;
    } catch (err) {
      if (strict) throw err;
      else return 0;
    }
  }

  async update(data = this._data, strict = false) {
    const keys = Object.keys(data);
    if (keys.length === 0) return 0;

    const sets = keys.map(k => `${k}=?`).join(',');
    const values = Object.values(data);
    const sql = `UPDATE ${this._table} SET ${sets}${this._where}`;
    return this._run(sql, [...values, ...this._params], strict);
  }

  async delete() {
    const sql = `DELETE FROM ${this._table}${this._where}`;
    return this._run(sql, this._params);
  }

  async query(sql, params = []) {
    return this._all(sql, params);
  }

  async execute(sql, params = []) {
    return this._run(sql, params);
  }

  async _all(sql, params) {
    try {
      const stmt = this.db.prepare(sql);
      return stmt.all(params);
    } catch (err) {
      console.error(`[SQLite Worker] _all error: sql="${sql}", params=`, params, `error="${err.message}"`);
      throw err;
    }
  }

  async _run(sql, params, strict = false) {
    try {
      const stmt = this.db.prepare(sql);
      const result = stmt.run(params);
      return result.changes || 1;
    } catch (err) {
      if (strict) throw err;
      else return 0;
    }
  }

  async beginTransaction() {
    return this._run('BEGIN TRANSACTION;', []);
  }

  async commit() {
    return this._run('COMMIT;', []);
  }

  async rollback() {
    return this._run('ROLLBACK;', []);
  }

  async close() {
    if (!this.shouldClose) {
      return true;
    }
    this.db.close();
    return true;
  }
}

const dbInstances = new Map();

parentPort.on('message', async (message) => {
  const { taskId, action, dbId, args, state } = message;
  try {
    let db;
    
    if (action === 'init') {
      db = new DB(args[0]);
      dbInstances.set(dbId, db);
      parentPort.postMessage({ taskId, success: true, result: true });
      return;
    }
    
    db = dbInstances.get(dbId);
    if (!db) {
      throw new Error(`Database instance not found: ${dbId}`);
    }
    
    if (state) {
      Object.assign(db, state);
    }
    
    let result;
    switch (action) {
      // Chain methods now execute synchronously on the main thread; the Worker only handles data operations
      case 'select':
      case 'find':
      case 'insert':
      case 'insertGetId':
      case 'update':
      case 'delete':
      case 'query':
      case 'execute':
      case 'beginTransaction':
      case 'commit':
      case 'rollback':
      case 'close':
        result = await db[action](...(args || []));
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }
    
    parentPort.postMessage({ taskId, success: true, result });
    
    if (action === 'close') {
      dbInstances.delete(dbId);
    }
  } catch (error) {
    parentPort.postMessage({ 
      taskId, 
      success: false, 
      error: {
        message: error.message,
        stack: error.stack
      }
    });
  }
});
