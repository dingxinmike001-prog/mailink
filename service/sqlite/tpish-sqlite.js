/**
 * mini-think-sqlite3.js
 * Simple ThinkPHP-style SQLite3 ORM(Node.js single-file version)
 */

const { Worker } = require('worker_threads');
const path = require('path');
const DBBase = require('./sqlite-base');

let dbCounter = 0;
const generateDbId = () => `db_${++dbCounter}`;

let worker = null;
let taskCounter = 0;
let taskResults = new Map();

function initWorker() {
  if (!worker) {
    worker = new Worker(path.join(__dirname, 'sqlite-worker.js'));
    worker.on('message', (message) => {
      const { taskId, success, result, error } = message;
      const resolve = taskResults.get(taskId);
      if (resolve) {
        if (success) {
          resolve(result);
        } else {
          const err = new Error(error.message);
          err.stack = error.stack;
          resolve(Promise.reject(err));
        }
        taskResults.delete(taskId);
      }
    });
    
    worker.on('error', (error) => {
      console.error('SQLite Worker error:', error);
      worker = null;
    });
    
    worker.on('exit', (code) => {
      console.error(`SQLite Worker exited with code: ${code}`);
      worker = null;
    });
  }
}

function sendToWorker(message) {
  initWorker();
  return new Promise((resolve) => {
    const taskId = ++taskCounter;
    taskResults.set(taskId, resolve);
    worker.postMessage({ taskId, ...message });
  });
}

class DB extends DBBase {
  constructor(fileOrDb) {
    super();
    this.dbId = generateDbId();
    this.dbPath = fileOrDb;
    this._initPromise = sendToWorker({
      action: 'init',
      dbId: this.dbId,
      args: [fileOrDb]
    });
  }

  // Ensure initialization is complete before executing operations
  async _ensureInit() {
    if (this._initPromise) {
      await this._initPromise;
      this._initPromise = null;
    }
  }

  // Chain operation methods - synchronously return this, only send to Worker on the final operation
  table(name) {
    this._table = name;
    return this;
  }

  where(where, ...params) {
    if (typeof where === 'string') {
      if (params.length > 0) {
        // Defensive check: if the where string lacks a ? placeholder but has parameters, auto-fix
        if (!where.includes('?')) {
          console.warn(`[ORM Warning] where('${where}', ...) called without '?' placeholder. Auto-fixing to '${where} = ?'`);
          where = `${where} = ?`;
        }
        if (this._where) {
          this._where += ' AND ' + where;
        } else {
          this._where = ' WHERE ' + where;
        }
        this._params = [...(this._params || []), ...params];
      } else {
        if (this._where) {
          this._where += ' AND ' + where;
        } else {
          this._where = ' WHERE ' + where;
        }
      }
    } else {
      const { sql, params: newParams } = this._buildWhere(where);
      if (this._where && sql) {
        const condition = sql.replace(' WHERE ', ' AND ');
        this._where += condition;
        this._params = [...(this._params || []), ...newParams];
      } else if (sql) {
        this._where = sql;
        this._params = newParams;
      }
    }
    return this;
  }

  order(str) {
    this._order = str ? ` ORDER BY ${str}` : '';
    return this;
  }

  limit(n, m) {
    if (typeof m === 'undefined') {
      this._limit = ` LIMIT ${n}`;
    } else {
      this._limit = ` LIMIT ${n},${m}`;
    }
    return this;
  }

  data(obj) {
    this._data = obj;
    return this;
  }

  whereLike(field, pattern) {
    const condition = `${field} LIKE ?`;
    if (this._where) {
      this._where += ' AND ' + condition;
    } else {
      this._where = ' WHERE ' + condition;
    }
    this._params = [...(this._params || []), pattern];
    return this;
  }

  whereRaw(sql, params = []) {
    if (this._where) {
      this._where += ' AND ' + sql;
    } else {
      this._where = ' WHERE ' + sql;
    }
    this._params = [...(this._params || []), ...params];
    return this;
  }

