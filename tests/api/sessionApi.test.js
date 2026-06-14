/**
 * @fileoverview Unit tests for sessionApi.js.
 *
 * Uses sql.js with temp directory — tests the full API layer
 * against a real in-memory DB with realistic test data.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Database } = require('../../src/db/db');
const {
  getSessionDetail,
  getSessions,
  getDashboard,
  getToolLeaderboard,
  getModelSwitches,
  getModelCatalog,
  getAgentResponses,
  getDiscoveryEvents,
  getTranscripts,
  exportSession
} = require('../../src/api/sessionApi');

// ---------------------------------------------------------------------------
// Helpers: seed test data
// ---------------------------------------------------------------------------

const SESSION_ID = 'test-session-001';
const SESSION_ID_2 = 'test-session-002';

function seedSession(db, sessionId = SESSION_ID, overrides = {}) {
  db.run(`
    INSERT INTO sessions (session_id, workspace_hash, workspace_path, title, start_time, end_time,
      models_used_json, total_llm_calls, total_input_tokens, total_output_tokens,
      total_cached_tokens, total_cost, total_aic, computed_aic, computed_cost,
      is_aic_approx, cache_hit_pct, data_quality, has_model_switch, has_subagent, source_path)
    VALUES ($sid, $wh, $wp, $title, $st, $et, $models, $calls, $input, $output,
      $cached, $cost, $aic, $caic, $ccost, $approx, $cache, $quality, $switch, $sub, $path)
  `, {
    $sid: sessionId,
    $wh: overrides.workspace_hash || 'abc123',
    $wp: overrides.workspace_path || '/workspace/test',
    $title: overrides.title || 'Test Session',
    $st: overrides.start_time || 1700000000,
    $et: overrides.end_time || 1700003600,
    $models: overrides.models_used_json || '["gpt-5"]',
    $calls: overrides.total_llm_calls || 3,
    $input: overrides.total_input_tokens || 5000,
    $output: overrides.total_output_tokens || 2000,
    $cached: overrides.total_cached_tokens || 1000,
    $cost: overrides.total_cost || 0.05,
    $aic: overrides.total_aic || 3e9,
    $caic: overrides.computed_aic || 3e9,
    $ccost: overrides.computed_cost || 0.03,
    $approx: overrides.is_aic_approx || 0,
    $cache: overrides.cache_hit_pct || 20,
    $quality: overrides.data_quality || 'full',
    $switch: overrides.has_model_switch || 0,
    $sub: overrides.has_subagent || 0,
    $path: overrides.source_path || '/tmp/test'
  });
}

function seedLlmCall(db, sessionId, callNumber, overrides = {}) {
  db.run(`
    INSERT INTO llm_calls (session_id, turn_number, call_number, model,
      input_tokens, cached_tokens, output_tokens, cost, aic, timestamp, status)
    VALUES ($sid, $tn, $cn, $model, $in, $cached, $out, $cost, $aic, $ts, $status)
  `, {
    $sid: sessionId,
    $tn: overrides.turn_number || 1,
    $cn: callNumber,
    $model: overrides.model || 'gpt-5',
    $in: overrides.input_tokens ?? 1000,
    $cached: overrides.cached_tokens ?? 500,
    $out: overrides.output_tokens ?? 300,
    $cost: overrides.cost ?? 0.01,
    $aic: overrides.aic ?? 1e9,
    $ts: overrides.timestamp ?? 1700000100,
    $status: overrides.status || 'ok'
  });
}

function seedToolCall(db, sessionId, toolName, overrides = {}) {
  db.run(`
    INSERT INTO tool_calls (session_id, turn_number, tool_name, args_preview,
      result_size, status, timestamp, compression_method)
    VALUES ($sid, $tn, $name, $args, $size, $status, $ts, $comp)
  `, {
    $sid: sessionId,
    $tn: overrides.turn_number || 1,
    $name: toolName,
    $args: overrides.args_preview || 'preview...',
    $size: overrides.result_size ?? 1024,
    $status: overrides.status || 'ok',
    $ts: overrides.timestamp || 1700000200,
    $comp: overrides.compression_method || null
  });
}

function seedUserMessage(db, sessionId, content, overrides = {}) {
  db.run(`
    INSERT INTO user_messages (session_id, turn_number, content, timestamp, is_canceled)
    VALUES ($sid, $tn, $content, $ts, $canceled)
  `, {
    $sid: sessionId,
    $tn: overrides.turn_number || 1,
    $content: content,
    $ts: overrides.timestamp || 1700000050,
    $canceled: overrides.is_canceled ?? 0
  });
}

function seedModelSwitch(db, sessionId, overrides = {}) {
  db.run(`
    INSERT INTO model_switches (session_id, from_model, to_model, at_call_number, timestamp)
    VALUES ($sid, $from, $to, $at, $ts)
  `, {
    $sid: sessionId,
    $from: overrides.from_model || 'gpt-5',
    $to: overrides.to_model || 'claude-5-sonnet',
    $at: overrides.at_call_number || 2,
    $ts: overrides.timestamp || 1700000300
  });
}

function seedModelCatalog(db, entries) {
  for (const e of entries) {
    db.run(`
      INSERT INTO model_catalog (model_id, display_name, vendor, family, category)
      VALUES ($id, $dn, $vendor, $family, $cat)
    `, {
      $id: e.model_id,
      $dn: e.display_name || e.model_id,
      $vendor: e.vendor || '',
      $family: e.family || '',
      $cat: e.category || ''
    });
  }
}

function seedAgentResponse(db, sessionId, overrides = {}) {
  db.run(`
    INSERT INTO agent_responses (session_id, turn_number, response_text, reasoning_text, timestamp)
    VALUES ($sid, $tn, $resp, $reason, $ts)
  `, {
    $sid: sessionId,
    $tn: overrides.turn_number || 1,
    $resp: overrides.response_text || 'Here is the answer...',
    $reason: overrides.reasoning_text || 'I thought about it...',
    $ts: overrides.timestamp || 1700000400
  });
}

function seedDiscoveryEvent(db, sessionId, overrides = {}) {
  db.run(`
    INSERT INTO discovery_events (session_id, event_type, event_name, details, timestamp)
    VALUES ($sid, $type, $name, $details, $ts)
  `, {
    $sid: sessionId,
    $type: overrides.event_type || 'Skill Discovery',
    $name: overrides.event_name || 'human-checkpoint',
    $details: overrides.details || '/path/to/skill',
    $ts: overrides.timestamp || 1700000050
  });
}

function seedTranscript(db, sessionId, overrides = {}) {
  db.run(`
    INSERT INTO transcripts (session_id, event_type, event_data, event_uuid, timestamp)
    VALUES ($sid, $type, $data, $uuid, $ts)
  `, {
    $sid: sessionId,
    $type: overrides.event_type || 'assistant.message',
    $data: overrides.event_data || '{"text":"hello"}',
    $uuid: overrides.event_uuid || 'uuid-001',
    $ts: overrides.timestamp || 1700000500
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('sessionApi', () => {
  let db;
  let tmpDir;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-api-test-'));
    db = new Database(tmpDir);
    await db.init();
  });

  afterEach(() => {
    if (db && db.db) db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -- getSessions --

  describe('getSessions', () => {
    it('returns empty array for empty DB', () => {
      const result = getSessions(db);
      expect(result).toEqual([]);
    });

    it('returns all sessions ordered by start_time DESC', () => {
      seedSession(db, SESSION_ID, { start_time: 1700000000 });
      seedSession(db, SESSION_ID_2, { start_time: 1700010000, title: 'Later Session' });

      const result = getSessions(db);
      expect(result).toHaveLength(2);
      expect(result[0].session_id).toBe(SESSION_ID_2);
      expect(result[1].session_id).toBe(SESSION_ID);
    });

    it('includes computed fields', () => {
      seedSession(db, SESSION_ID);
      const result = getSessions(db);
      expect(result[0].computed_aic).toBe(3e9);
      expect(result[0].is_aic_approx).toBe(0);
      expect(result[0].data_quality).toBe('full');
      // source_type is surfaced so the UI can split full vs. estimated sessions.
      expect(result[0].source_type).toBe('debug-logs');
    });
  });

  // -- getSessionDetail --

  describe('getSessionDetail', () => {
    it('returns null session for non-existent ID', () => {
      const result = getSessionDetail(db, 'nonexistent');
      expect(result.session).toBeNull();
      expect(result.turns).toEqual([]);
    });

    it('returns session with grouped turns', () => {
      seedSession(db);
      seedUserMessage(db, SESSION_ID, 'Hello, fix this bug', { turn_number: 1 });
      seedLlmCall(db, SESSION_ID, 1, { turn_number: 1, aic: 1e9 });
      seedToolCall(db, SESSION_ID, 'read_file', { turn_number: 1 });
      seedLlmCall(db, SESSION_ID, 2, { turn_number: 1, aic: 0.5e9 });

      seedUserMessage(db, SESSION_ID, 'Now add tests', { turn_number: 2 });
      seedLlmCall(db, SESSION_ID, 3, { turn_number: 2, aic: 2e9 });

      const result = getSessionDetail(db, SESSION_ID);
      expect(result.session).not.toBeNull();
      expect(result.session.title).toBe('Test Session');
      expect(result.turns).toHaveLength(2);

      // Turn 1: 1 message, 1 tool call, 2 LLM calls
      const t1 = result.turns[0];
      expect(t1.turnNumber).toBe(1);
      expect(t1.userMessages).toHaveLength(1);
      expect(t1.toolCalls).toHaveLength(1);
      expect(t1.llmCalls).toHaveLength(2);

      // Turn 2: 1 message, 0 tool calls, 1 LLM call
      const t2 = result.turns[1];
      expect(t2.turnNumber).toBe(2);
      expect(t2.userMessages).toHaveLength(1);
      expect(t2.llmCalls).toHaveLength(1);
    });

    it('includes AIC classification on calls', () => {
      seedSession(db);
      seedLlmCall(db, SESSION_ID, 1, { turn_number: 1, aic: 10e9 }); // expensive (>5 AIC)
      seedLlmCall(db, SESSION_ID, 2, { turn_number: 1, aic: 0.01e9 }); // none (<0.1 AIC)

      const result = getSessionDetail(db, SESSION_ID);
      const t = result.turns[0];
      expect(t.llmCalls[0].aicClass).toBe('expensive');
      expect(t.llmCalls[1].aicClass).toBe('none');
      expect(t.aicClass).toBe('expensive'); // turn-level = highest
    });

    it('distributes estimated AIC when is_aic_approx=1', () => {
      seedSession(db, SESSION_ID, { is_aic_approx: 1, computed_aic: 4e9 });
      seedLlmCall(db, SESSION_ID, 1, { turn_number: 1, aic: 0, input_tokens: 1000, output_tokens: 500 });
      seedLlmCall(db, SESSION_ID, 2, { turn_number: 1, aic: 0, input_tokens: 500, output_tokens: 0 });

      const result = getSessionDetail(db, SESSION_ID);
      // Total tokens: 2000, call1 has 1500/2000 = 75%, call2 has 500/2000 = 25%
      const calls = result.turns[0].llmCalls;
      expect(calls[0].is_aic_approx).toBe(true);
      expect(calls[0].aic).toBe(Math.round(4e9 * 1500 / 2000));
      expect(calls[1].aic).toBe(Math.round(4e9 * 500 / 2000));
    });

    it('reuses getToolLeaderboard and getModelSwitches', () => {
      seedSession(db);
      seedToolCall(db, SESSION_ID, 'read_file', { result_size: 500 });
      seedToolCall(db, SESSION_ID, 'read_file', { result_size: 300 });
      seedToolCall(db, SESSION_ID, 'edit', { result_size: 100 });
      seedModelSwitch(db, SESSION_ID);

      const result = getSessionDetail(db, SESSION_ID);
      expect(result.toolLeaderboard).toHaveLength(2);
      expect(result.toolLeaderboard[0].tool_name).toBe('read_file');
      expect(result.toolLeaderboard[0].calls).toBe(2);
      expect(result.modelSwitches).toHaveLength(1);
    });

    it('marks cold start turns correctly', () => {
      seedSession(db);
      seedLlmCall(db, SESSION_ID, 1, { turn_number: 1, cached_tokens: 0, aic: 1e9 });

      const result = getSessionDetail(db, SESSION_ID);
      expect(result.turns[0].isColdStart).toBe(true);
    });

    it('marks canceled turns correctly', () => {
      seedSession(db);
      seedUserMessage(db, SESSION_ID, 'canceled message', { turn_number: 1, is_canceled: 1 });
      seedLlmCall(db, SESSION_ID, 1, { turn_number: 1, aic: 1e9 });

      const result = getSessionDetail(db, SESSION_ID);
      expect(result.turns[0].isCanceled).toBe(true);
    });
  });

  // -- getDashboard --

  describe('getDashboard', () => {
    it('returns empty arrays for empty DB', () => {
      const result = getDashboard(db);
      expect(result.dailyCost).toEqual([]);
      expect(result.toolsBySession).toEqual([]);
      expect(result.modelsBySession).toEqual([]);
    });

    it('aggregates daily costs', () => {
      seedSession(db, SESSION_ID, { start_time: 1700000000, computed_cost: 0.05 });
      seedSession(db, SESSION_ID_2, { start_time: 1700000000 + 3600, computed_cost: 0.10 });

      const result = getDashboard(db);
      expect(result.dailyCost).toHaveLength(1); // same day
      expect(result.dailyCost[0].sessions).toBe(2);
      expect(result.dailyCost[0].cost).toBeCloseTo(0.15);
    });

    it('enriches model data with vendor from model_catalog', () => {
      seedSession(db);
      seedLlmCall(db, SESSION_ID, 1, { model: 'gpt-5' });

      seedModelCatalog(db, [
        { model_id: 'gpt-5', display_name: 'GPT-5', vendor: 'OpenAI' }
      ]);

      const result = getDashboard(db);
      const modelEntry = result.modelsBySession.find(m => m.model === 'gpt-5');
      expect(modelEntry).toBeDefined();
      expect(modelEntry.vendor).toBe('OpenAI');
      expect(modelEntry.display_name).toBe('GPT-5');
    });

    it('falls back to string matching when model not in catalog', () => {
      seedSession(db);
      seedLlmCall(db, SESSION_ID, 1, { model: 'claude-5-sonnet' });

      const result = getDashboard(db);
      const modelEntry = result.modelsBySession.find(m => m.model === 'claude-5-sonnet');
      expect(modelEntry.vendor).toBe('Anthropic');
    });
  });

  // -- getToolLeaderboard --

  describe('getToolLeaderboard', () => {
    it('returns empty for session with no tools', () => {
      seedSession(db);
      const result = getToolLeaderboard(db, SESSION_ID);
      expect(result).toEqual([]);
    });

    it('aggregates by tool_name', () => {
      seedSession(db);
      seedToolCall(db, SESSION_ID, 'read_file', { result_size: 500 });
      seedToolCall(db, SESSION_ID, 'read_file', { result_size: 300 });
      seedToolCall(db, SESSION_ID, 'grep_search', { result_size: 200, compression_method: 'outputDeltas' });

      const result = getToolLeaderboard(db, SESSION_ID);
      expect(result).toHaveLength(2);
      const rf = result.find(r => r.tool_name === 'read_file');
      expect(rf.calls).toBe(2);
      expect(rf.total_result_size).toBe(800);
      expect(rf.compression_count).toBe(0);

      const gs = result.find(r => r.tool_name === 'grep_search');
      expect(gs.compression_count).toBe(1);
    });
  });

  // -- getModelSwitches --

  describe('getModelSwitches', () => {
    it('returns switches for session', () => {
      seedSession(db);
      seedModelSwitch(db, SESSION_ID, { from_model: 'gpt-5', to_model: 'claude-5', at_call_number: 3 });

      const result = getModelSwitches(db, SESSION_ID);
      expect(result).toHaveLength(1);
      expect(result[0].from_model).toBe('gpt-5');
      expect(result[0].to_model).toBe('claude-5');
    });
  });

  // -- getModelCatalog --

  describe('getModelCatalog', () => {
    it('returns empty for empty catalog', () => {
      const result = getModelCatalog(db);
      expect(result).toEqual([]);
    });

    it('returns all catalog entries', () => {
      seedModelCatalog(db, [
        { model_id: 'gpt-5', vendor: 'OpenAI', display_name: 'GPT-5' },
        { model_id: 'claude-5', vendor: 'Anthropic', display_name: 'Claude 5' }
      ]);

      const result = getModelCatalog(db);
      expect(result).toHaveLength(2);
      // Ordered by vendor, display_name
      expect(result[0].vendor).toBe('Anthropic');
      expect(result[1].vendor).toBe('OpenAI');
    });
  });

  // -- getAgentResponses --

  describe('getAgentResponses', () => {
    it('returns empty for session with no responses', () => {
      seedSession(db);
      const result = getAgentResponses(db, SESSION_ID);
      expect(result).toEqual([]);
    });

    it('returns responses ordered by turn + timestamp', () => {
      seedSession(db);
      seedAgentResponse(db, SESSION_ID, { turn_number: 1, timestamp: 100, response_text: 'first' });
      seedAgentResponse(db, SESSION_ID, { turn_number: 2, timestamp: 200, response_text: 'second' });

      const result = getAgentResponses(db, SESSION_ID);
      expect(result).toHaveLength(2);
      expect(result[0].response_text).toBe('first');
      expect(result[1].response_text).toBe('second');
    });
  });

  // -- getDiscoveryEvents --

  describe('getDiscoveryEvents', () => {
    it('returns empty for session with no events', () => {
      seedSession(db);
      const result = getDiscoveryEvents(db, SESSION_ID);
      expect(result).toEqual([]);
    });

    it('returns discovery events', () => {
      seedSession(db);
      seedDiscoveryEvent(db, SESSION_ID, { event_type: 'Agent Discovery', event_name: 'copilot' });
      seedDiscoveryEvent(db, SESSION_ID, { event_type: 'Skill Discovery', event_name: 'human-checkpoint' });

      const result = getDiscoveryEvents(db, SESSION_ID);
      expect(result).toHaveLength(2);
    });
  });

  // -- getTranscripts --

  describe('getTranscripts', () => {
    it('returns empty for session with no transcripts', () => {
      seedSession(db);
      const result = getTranscripts(db, SESSION_ID);
      expect(result).toEqual([]);
    });

    it('returns transcript events ordered by timestamp', () => {
      seedSession(db);
      seedTranscript(db, SESSION_ID, { event_type: 'session.start', timestamp: 100, event_uuid: 'a' });
      seedTranscript(db, SESSION_ID, { event_type: 'assistant.message', timestamp: 200, event_uuid: 'b' });

      const result = getTranscripts(db, SESSION_ID);
      expect(result).toHaveLength(2);
      expect(result[0].event_type).toBe('session.start');
      expect(result[1].event_type).toBe('assistant.message');
    });
  });

  // -- exportSession --

  describe('exportSession', () => {
    beforeEach(() => {
      seedSession(db);
      seedLlmCall(db, SESSION_ID, 1, { turn_number: 1 });
      seedToolCall(db, SESSION_ID, 'read_file');
      seedUserMessage(db, SESSION_ID, 'hello');
    });

    it('exports as JSON by default', () => {
      const result = exportSession(db, SESSION_ID);
      expect(result.mimeType).toBe('application/json');
      expect(result.filename).toContain('test-ses');
      const parsed = JSON.parse(result.data);
      expect(parsed.session).toBeDefined();
      expect(parsed.turns).toBeDefined();
    });

    it('exports as CSV', () => {
      const result = exportSession(db, SESSION_ID, { format: 'csv' });
      expect(result.mimeType).toBe('text/csv');
      expect(result.data).toContain('session_id,turn,call,model');
      expect(result.data.split('\n').length).toBeGreaterThan(1);
    });

    it('exports as markdown', () => {
      const result = exportSession(db, SESSION_ID, { format: 'markdown' });
      expect(result.mimeType).toBe('text/markdown');
      expect(result.data).toContain('# Session');
      expect(result.data).toContain('## Turns');
    });

    it('respects include options', () => {
      const result = exportSession(db, SESSION_ID, {
        format: 'json',
        includeTurns: false,
        includeToolCalls: false,
        includeLlmCalls: false
      });
      const parsed = JSON.parse(result.data);
      expect(parsed.turns).toBeUndefined();
      expect(parsed.toolCalls).toBeUndefined();
      expect(parsed.llmCalls).toBeUndefined();
    });
  });

  // -- Edge cases --

  describe('edge cases', () => {
    it('session with only tool calls (no LLM calls)', () => {
      seedSession(db, SESSION_ID, { total_llm_calls: 0 });
      seedToolCall(db, SESSION_ID, 'read_file', { turn_number: 1 });

      const result = getSessionDetail(db, SESSION_ID);
      expect(result.session).not.toBeNull();
      expect(result.turns).toHaveLength(1);
      expect(result.turns[0].llmCalls).toHaveLength(0);
      expect(result.turns[0].toolCalls).toHaveLength(1);
    });

    it('empty session (no calls, no messages)', () => {
      seedSession(db, SESSION_ID, { total_llm_calls: 0 });

      const result = getSessionDetail(db, SESSION_ID);
      expect(result.session).not.toBeNull();
      expect(result.turns).toEqual([]);
      expect(result.llmCalls).toEqual([]);
      expect(result.toolCalls).toEqual([]);
    });

    it('session with canceled turns', () => {
      seedSession(db);
      seedUserMessage(db, SESSION_ID, 'first attempt', { turn_number: 1, is_canceled: 1 });
      seedUserMessage(db, SESSION_ID, 'retry', { turn_number: 2, is_canceled: 0 });
      seedLlmCall(db, SESSION_ID, 1, { turn_number: 1, aic: 0.5e9 });
      seedLlmCall(db, SESSION_ID, 2, { turn_number: 2, aic: 1e9 });

      const result = getSessionDetail(db, SESSION_ID);
      expect(result.turns).toHaveLength(2);
      expect(result.turns[0].isCanceled).toBe(true);
      expect(result.turns[1].isCanceled).toBe(false);
    });

    it('buildTurns creates events array for chronological ordering', () => {
      seedSession(db);
      seedUserMessage(db, SESSION_ID, 'msg', { turn_number: 1, timestamp: 100 });
      seedToolCall(db, SESSION_ID, 'edit', { turn_number: 1, timestamp: 200 });
      seedLlmCall(db, SESSION_ID, 1, { turn_number: 1, timestamp: 300, aic: 1e9 });

      const result = getSessionDetail(db, SESSION_ID);
      const events = result.turns[0].events;
      expect(events).toHaveLength(3);
      // Should be ordered by timestamp
      expect(events[0].type).toBe('userMessage');
      expect(events[1].type).toBe('toolCall');
      expect(events[2].type).toBe('llmCall');
    });
  });

  // -- Error paths --

  describe('error handling', () => {
    it('getSessions returns [] when db.query throws', () => {
      const brokenDb = { query: () => { throw new Error('DB locked'); } };
      const result = getSessions(brokenDb);
      expect(result).toEqual([]);
    });

    it('getSessionDetail returns empty structure when db.queryOne throws', () => {
      const brokenDb = {
        queryOne: () => { throw new Error('corrupted'); },
        query: () => { throw new Error('corrupted'); }
      };
      const result = getSessionDetail(brokenDb, 'any');
      expect(result.session).toBeNull();
      expect(result.turns).toEqual([]);
    });

    it('getDashboard returns empty when db.query throws', () => {
      const brokenDb = { query: () => { throw new Error('disk full'); } };
      const result = getDashboard(brokenDb);
      expect(result.dailyCost).toEqual([]);
      expect(result.modelsBySession).toEqual([]);
    });

    it('getModelCatalog returns [] when table does not exist', () => {
      const brokenDb = { query: () => { throw new Error('no such table: model_catalog'); } };
      const result = getModelCatalog(brokenDb);
      expect(result).toEqual([]);
    });
  });

  // -- exportSession additional coverage --

  describe('exportSession extras', () => {
    it('exports with includeAgentResponses option', () => {
      seedSession(db);
      seedLlmCall(db, SESSION_ID, 1, { turn_number: 1 });
      seedAgentResponse(db, SESSION_ID, { response_text: 'test response' });

      const result = exportSession(db, SESSION_ID, { format: 'json', includeAgentResponses: true });
      const parsed = JSON.parse(result.data);
      expect(parsed.agentResponses).toBeDefined();
      expect(parsed.agentResponses).toHaveLength(1);
    });
  });
});
