/**
 * SQLite ORM base class
 * Contains common API interfaces and condition building logic
 */

class DBBase {
  constructor() {
    this._table = '';
    this._where = '';
    this._params = [];
    this._order = '';
    this._limit = '';
    this._data = {};
  }

  reset() {
    this._table = '';
    this._where = '';
    this._params = [];
    this._order = '';
    this._limit = '';
    this._data = {};
  }

  table(name) {
    this._table = name;
    return this;
  }

  where(where, ...params) {
    if (typeof where === 'string') {
      if (params.length > 0) {
        // Defensive check: if where string contains no ? placeholder but has parameters, it may be misuse
        // Correct usage: where('field = ?', value) or where({field: value})
        if (!where.includes('?')) {
          console.warn(`[ORM Warning] where('${where}', ...) called without '?' placeholder in where string. ` +
            `Use where('${where} = ?', value) or where({${where}: value}) instead.`);
          // Auto-fix: append "= ?"
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

  _buildWhere(where) {
    if (!where) return { sql: '', params: [] };

    if (typeof where === 'string') {
      return { sql: ` WHERE ${where}`, params: [] };
    }

    if (Array.isArray(where)) {
      const parts = [];
      const params = [];
      for (const cond of where) {
        if (!Array.isArray(cond) || cond.length < 2) continue;
        const [field, opRaw, value] = cond;
        const op = (opRaw || '=').toUpperCase();
        switch (op) {
          case 'IN':
          case 'NOT IN':
            if (!Array.isArray(value)) throw new Error(`where ${field} IN value must be array`);
            const placeholders = value.map(() => '?').join(',');
            parts.push(`${field} ${op} (${placeholders})`);
            params.push(...value);
            break;
          case 'BETWEEN':
          case 'NOT BETWEEN':
            if (!Array.isArray(value) || value.length < 2)
              throw new Error(`where ${field} BETWEEN value must be [a,b]`);
            parts.push(`${field} ${op} ? AND ?`);
            params.push(value[0], value[1]);
            break;
          case 'IS NULL':
          case 'IS NOT NULL':
            parts.push(`${field} ${op}`);
            break;
          default:
            parts.push(`${field} ${op} ?`);
            params.push(value);
        }
      }
      const sql = parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
      return { sql, params };
    }

    if (typeof where === 'object') {
      const parts = [];
      const params = [];
      for (const k of Object.keys(where)) {
        const val = where[k];
        if (val === null) {
          parts.push(`${k} IS NULL`);
        } else if (Array.isArray(val)) {
          const placeholders = val.map(() => '?').join(',');
          parts.push(`${k} IN (${placeholders})`);
          params.push(...val);
        } else if (typeof val === 'object' && val.operator) {
          parts.push(`${k} ${val.operator} ?`);
          params.push(val.value);
        } else {
          parts.push(`${k} = ?`);
          params.push(val);
        }
      }
      const sql = parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
      return { sql, params };
    }

    return { sql: '', params: [] };
  }
}

module.exports = DBBase;
