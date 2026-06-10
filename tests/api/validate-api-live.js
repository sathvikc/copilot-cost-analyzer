#!/usr/bin/env node
/**
 * Live validation of all sessionApi endpoints against the real DB.
 * Run: node tests/api/validate-api-live.js
 */
const path = require('path');
const { Database } = require('../../src/db/db');
const {
  getSessionDetail, getSessions, getDashboard,
  getToolLeaderboard, getModelSwitches,
  getModelCatalog, getAgentResponses, getDiscoveryEvents,
  getTranscripts, exportSession
} = require('../../src/api/sessionApi');
const { formatCost, formatAic, formatNumber, formatLatency, formatCompact, escapeHtml } = require('../../src/shared/formatters');

const DB_PATH = path.join(
  process.env.HOME,
  'Library/Application Support/Code/User/globalStorage/sathvikcheela.copilot-cost-analyzer'
);

let passed = 0;
let failed = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label} — ${detail || 'FAILED'}`);
    failed++;
  }
}

async function main() {
  const db = new Database(DB_PATH);
  await db.init();

  // --- 1. getSessions ---
  console.log('\n=== getSessions ===');
  const sessions = getSessions(db);
  assert('returns array', Array.isArray(sessions));
  assert('has sessions', sessions.length > 0, `got ${sessions.length}`);
  assert('first session has session_id', !!sessions[0].session_id);
  assert('first session has start_time', sessions[0].start_time > 0);
  assert('has computed fields', sessions[0].computed_aic !== undefined);
  assert('ordered DESC by start_time', sessions.length < 2 || sessions[0].start_time >= sessions[1].start_time);
  console.log(`  → ${sessions.length} sessions total`);

  // Pick test sessions: first, last, and a known interesting one
  const firstSession = sessions[0];
  const lastSession = sessions[sessions.length - 1];
  // Find a session with subagents if possible
  const subagentSession = sessions.find(s => s.has_subagent === 1);
  // Find a session with model switches
  const switchSession = sessions.find(s => s.has_model_switch === 1);

  // --- 2. getSessionDetail ---
  console.log('\n=== getSessionDetail (most recent) ===');
  const detail = getSessionDetail(db, firstSession.session_id);
  assert('session object exists', detail.session !== null);
  assert('session.title is string', typeof detail.session.title === 'string' || detail.session.title === null);
  assert('turns is array', Array.isArray(detail.turns));
  assert('llmCalls is array', Array.isArray(detail.llmCalls));
  assert('toolCalls is array', Array.isArray(detail.toolCalls));
  assert('userMessages is array', Array.isArray(detail.userMessages));
  assert('modelSwitches is array', Array.isArray(detail.modelSwitches));
  assert('toolLeaderboard is array', Array.isArray(detail.toolLeaderboard));

  if (detail.turns.length > 0) {
    const t = detail.turns[0];
    assert('turn has turnNumber', typeof t.turnNumber === 'number');
    assert('turn has aicClass', ['expensive', 'moderate', 'low', 'none'].includes(t.aicClass));
    assert('turn has events array', Array.isArray(t.events));
    assert('turn has isColdStart boolean', typeof t.isColdStart === 'boolean');
    assert('turn has isCanceled boolean', typeof t.isCanceled === 'boolean');
  }

  // Validate turn message counts match raw
  const totalTurnMsgs = detail.turns.reduce((s, t) => s + t.userMessages.length, 0);
  assert('turn msgs = raw msgs', totalTurnMsgs === detail.userMessages.length,
    `turns: ${totalTurnMsgs}, raw: ${detail.userMessages.length}`);
  const totalTurnCalls = detail.turns.reduce((s, t) => s + t.llmCalls.length, 0);
  assert('turn llm = raw llm', totalTurnCalls === detail.llmCalls.length,
    `turns: ${totalTurnCalls}, raw: ${detail.llmCalls.length}`);

  console.log(`  → ${detail.turns.length} turns, ${detail.llmCalls.length} LLM calls, ${detail.toolCalls.length} tools`);
  console.log(`  → session: ${detail.session.session_id.slice(0, 8)}... "${(detail.session.title || '').slice(0, 50)}"`);

  // --- 3. getSessionDetail for non-existent ---
  console.log('\n=== getSessionDetail (non-existent) ===');
  const missing = getSessionDetail(db, 'does-not-exist-xyz');
  assert('returns null session', missing.session === null);
  assert('returns empty turns', missing.turns.length === 0);

  // --- 4. getDashboard ---
  console.log('\n=== getDashboard ===');
  const dashboard = getDashboard(db);
  assert('dailyCost is array', Array.isArray(dashboard.dailyCost));
  assert('has daily data', dashboard.dailyCost.length > 0);
  assert('toolsBySession is array', Array.isArray(dashboard.toolsBySession));
  assert('modelsBySession is array', Array.isArray(dashboard.modelsBySession));

  if (dashboard.modelsBySession.length > 0) {
    const m = dashboard.modelsBySession[0];
    assert('model has vendor', typeof m.vendor === 'string');
    assert('model has model', typeof m.model === 'string');
    console.log(`  → ${dashboard.modelsBySession.length} model entries, vendor sample: "${m.vendor}" for ${m.model}`);
  }
  console.log(`  → ${dashboard.dailyCost.length} days of data`);

  // --- 5. getToolLeaderboard ---
  console.log('\n=== getToolLeaderboard ===');
  const leaderboard = getToolLeaderboard(db, firstSession.session_id);
  assert('returns array', Array.isArray(leaderboard));
  if (leaderboard.length > 0) {
    assert('has tool_name', typeof leaderboard[0].tool_name === 'string');
    assert('has calls count', typeof leaderboard[0].calls === 'number');
    assert('has total_result_size', typeof leaderboard[0].total_result_size === 'number');
    console.log(`  → Top tool: ${leaderboard[0].tool_name} (${leaderboard[0].calls} calls, ${formatCompact(leaderboard[0].total_result_size)} bytes)`);
  }

  // --- 6. getModelSwitches ---
  console.log('\n=== getModelSwitches ===');
  if (switchSession) {
    const switches = getModelSwitches(db, switchSession.session_id);
    assert('returns array', Array.isArray(switches));
    assert('has switches', switches.length > 0, `session ${switchSession.session_id.slice(0,8)} has_model_switch=1`);
    if (switches.length > 0) {
      assert('has from_model', typeof switches[0].from_model === 'string');
      assert('has to_model', typeof switches[0].to_model === 'string');
      console.log(`  → ${switches[0].from_model} → ${switches[0].to_model} at call #${switches[0].at_call_number}`);
    }
  } else {
    console.log('  (no sessions with model switches found, skipping)');
  }

  // --- 7. getModelCatalog ---
  console.log('\n=== getModelCatalog ===');
  const catalog = getModelCatalog(db);
  assert('returns array', Array.isArray(catalog));
  assert('has entries', catalog.length > 0);
  if (catalog.length > 0) {
    assert('has model_id', typeof catalog[0].model_id === 'string');
    assert('has vendor', typeof catalog[0].vendor === 'string' || catalog[0].vendor === null);
    const vendors = [...new Set(catalog.map(c => c.vendor).filter(Boolean))];
    console.log(`  → ${catalog.length} models, vendors: ${vendors.join(', ')}`);
  }

  // --- 8. getAgentResponses ---
  console.log('\n=== getAgentResponses ===');
  const responses = getAgentResponses(db, firstSession.session_id);
  assert('returns array', Array.isArray(responses));
  if (responses.length > 0) {
    assert('has response_text', responses[0].response_text !== undefined);
    assert('has turn_number', typeof responses[0].turn_number === 'number');
    console.log(`  → ${responses.length} responses, first ${(responses[0].response_text || '').length} chars`);
  } else {
    console.log('  → 0 responses for most recent session');
    // Try another session
    const withResponses = sessions.find(s => {
      const r = getAgentResponses(db, s.session_id);
      return r.length > 0;
    });
    if (withResponses) {
      const r = getAgentResponses(db, withResponses.session_id);
      assert('found session with responses', r.length > 0);
      console.log(`  → Session ${withResponses.session_id.slice(0,8)} has ${r.length} responses`);
    }
  }

  // --- 9. getDiscoveryEvents ---
  console.log('\n=== getDiscoveryEvents ===');
  const discovery = getDiscoveryEvents(db, firstSession.session_id);
  assert('returns array', Array.isArray(discovery));
  if (discovery.length > 0) {
    assert('has event_type', typeof discovery[0].event_type === 'string');
    console.log(`  → ${discovery.length} events, types: ${[...new Set(discovery.map(d => d.event_type))].join(', ')}`);
  } else {
    console.log('  → 0 discovery events for most recent session');
  }

  // --- 10. getTranscripts ---
  console.log('\n=== getTranscripts ===');
  const transcripts = getTranscripts(db, firstSession.session_id);
  assert('returns array', Array.isArray(transcripts));
  if (transcripts.length > 0) {
    assert('has event_type', typeof transcripts[0].event_type === 'string');
    assert('has event_data', transcripts[0].event_data !== undefined);
    const types = [...new Set(transcripts.map(t => t.event_type))];
    console.log(`  → ${transcripts.length} transcript events, types: ${types.join(', ')}`);
  } else {
    console.log('  → 0 transcripts for most recent session');
  }

  // --- 11. exportSession ---
  console.log('\n=== exportSession ===');
  const jsonExport = exportSession(db, firstSession.session_id);
  assert('JSON export has data', jsonExport.data.length > 0);
  assert('JSON mimeType', jsonExport.mimeType === 'application/json');
  assert('JSON parses', (() => { try { JSON.parse(jsonExport.data); return true; } catch { return false; } })());

  const csvExport = exportSession(db, firstSession.session_id, { format: 'csv' });
  assert('CSV export has header', csvExport.data.startsWith('session_id,turn,call,model'));
  assert('CSV mimeType', csvExport.mimeType === 'text/csv');

  const mdExport = exportSession(db, firstSession.session_id, { format: 'markdown' });
  assert('MD export has heading', mdExport.data.startsWith('# Session'));
  assert('MD mimeType', mdExport.mimeType === 'text/markdown');
  console.log(`  → JSON: ${formatCompact(jsonExport.data.length)} chars, CSV: ${formatCompact(csvExport.data.length)} chars, MD: ${formatCompact(mdExport.data.length)} chars`);

  // --- 12. Formatters ---
  console.log('\n=== Formatters (smoke test) ===');
  assert('formatCost', formatCost(0.005) === '$0.0050');
  assert('formatAic', formatAic(2.5e9) === '3 AIC'); // >= 1 AIC rounds to integer
  assert('formatNumber', formatNumber(1234567).includes('1'));
  assert('formatLatency', formatLatency(1500) === '1.5s');
  assert('formatCompact', formatCompact(1500000) === '1.5M');
  assert('escapeHtml', escapeHtml('<b>') === '&lt;b&gt;');
  assert('null guards', formatCost(null) === '—' && formatAic(undefined) === '—');

  // --- Summary ---
  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed} checks`);
  if (failed > 0) {
    console.log('⚠️  Some checks failed — review output above');
    process.exit(1);
  } else {
    console.log('✅ All API endpoints returning correct data');
  }

  db.close();
}

main().catch(err => {
  console.error('Validation failed:', err);
  process.exit(1);
});