  whereIn(field, values) {
    if (!Array.isArray(values) || values.length === 0) {
      return this;
    }
    const placeholders = values.map(() => '?').join(',');
    const condition = `${field} IN (${placeholders})`;
    if (this._where) {
      this._where += ' AND ' + condition;
    } else {
      this._where = ' WHERE ' + condition;
    }
    this._params = [...(this._params || []), ...values];
    return this;
  }

  whereNot(field, value) {
    const condition = `${field} != ?`;
    if (this._where) {
      this._where += ' AND ' + condition;
    } else {
      this._where = ' WHERE ' + condition;
    }
    this._params = [...(this._params || []), value];
    return this;
  }

  whereNotIn(field, values) {
    if (!Array.isArray(values) || values.length === 0) {
      return this;
    }
    const placeholders = values.map(() => '?').join(',');
    const condition = `${field} NOT IN (${placeholders})`;
    if (this._where) {
      this._where += ' AND ' + condition;
    } else {
      this._where = ' WHERE ' + condition;
    }
    this._params = [...(this._params || []), ...values];
    return this;
  }

  whereBetween(field, min, max) {
    const condition = `${field} BETWEEN ? AND ?`;
    if (this._where) {
      this._where += ' AND ' + condition;
    } else {
      this._where = ' WHERE ' + condition;
    }
    this._params = [...(this._params || []), min, max];
    return this;
  }

  whereNull(field) {
    const condition = `${field} IS NULL`;
    if (this._where) {
      this._where += ' AND ' + condition;
    } else {
      this._where = ' WHERE ' + condition;
    }
    return this;
  }

  whereNotNull(field) {
    const condition = `${field} IS NOT NULL`;
    if (this._where) {
      this._where += ' AND ' + condition;
    } else {
      this._where = ' WHERE ' + condition;
    }
    return this;
  }

  whereLt(field, value) {
    const condition = `${field} < ?`;
    if (this._where) {
      this._where += ' AND ' + condition;
    } else {
      this._where = ' WHERE ' + condition;
    }
    this._params = [...(this._params || []), value];
    return this;
  }

  whereGt(field, value) {
    const condition = `${field} > ?`;
    if (this._where) {
      this._where += ' AND ' + condition;
    } else {
      this._where = ' WHERE ' + condition;
    }
    this._params = [...(this._params || []), value];
    return this;
  }

  whereLte(field, value) {
    const condition = `${field} <= ?`;
    if (this._where) {
      this._where += ' AND ' + condition;
    } else {
      this._where = ' WHERE ' + condition;
    }
    this._params = [...(this._params || []), value];
    return this;
  }

  whereGte(field, value) {
    const condition = `${field} >= ?`;
    if (this._where) {
      this._where += ' AND ' + condition;
    } else {
      this._where = ' WHERE ' + condition;
    }
    this._params = [...(this._params || []), value];
    return this;
  }

  orWhere(where, ...params) {
    if (typeof where === 'string') {
      if (this._where) {
        this._where += ' OR ' + where;
      } else {
        this._where = ' WHERE ' + where;
      }
      if (params.length > 0) {
        this._params = [...(this._params || []), ...params];
      }
    } else {
      const { sql, params: newParams } = this._buildWhere(where);
      if (this._where && sql) {
        const condition = sql.replace(' WHERE ', ' OR ');
        this._where += condition;
        this._params = [...(this._params || []), ...newParams];
      } else if (sql) {
        this._where = sql;
        this._params = newParams;
      }
    }
    return this;
  }

  // Data operation methods - asynchronous, sent to Worker
  async select() {
    await this._ensureInit();
    return sendToWorker({
      action: 'select',
      dbId: this.dbId,
      state: {
        _table: this._table,
        _where: this._where,
        _params: this._params,
        _order: this._order,
        _limit: this._limit,
        _data: this._data
      }
    });
  }

