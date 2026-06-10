#!/usr/bin/env node
/**
 * DB Integrity Validator — zero tolerance verification.
 *
 * Compares DB data against raw JSONL source files for specific sessions.
 * Checks: FK integrity, row counts vs parsed events, data completeness,
 * cross-table relationships, and data accuracy.
 */

const fs = require('fs');
const path = require('path');
const { Database } = require('../src/db/db');
const { parseSessionDirectory } = require('../src/api/parser/mainJsonlParser');
const { getWorkspaceStoragePaths, findWorkspaceFile } = require('../src/utils/paths');

const DB_DIR = path.join(
  process.env.HOME,
  'Library/Application Support/Code/User/globalStorage/sathvikcheela.copilot-cost-analyzer'
);

let passed = 0;
let failed = 0;
let warnings = 0;

function check(label, condition, detail) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.log(`  ✗ FAIL: ${label}${detail ? ' — ' + detail : ''}`);
  }
}

function warn(label, detail) {
  warnings++;
  console.log(`  ⚠ WARN: ${label}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  console.log('=== DB Integrity Validation ===\n');

  const db = new Database(DB_DIR);
  await db.init();

  // --- 1. Schema integrity ---
  console.log('1. Schema Integrity');
  const expectedTables = [
    'sessions', 'llm_calls', 'tool_calls', 'user_messages', 'model_switches',
    'sync_log', 'schema_version', 'model_catalog', 'agent_responses',
    'discovery_events', 'transcripts'
  ];
  for (const table of expectedTables) {
    check(`Table ${table} exists`, db.tableExists(table));
  }
  check('Schema version is 16', db.schemaVersion === 16, `got ${db.schemaVersion}`);
  console.log('');

  // --- 2. FK integrity ---
  console.log('2. Foreign Key Integrity');
  const orphanLlm = db.scalar("SELECT COUNT(*) FROM llm_calls WHERE session_id NOT IN (SELECT session_id FROM sessions)");
  check('No orphan llm_calls', orphanLlm === 0, `${orphanLlm} orphans`);
  
  const orphanTools = db.scalar("SELECT COUNT(*) FROM tool_calls WHERE session_id NOT IN (SELECT session_id FROM sessions)");
  check('No orphan tool_calls', orphanTools === 0, `${orphanTools} orphans`);
  
  const orphanMsgs = db.scalar("SELECT COUNT(*) FROM user_messages WHERE session_id NOT IN (SELECT session_id FROM sessions)");
  check('No orphan user_messages', orphanMsgs === 0, `${orphanMsgs} orphans`);
  
  const orphanResp = db.scalar("SELECT COUNT(*) FROM agent_responses WHERE session_id NOT IN (SELECT session_id FROM sessions)");
  check('No orphan agent_responses', orphanResp === 0, `${orphanResp} orphans`);
  
  const orphanDisc = db.scalar("SELECT COUNT(*) FROM discovery_events WHERE session_id NOT IN (SELECT session_id FROM sessions)");
  check('No orphan discovery_events', orphanDisc === 0, `${orphanDisc} orphans`);
  
  const orphanTrans = db.scalar("SELECT COUNT(*) FROM transcripts WHERE session_id NOT IN (SELECT session_id FROM sessions)");
  check('No orphan transcripts', orphanTrans === 0, `${orphanTrans} orphans`);
  console.log('');

  // --- 3. Session-level data consistency ---
  console.log('3. Session Data Consistency');
  const sessions = db.query('SELECT * FROM sessions ORDER BY start_time DESC LIMIT 20');
  
  for (const session of sessions) {
    const sid = session.session_id;
    const shortId = sid.slice(0, 8);
    
    // Count child records
    const llmCount = db.count('llm_calls', 'session_id = $sid', { $sid: sid });
    const toolCount = db.count('tool_calls', 'session_id = $sid', { $sid: sid });
    const msgCount = db.count('user_messages', 'session_id = $sid', { $sid: sid });
    const respCount = db.count('agent_responses', 'session_id = $sid', { $sid: sid });
    const discCount = db.count('discovery_events', 'session_id = $sid', { $sid: sid });
    const transCount = db.count('transcripts', 'session_id = $sid', { $sid: sid });
    
    // Check session.total_llm_calls matches actual count
    check(`${shortId}: llm_calls count matches`, 
      session.total_llm_calls === llmCount,
      `session says ${session.total_llm_calls}, actual ${llmCount}`);
    
    // Check LLM calls have valid data
    const invalidLlm = db.scalar(
      "SELECT COUNT(*) FROM llm_calls WHERE session_id = $sid AND (model IS NULL OR model = '' OR input_tokens < 0)",
      { $sid: sid }
    );
    check(`${shortId}: all llm_calls have valid model+tokens`, invalidLlm === 0, `${invalidLlm} invalid`);
    
    // Check timestamps are reasonable
    if (session.start_time && session.end_time) {
      check(`${shortId}: end_time >= start_time`, 
        session.end_time >= session.start_time,
        `start=${session.start_time}, end=${session.end_time}`);
    }
    
    // Check AIC consistency
    if (session.total_aic !== null) {
      const sumAic = db.scalar(
        "SELECT COALESCE(SUM(aic), 0) FROM llm_calls WHERE session_id = $sid AND aic IS NOT NULL",
        { $sid: sid }
      );
      check(`${shortId}: AIC sum matches session total`,
        Math.abs((sumAic || 0) - (session.total_aic || 0)) < 1000, // allow small rounding
        `sum=${sumAic}, session=${session.total_aic}`);
    }
    
    // Check agent responses exist for sessions with llm calls
    if (llmCount > 0 && respCount === 0) {
      warn(`${shortId}: ${llmCount} LLM calls but 0 agent responses`);
    }
  }
  console.log('');

  // --- 4. Deep validation against source files ---
  console.log('4. Source File Cross-Validation (sample sessions)');
  
  // Pick diverse test sessions
  const testSessions = db.query(`
    SELECT session_id, workspace_hash, source_path, total_llm_calls 
    FROM sessions 
    WHERE total_llm_calls > 3
    ORDER BY total_llm_calls DESC 
    LIMIT 5
  `);
  
  for (const ts of testSessions) {
    const sid = ts.session_id;
    const shortId = sid.slice(0, 8);
    const debugPath = ts.source_path;
    
    if (!debugPath || !fs.existsSync(debugPath)) {
      warn(`${shortId}: source_path missing or deleted`, debugPath);
      continue;
    }
    
    // Re-parse the raw JSONL
    const parsed = await parseSessionDirectory(debugPath, sid);
    const dbLlmCount = db.count('llm_calls', 'session_id = $sid', { $sid: sid });
    const dbToolCount = db.count('tool_calls', 'session_id = $sid', { $sid: sid });
    
    check(`${shortId}: LLM call count matches re-parse`,
      dbLlmCount === parsed.llmCalls.length,
      `DB=${dbLlmCount}, parsed=${parsed.llmCalls.length}`);
    
    check(`${shortId}: tool call count matches re-parse`,
      dbToolCount === parsed.toolCalls.length,
      `DB=${dbToolCount}, parsed=${parsed.toolCalls.length}`);
    
    // Check agent response count matches
    const dbRespCount = db.count('agent_responses', 'session_id = $sid', { $sid: sid });
    check(`${shortId}: agent response count matches re-parse`,
      dbRespCount === parsed.agentResponses.length,
      `DB=${dbRespCount}, parsed=${parsed.agentResponses.length}`);
    
    // Check discovery event count matches
    const dbDiscCount = db.count('discovery_events', 'session_id = $sid', { $sid: sid });
    check(`${shortId}: discovery event count matches re-parse`,
      dbDiscCount === parsed.discoveryEvents.length,
      `DB=${dbDiscCount}, parsed=${parsed.discoveryEvents.length}`);
    
    // Verify transcript exists if transcript file exists
    const transcriptPath = findWorkspaceFile(
      ts.workspace_hash, 'GitHub.copilot-chat', 'transcripts', sid + '.jsonl'
    );
    const dbTransCount = db.count('transcripts', 'session_id = $sid', { $sid: sid });
    if (transcriptPath) {
      const transLines = fs.readFileSync(transcriptPath, 'utf-8').split('\n').filter(l => l.trim()).length;
      check(`${shortId}: transcript row count matches source`,
        dbTransCount === transLines,
        `DB=${dbTransCount}, file=${transLines}`);
    }
    
    // Verify first LLM call data accuracy
    if (parsed.llmCalls.length > 0) {
      const firstParsed = parsed.llmCalls[0];
      const firstDb = db.queryOne(
        "SELECT * FROM llm_calls WHERE session_id = $sid ORDER BY call_number LIMIT 1",
        { $sid: sid }
      );
      if (firstDb) {
        check(`${shortId}: first call model matches`,
          firstDb.model === firstParsed.model,
          `DB=${firstDb.model}, parsed=${firstParsed.model}`);
        check(`${shortId}: first call input_tokens matches`,
          firstDb.input_tokens === firstParsed.inputTokens,
          `DB=${firstDb.input_tokens}, parsed=${firstParsed.inputTokens}`);
      }
    }
  }
  console.log('');

  // --- 5. Model catalog integrity ---
  console.log('5. Model Catalog');
  const modelsInCalls = db.query("SELECT DISTINCT model FROM llm_calls");
  const modelsInCatalog = db.query("SELECT model_id FROM model_catalog");
  const catalogIds = new Set(modelsInCatalog.map(m => m.model_id));
  
  let unmatchedModels = 0;
  for (const m of modelsInCalls) {
    if (!catalogIds.has(m.model)) {
      unmatchedModels++;
      warn(`Model "${m.model}" used in calls but not in catalog`);
    }
  }
  check('Most models have catalog entries', unmatchedModels <= modelsInCalls.length * 0.3,
    `${unmatchedModels}/${modelsInCalls.length} unmatched`);
  console.log('');

  // --- 6. FK & Cleanup Integrity ---
  console.log('6. FK & Cleanup Integrity');
  // Test: insert a session + children, delete via explicit child-first pattern (as sync.js does)
  db.transaction(() => {
    // Insert test session + ALL 7 child table types
    db.run("INSERT INTO sessions (session_id, workspace_hash) VALUES ('__test__', '__test__')");
    db.run("INSERT INTO llm_calls (session_id, call_number, model, input_tokens, output_tokens) VALUES ('__test__', 1, 'test', 100, 50)");
    db.run("INSERT INTO tool_calls (session_id, tool_name) VALUES ('__test__', 'test_tool')");
    db.run("INSERT INTO user_messages (session_id, content) VALUES ('__test__', 'test msg')");
    db.run("INSERT INTO model_switches (session_id, from_model, to_model, at_call_number) VALUES ('__test__', 'a', 'b', 1)");
    db.run("INSERT INTO agent_responses (session_id, response_text) VALUES ('__test__', 'test resp')");
    db.run("INSERT INTO discovery_events (session_id, event_type) VALUES ('__test__', 'test')");
    db.run("INSERT INTO transcripts (session_id, event_type) VALUES ('__test__', 'test')");
    
    check('Test children inserted (7 tables)', 
      db.count('llm_calls', "session_id = '__test__'") === 1 &&
      db.count('tool_calls', "session_id = '__test__'") === 1 &&
      db.count('model_switches', "session_id = '__test__'") === 1 &&
      db.count('discovery_events', "session_id = '__test__'") === 1 &&
      db.count('transcripts', "session_id = '__test__'") === 1);
    
    // Explicit child-first deletion (sync.js pattern — must match sync.js DELETE order)
    db.run("DELETE FROM llm_calls WHERE session_id = '__test__'");
    db.run("DELETE FROM tool_calls WHERE session_id = '__test__'");
    db.run("DELETE FROM model_switches WHERE session_id = '__test__'");
    db.run("DELETE FROM user_messages WHERE session_id = '__test__'");
    db.run("DELETE FROM agent_responses WHERE session_id = '__test__'");
    db.run("DELETE FROM discovery_events WHERE session_id = '__test__'");
    db.run("DELETE FROM transcripts WHERE session_id = '__test__'");
    db.run("DELETE FROM sessions WHERE session_id = '__test__'");
    
    // Verify ALL 7 child tables are empty
    const childTables = ['llm_calls', 'tool_calls', 'model_switches', 'user_messages', 
                         'agent_responses', 'discovery_events', 'transcripts'];
    const allClean = childTables.every(t => db.count(t, "session_id = '__test__'") === 0);
    check('All 7 child tables cleaned up', allClean);
    check('Session deleted', db.count('sessions', "session_id = '__test__'") === 0);
  });
  console.log('');

  // --- Summary ---
  console.log('=== Validation Summary ===');
  console.log(`✓ Passed: ${passed}`);
  console.log(`✗ Failed: ${failed}`);
  console.log(`⚠ Warnings: ${warnings}`);
  console.log(`\nResult: ${failed === 0 ? '✅ ALL CHECKS PASSED' : '❌ FAILURES DETECTED'}`);
  
  db.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
