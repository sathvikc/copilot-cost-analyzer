/**
 * @fileoverview Database migrations.
 *
 * Each migration has a version number, description, and run function.
 * The schema_version table (managed by db.js) tracks which have been applied.
 * Migrations run in order and only once per installation.
 *
 * First public release: schema.sql already contains the complete baseline schema,
 * so no historical migrations are needed. Add future schema changes here as
 * new entries (version 1, 2, ...) and bump accordingly.
 */

/**
 * @typedef {Object} Migration
 * @property {number} version
 * @property {string} description
 * @property {Function} run - (db) => void
 */

/**
 * Returns the column names of a table from the live sql.js database.
 * @param {object} db - raw sql.js Database (has .exec)
 * @param {string} table
 * @returns {string[]}
 */
function tableColumns(db, table) {
  const res = db.exec(`PRAGMA table_info(${table});`);
  // PRAGMA table_info columns: [cid, name, type, notnull, dflt_value, pk]
  return res[0] ? res[0].values.map((row) => row[1]) : [];
}

/** @type {Migration[]} */
const MIGRATIONS = [
  {
    version: 1,
    description: 'Add source_type to sessions (debug-logs | chatSessions fallback)',
    // Guarded ALTER: schema.sql already adds source_type on fresh installs, and
    // migrations run from version 0, so skip the ALTER when the column exists.
    run: (db) => {
      if (!tableColumns(db, 'sessions').includes('source_type')) {
        db.run("ALTER TABLE sessions ADD COLUMN source_type TEXT DEFAULT 'debug-logs';");
      }
    },
  },
  {
    version: 2,
    description: 'Add cache_break_detail to llm_calls (content-diff verdict for breaks)',
    run: (db) => {
      if (!tableColumns(db, 'llm_calls').includes('cache_break_detail')) {
        db.run('ALTER TABLE llm_calls ADD COLUMN cache_break_detail TEXT;');
      }
    },
  },
];

module.exports = { MIGRATIONS };
