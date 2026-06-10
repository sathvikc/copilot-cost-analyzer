#!/usr/bin/env node
/**
 * db-switch.js — swap between demo DB and real DB
 *
 * Usage:
 *   node scripts/db-switch.js demo     — back up real DB, install demo.db
 *   node scripts/db-switch.js restore  — restore most recent backup
 *   node scripts/db-switch.js restore <file>  — restore specific backup
 *   node scripts/db-switch.js backup   — save current DB to backups/ (no swap)
 *   node scripts/db-switch.js list     — list available backups
 *
 * IMPORTANT: Quit VS Code before running demo/restore to prevent the
 * extension host from overwriting the swapped file.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const EXT_ID = 'sathvikcheela.copilot-cost-analyzer';
const DB_NAME = 'copilot-analytics.db';
const DEMO_DB = path.join(__dirname, 'demo.db');
const BACKUPS_DIR = path.join(__dirname, 'db-backups');

const globalStorageBase = path.join(
  os.homedir(),
  'Library', 'Application Support', 'Code', 'User', 'globalStorage'
);
const LIVE_DB = path.join(globalStorageBase, EXT_ID, DB_NAME);

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', 'T').slice(0, 19);
}

function latestBackup() {
  if (!fs.existsSync(BACKUPS_DIR)) return null;
  const files = fs.readdirSync(BACKUPS_DIR)
    .filter(f => f.endsWith('.db'))
    .sort()
    .reverse();
  return files.length ? path.join(BACKUPS_DIR, files[0]) : null;
}

function backup(label = 'manual') {
  if (!fs.existsSync(LIVE_DB)) {
    console.error(`No DB found at:\n  ${LIVE_DB}`);
    process.exit(1);
  }
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const dest = path.join(BACKUPS_DIR, `copilot-analytics-${timestamp()}-${label}.db`);
  fs.copyFileSync(LIVE_DB, dest);
  console.log(`Backed up → ${path.relative(process.cwd(), dest)}`);
  return dest;
}

const [,, cmd, arg] = process.argv;

switch (cmd) {
  case 'demo': {
    if (!fs.existsSync(DEMO_DB)) {
      console.error(`Demo DB not found at scripts/demo.db\nRun: node scripts/generate-demo-db.js`);
      process.exit(1);
    }
    const saved = backup('pre-demo');
    fs.copyFileSync(DEMO_DB, LIVE_DB);
    console.log(`Installed demo DB → ${LIVE_DB}`);
    console.log(`Real DB backed up → ${path.relative(process.cwd(), saved)}`);
    console.log('\nReload VS Code window to pick up the new DB.');
    break;
  }

  case 'restore': {
    const src = arg
      ? (path.isAbsolute(arg) ? arg : path.join(process.cwd(), arg))
      : latestBackup();
    if (!src) {
      console.error('No backups found in scripts/db-backups/');
      process.exit(1);
    }
    if (!fs.existsSync(src)) {
      console.error(`Backup not found: ${src}`);
      process.exit(1);
    }
    fs.copyFileSync(src, LIVE_DB);
    console.log(`Restored ← ${path.relative(process.cwd(), src)}`);
    console.log('\nReload VS Code window to pick up the restored DB.');
    break;
  }

  case 'backup': {
    backup('manual');
    break;
  }

  case 'list': {
    if (!fs.existsSync(BACKUPS_DIR)) { console.log('No backups yet.'); break; }
    const files = fs.readdirSync(BACKUPS_DIR).filter(f => f.endsWith('.db')).sort().reverse();
    if (!files.length) { console.log('No backups yet.'); break; }
    files.forEach(f => {
      const size = (fs.statSync(path.join(BACKUPS_DIR, f)).size / 1024 / 1024).toFixed(1);
      console.log(`  ${f}  (${size} MB)`);
    });
    break;
  }

  default:
    console.log(`Usage:
  node scripts/db-switch.js demo              Install demo DB (backs up real DB first)
  node scripts/db-switch.js restore           Restore most recent backup
  node scripts/db-switch.js restore <file>    Restore specific backup file
  node scripts/db-switch.js backup            Save current DB to db-backups/
  node scripts/db-switch.js list              List available backups`);
    break;
}
