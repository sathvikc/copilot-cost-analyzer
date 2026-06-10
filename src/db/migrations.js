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

/** @type {Migration[]} */
const MIGRATIONS = [
  // Future schema changes go here, e.g.:
  // {
  //   version: 1,
  //   description: 'Add foo column to sessions',
  //   run: (db) => { db.run('ALTER TABLE sessions ADD COLUMN foo TEXT;'); }
  // },
];

module.exports = { MIGRATIONS };
