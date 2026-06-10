/**
 * @fileoverview sql.js database initialization and connection manager.
 *
 * sql.js is a pure-JS SQLite compiled from C via Emscripten.
 * No native *.node bindings required — works on all VS Code platforms.
 */

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { MIGRATIONS } = require('./migrations');

const DB_FILENAME = 'copilot-analytics.db';

class Database {
  /**
   * @param {string} storageDir - Extension globalStorage path
   */
  constructor(storageDir) {
    this.dbPath = path.join(storageDir, DB_FILENAME);
    this.SQL = null;
    this.db = null;
    this._inTransaction = false;
  }

  /**
   * Initialize sql.js, load existing DB or create new, run schema migrations.
   * @returns {Promise<void>}
   */
  async init() {
    this.SQL = await initSqlJs();

    if (fs.existsSync(this.dbPath)) {
      const filebuffer = fs.readFileSync(this.dbPath);
      this.db = new this.SQL.Database(filebuffer);
    } else {
      this.db = new this.SQL.Database();
    }

    this._runSchema();

    // Enable foreign key enforcement AFTER schema init
    // (sql.js resets PRAGMA during multi-statement exec in _runSchema)
    this.db.exec('PRAGMA foreign_keys = ON;');

    this._persist();
  }

  /**
   * Run the schema SQL and apply pending migrations.
   * Uses schema_version table to track which migrations ran.
   * @private
   */
  _runSchema() {
    // 1. Run base schema (CREATE TABLE IF NOT EXISTS)
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    this._execStatements(schema);

    // 2. Ensure schema_version tracking table exists
    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        description TEXT,
        applied_at INTEGER DEFAULT (strftime('%s', 'now'))
      );
    `);

    // 3. Get current version
    let currentVersion = 0;
    try {
      const result = this.db.exec('SELECT MAX(version) as v FROM schema_version;');
      if (result && result[0] && result[0].values && result[0].values[0]) {
        currentVersion = result[0].values[0][0] || 0;
      }
    } catch {
      // Table might be empty — currentVersion stays 0
    }

    // 4. Apply pending migrations in order
    for (const migration of MIGRATIONS) {
      if (migration.version > currentVersion) {
        try {
          migration.run(this.db);
          this.db.run(
            'INSERT INTO schema_version (version, description, applied_at) VALUES ($v, $d, $t);',
            { $v: migration.version, $d: migration.description, $t: Math.floor(Date.now() / 1000) }
          );
          console.log(`[db] Migration ${migration.version} applied: ${migration.description}`);
        } catch (err) {
          console.error(`[db] Migration ${migration.version} FAILED:`, err.message);
          throw err; // Don't continue with broken schema
        }
      }
    }
  }

  /**
   * Execute multi-statement SQL using sql.js native exec().
   * Correctly handles semicolons inside string literals and block comments.
   * @param {string} sql - Multi-statement SQL string
   * @private
   */
  _execStatements(sql) {
    try {
      this.db.exec(sql);
    } catch (err) {
      if (err.message.includes('already exists')) {
        // Expected for IF NOT EXISTS guards on re-init — safe to ignore
        return;
      }
      console.error('[db] Schema error:', err.message);
      throw err;
    }
  }

  /**
   * Execute a multi-statement SQL string directly.
   * Unlike run(), this handles multiple statements separated by semicolons.
   * @param {string} sql
   */
  exec(sql) {
    this._assertReady();
    this._execStatements(sql);
  }

  /**
   * Persist the in-memory database back to disk.
   * Call this after bulk inserts or significant writes.
   */
  persist() {
    this._persist();
  }

  /** @private */
  _persist() {
    if (!this.db) return;
    const data = this.db.export();
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }

  /** @private */
  _assertReady() {
    if (!this.db) throw new Error('Database not initialized. Call init() first.');
  }

  /**
   * Execute a SQL statement that does not return rows.
   * @param {string} sql
   * @param {Object} [params] - keyed parameters { $key: value }
   */
  run(sql, params) {
    this._assertReady();
    this.db.run(sql, params);
  }

  /**
   * Execute a SQL query and return all rows.
   * @param {string} sql
   * @param {Object} [params]
   * @returns {Array<Object>}
   */
  query(sql, params) {
    this._assertReady();
    const stmt = this.db.prepare(sql);
    const rows = [];
    if (params) {
      stmt.bind(params);
    }
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  /**
   * Execute a SQL query and return the first row, or null.
   * @param {string} sql
   * @param {Object} [params]
   * @returns {Object|null}
   */
  queryOne(sql, params) {
    const rows = this.query(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Execute a SQL query and return a single scalar value.
   * @param {string} sql
   * @param {Object} [params]
   * @returns {*} The first column of the first row, or null
   */
  scalar(sql, params) {
    this._assertReady();
    const stmt = this.db.prepare(sql);
    if (params) stmt.bind(params);
    let value = null;
    if (stmt.step()) {
      const row = stmt.get();
      value = row.length > 0 ? row[0] : null;
    }
    stmt.free();
    return value;
  }

  /**
   * Run a function inside a transaction. Commits on success, rolls back on error.
   * Nested calls are no-ops (only the outermost transaction commits).
   * @param {Function} fn - Function to run; receives this Database instance
   * @returns {*} Return value of fn
   */
  transaction(fn) {
    this._assertReady();
    if (this._inTransaction) {
      // Nested call — just run fn without a new transaction
      return fn(this);
    }
    this._inTransaction = true;
    this.db.run('BEGIN TRANSACTION;');
    try {
      const result = fn(this);
      this.db.run('COMMIT;');
      return result;
    } catch (err) {
      this.db.run('ROLLBACK;');
      throw err;
    } finally {
      this._inTransaction = false;
    }
  }

  /**
   * Count rows matching a condition.
   * @param {string} table
   * @param {string} [where] - WHERE clause (without 'WHERE' keyword)
   * @param {Object} [params]
   * @returns {number}
   */
  count(table, where, params) {
    const sql = where
      ? `SELECT COUNT(*) FROM ${table} WHERE ${where}`
      : `SELECT COUNT(*) FROM ${table}`;
    return this.scalar(sql, params) || 0;
  }

  /**
   * Check if a table exists.
   * @param {string} tableName
   * @returns {boolean}
   */
  tableExists(tableName) {
    return this.scalar(
      "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=$name",
      { $name: tableName }
    ) > 0;
  }

  /**
   * Get the current schema version.
   * @returns {number}
   */
  get schemaVersion() {
    try {
      return this.scalar('SELECT MAX(version) FROM schema_version') || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Get database file size in bytes, or 0 if not yet persisted.
   * @returns {number}
   */
  get fileSize() {
    try {
      return fs.existsSync(this.dbPath) ? fs.statSync(this.dbPath).size : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Close the database and persist.
   */
  close() {
    this._persist();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

module.exports = { Database };
