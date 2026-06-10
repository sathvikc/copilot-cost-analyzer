#!/usr/bin/env node
/**
 * Verify DB sync — backs up current DB, deletes it, runs full sync,
 * and checks all tables are populated correctly.
 */

const fs = require('fs');
const path = require('path');
const { Database } = require('../src/db/db');
const { fullSync } = require('../src/db/sync');

const DB_DIR = path.join(
  process.env.HOME, 
  'Library/Application Support/Code/User/globalStorage/sathvikcheela.copilot-cost-analyzer'
);
const DB_PATH = path.join(DB_DIR, 'copilot-analytics.db');
const BACKUP_PATH = DB_PATH + '.backup-' + Date.now();

async function main() {
  console.log('=== DB Sync Verification ===\n');

  // 1. Backup existing DB
  if (fs.existsSync(DB_PATH)) {
    fs.copyFileSync(DB_PATH, BACKUP_PATH);
    console.log(`✓ Backed up DB to ${path.basename(BACKUP_PATH)}`);
    fs.unlinkSync(DB_PATH);
    console.log('✓ Deleted existing DB (will create fresh)\n');
  }

  // 2. Initialize fresh DB
  const db = new Database(DB_DIR);
  await db.init();
  console.log(`✓ Fresh DB created (schema version: ${db.schemaVersion})\n`);

  // 3. Run full sync
  console.log('Running full sync...');
  const startTime = Date.now();
  const result = await fullSync(db);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`✓ Sync completed in ${elapsed}s: ${result.synced} synced, ${result.skipped} skipped, ${result.errors} errors\n`);

  // 4. Verify each table
  const tables = [
    'sessions', 'llm_calls', 'tool_calls', 'user_messages', 
    'model_switches', 'model_catalog', 'agent_responses',
    'discovery_events', 'transcripts', 'sync_log', 'schema_version'
  ];

  console.log('=== Table Row Counts ===');
  for (const table of tables) {
    try {
      const count = db.count(table);
      const status = count > 0 ? '✓' : '⚠';
      console.log(`${status} ${table}: ${count} rows`);
    } catch (err) {
      console.log(`✗ ${table}: ERROR — ${err.message}`);
    }
  }

  // 5. Verify new columns/tables have data
  console.log('\n=== New Data Verification ===');
  
  // Session metadata
  const sessionsWithVersion = db.scalar(
    "SELECT COUNT(*) FROM sessions WHERE copilot_version IS NOT NULL"
  );
  console.log(`Sessions with copilot_version: ${sessionsWithVersion}`);
  
  const sessionsWithMode = db.scalar(
    "SELECT COUNT(*) FROM sessions WHERE mode IS NOT NULL"
  );
  console.log(`Sessions with mode: ${sessionsWithMode}`);
  
  const sessionsWithLocation = db.scalar(
    "SELECT COUNT(*) FROM sessions WHERE initial_location IS NOT NULL"
  );
  console.log(`Sessions with initial_location: ${sessionsWithLocation}`);

  // Model catalog
  const modelCount = db.count('model_catalog');
  if (modelCount > 0) {
    const sampleModels = db.query('SELECT model_id, vendor, category FROM model_catalog LIMIT 5');
    console.log(`\nModel catalog sample (${modelCount} total):`);
    for (const m of sampleModels) {
      console.log(`  ${m.model_id} — ${m.vendor} (${m.category})`);
    }
  }

  // Agent responses
  const respCount = db.count('agent_responses');
  if (respCount > 0) {
    const sampleResp = db.queryOne('SELECT session_id, turn_number, LENGTH(response_text) as len FROM agent_responses LIMIT 1');
    console.log(`\nAgent responses: ${respCount} (sample: turn ${sampleResp?.turn_number}, ${sampleResp?.len} chars)`);
  }

  // Discovery events
  const discCount = db.count('discovery_events');
  if (discCount > 0) {
    const discTypes = db.query('SELECT event_type, COUNT(*) as cnt FROM discovery_events GROUP BY event_type');
    console.log(`\nDiscovery events: ${discCount}`);
    for (const d of discTypes) {
      console.log(`  ${d.event_type}: ${d.cnt}`);
    }
  }

  // Transcripts
  const transCount = db.count('transcripts');
  if (transCount > 0) {
    const transTypes = db.query('SELECT event_type, COUNT(*) as cnt FROM transcripts GROUP BY event_type ORDER BY cnt DESC LIMIT 5');
    console.log(`\nTranscripts: ${transCount}`);
    for (const t of transTypes) {
      console.log(`  ${t.event_type}: ${t.cnt}`);
    }
  }

  // Tool calls with full data
  const toolsWithFullArgs = db.scalar(
    "SELECT COUNT(*) FROM tool_calls WHERE args_full IS NOT NULL"
  );
  const toolsTotal = db.count('tool_calls');
  console.log(`\nTool calls with full args: ${toolsWithFullArgs}/${toolsTotal}`);

  const toolsWithResult = db.scalar(
    "SELECT COUNT(*) FROM tool_calls WHERE result_text IS NOT NULL"
  );
  console.log(`Tool calls with full result: ${toolsWithResult}/${toolsTotal}`);

  // 6. DB size
  db.persist();
  const dbSize = fs.statSync(DB_PATH).size;
  console.log(`\n=== Final DB size: ${(dbSize / 1024 / 1024).toFixed(1)} MB ===`);
  
  db.close();
  console.log('\n✓ Verification complete');
  console.log(`Backup at: ${BACKUP_PATH}`);
}

main().catch(err => {
  console.error('FATAL:', err);
  // Restore backup on failure
  if (fs.existsSync(BACKUP_PATH) && !fs.existsSync(DB_PATH)) {
    fs.copyFileSync(BACKUP_PATH, DB_PATH);
    console.log('Restored backup after failure');
  }
  process.exit(1);
});