  async find() {
    await this._ensureInit();
    return sendToWorker({
      action: 'find',
      dbId: this.dbId,
      state: {
        _table: this._table,
        _where: this._where,
        _params: this._params,
        _order: this._order,
        _limit: this._limit,
        _data: this._data
      }
    });
  }

  async insert(data = this._data, strict = false) {
    await this._ensureInit();
    return sendToWorker({
      action: 'insert',
      dbId: this.dbId,
      args: [data, strict],
      state: {
        _table: this._table,
        _where: this._where,
        _params: this._params,
        _order: this._order,
        _limit: this._limit,
        _data: this._data
      }
    });
  }

  async insertGetId(data = this._data, strict = false) {
    await this._ensureInit();
    return sendToWorker({
      action: 'insertGetId',
      dbId: this.dbId,
      args: [data, strict],
      state: {
        _table: this._table,
        _where: this._where,
        _params: this._params,
        _order: this._order,
        _limit: this._limit,
        _data: this._data
      }
    });
  }

  async update(data = this._data, strict = false) {
    await this._ensureInit();
    return sendToWorker({
      action: 'update',
      dbId: this.dbId,
      args: [data, strict],
      state: {
        _table: this._table,
        _where: this._where,
        _params: this._params,
        _order: this._order,
        _limit: this._limit,
        _data: this._data
      }
    });
  }

  async delete() {
    await this._ensureInit();
    return sendToWorker({
      action: 'delete',
      dbId: this.dbId,
      state: {
        _table: this._table,
        _where: this._where,
        _params: this._params,
        _order: this._order,
        _limit: this._limit,
        _data: this._data
      }
    });
  }

  async query(sql, params = []) {
    await this._ensureInit();
    return sendToWorker({
      action: 'query',
      dbId: this.dbId,
      args: [sql, params],
      state: {
        _table: this._table,
        _where: this._where,
        _params: this._params,
        _order: this._order,
        _limit: this._limit,
        _data: this._data
      }
    });
  }

  async execute(sql, params = []) {
    await this._ensureInit();
    return sendToWorker({
      action: 'execute',
      dbId: this.dbId,
      args: [sql, params],
      state: {
        _table: this._table,
        _where: this._where,
        _params: this._params,
        _order: this._order,
        _limit: this._limit,
        _data: this._data
      }
    });
  }

  async beginTransaction() {
    return sendToWorker({
      action: 'beginTransaction',
      dbId: this.dbId
    });
  }

  async commit() {
    return sendToWorker({
      action: 'commit',
      dbId: this.dbId
    });
  }

  async rollback() {
    return sendToWorker({
      action: 'rollback',
      dbId: this.dbId
    });
  }

  async close() {
    return sendToWorker({
      action: 'close',
      dbId: this.dbId
    });
  }
}

module.exports = DB;

if (require.main === module) {
  (async () => {
    const DB = require('./tpish-sqlite');
    const db = new DB('test.db');

    await db.execute(`CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      age INTEGER,
      status INTEGER
    )`);

    await db.table('users');
    const newId = await db.insertGetId({ name: 'Tom', age: 20, status: 1 });
    console.log('inserted id:', newId);

    await db.table('users');
    await db.where({ status: [1, 2] });
    const rows = await db.select();
    console.log('select:', rows);

    await db.table('users');
    await db.where({ id: newId });
    await db.update({ age: 25 });

    await db.table('users');
    await db.where([['age', '<', 18]]);
    await db.delete();

    await db.beginTransaction();
    try {
      await db.table('users');
      await db.insert({ name: 'Alice', age: 18, status: 1 });
      await db.commit();
      console.log('transaction committed');
    } catch (e) {
      await db.rollback();
      console.log('transaction rolled back');
    }

    await db.close();
    console.log('database closed');
  })();
}
