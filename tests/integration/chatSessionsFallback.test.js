/**
 * @fileoverview End-to-end integration for Option B (chatSessions fallback).
 *
 * Exercises the whole pipeline through the public API layer — not hand-seeded
 * rows — to prove the two governing behaviours hold together:
 *
 *   1. A workspace with only chatSessions (debug logging OFF) still surfaces the
 *      session and its conversation: getSessions lists a limited row (no
 *      fabricated cost/AIC) and getConversation reconstructs the user<->assistant
 *      exchange from agent_responses (transcripts are empty for these sessions).
 *      The session is excluded from Dashboard totals (no recoverable cost/AIC).
 *   2. When debug logs later appear for the same session, a re-sync upgrades the
 *      row in place to full data, and the dashboard reflects real AIC/cache with
 *      no duplicate rows.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Database } = require('../../src/db/db');
const { syncSession } = require('../../src/db/sync');
const { getSessions, getDashboard, getConversation } = require('../../src/api/sessionApi');

const SESSION_ID = 'e2e-option-b-001';
const AIC_VALUE = 5e9;

describe('Option B end-to-end: chatSessions fallback + migration', () => {
  let db;
  let csDir;   // chatSessions store
  let dbgDir;  // debug-logs main.jsonl + models.json
  let dbDir;

  beforeEach(async () => {
    csDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-e2e-cs-'));
    dbgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-e2e-dbg-'));
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-e2e-db-'));
    db = new Database(dbDir);
    await db.init();
  });

  afterEach(() => {
    if (db && db.db) db.close();
    fs.rmSync(csDir, { recursive: true, force: true });
    fs.rmSync(dbgDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  /** Write the chatSessions patch-stream store (always written by Copilot). */
  function writeChatSession() {
    const objs = [
      {
        kind: 0,
        v: {
          customTitle: 'Reconstructed session',
          initialLocation: 'panel',
          requests: [{
            requestId: 'r0',
            timestamp: 1780892700230,
            modelId: 'copilot/gpt-5-mini',
            modeInfo: { modeId: 'agent' },
            message: { text: 'How do I reverse a list?' },
            response: [],
          }],
        },
      },
      { kind: 1, k: ['requests', 0, 'result'], v: { metadata: { promptTokens: 10000 } } },
      { kind: 1, k: ['requests', 0, 'completionTokens'], v: '500' },
      { kind: 2, k: ['requests', 0, 'response'], v: { 0: { value: 'Use list.reverse().' } } },
    ];
    const p = path.join(csDir, SESSION_ID + '.jsonl');
    fs.writeFileSync(p, objs.map((o) => JSON.stringify(o)).join('\n'));
    return p;
  }

  /** Write a debug-logs main.jsonl (cache + real AIC) and models.json. */
  function writeDebugLogs() {
    const modelsJson = [{
      id: 'gpt-5-mini',
      billing: { token_prices: { default: { input_price: 200, cache_price: 50, output_price: 800 } } },
    }];
    fs.writeFileSync(path.join(dbgDir, 'models.json'), JSON.stringify(modelsJson));

    const lines = [
      JSON.stringify({ type: 'user_message', ts: '2026-01-01T00:00:00Z', attrs: { content: 'How do I reverse a list?' } }),
      JSON.stringify({ type: 'turn_start', ts: '2026-01-01T00:00:00Z' }),
      JSON.stringify({
        type: 'llm_request',
        status: 'ok',
        ts: '2026-01-01T00:00:01Z',
        attrs: {
          model: 'gpt-5-mini',
          inputTokens: 10000,
          outputTokens: 500,
          cachedTokens: 8000,
          copilotUsageNanoAiu: AIC_VALUE,
        },
      }),
    ];
    fs.writeFileSync(path.join(dbgDir, 'main.jsonl'), lines.join('\n'));
  }

  function csInfo() {
    return {
      sessionId: SESSION_ID,
      workspaceHash: 'fakehash',
      workspacePath: '/fake/workspace',
      source: 'chatSessions',
      chatSessionPath: writeChatSession(),
      chatSessionMtime: 1000,
    };
  }

  it('chatSessions-only workspace surfaces the session but is excluded from Dashboard totals', async () => {
    expect(await syncSession(db, csInfo(), 0)).toBe(true);

    // getSessions: one limited row with NO fabricated cost/AIC.
    const sessions = getSessions(db);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.session_id).toBe(SESSION_ID);
    expect(s.source_type).toBe('chatSessions');
    expect(s.data_quality).toBe('limited');
    expect(s.is_aic_approx).toBe(0);
    expect(s.computed_cost).toBe(0);
    expect(s.computed_aic).toBe(0);
    expect(s.total_input_tokens).toBe(10000);
    expect(s.total_output_tokens).toBe(500);
    // No real cache figures from chatSessions.
    expect(s.total_cached_tokens).toBeNull();

    // getDashboard: chatSessions are excluded — no cost/AIC/model rollup.
    const dash = getDashboard(db);
    expect(dash.dailyCost).toHaveLength(0);
    expect(dash.modelsBySession.find(m => m.model === 'gpt-5-mini')).toBeUndefined();

    // getConversation: reconstructed from agent_responses (no transcripts exist).
    const convo = getConversation(db, SESSION_ID);
    expect(convo).toHaveLength(2);
    expect(convo[0].role).toBe('user');
    expect(convo[0].content).toBe('How do I reverse a list?');
    expect(convo[1].role).toBe('assistant');
    expect(convo[1].content).toBe('Use list.reverse().');
  });

  it('debug logs upgrade the estimated row to full across the dashboard', async () => {
    // Phase 1: estimated row from chatSessions.
    await syncSession(db, csInfo(), 0);
    expect(getSessions(db)[0].source_type).toBe('chatSessions');

    // Phase 2: debug logs now exist → re-sync upgrades in place.
    writeDebugLogs();
    const dbgInfo = {
      sessionId: SESSION_ID,
      workspaceHash: 'fakehash',
      workspacePath: '/fake/workspace',
      source: 'debug-logs',
      debugLogPath: dbgDir,
      mainJsonlMtime: Date.now(),
    };
    expect(await syncSession(db, dbgInfo, 0)).toBe(true);

    const sessions = getSessions(db);
    expect(sessions).toHaveLength(1); // upgraded in place, not duplicated
    const s = sessions[0];
    expect(s.source_type).toBe('debug-logs');
    expect(s.data_quality).toBe('full');
    expect(s.total_aic).toBe(AIC_VALUE);
    expect(s.is_aic_approx).toBe(0);
    expect(s.total_cached_tokens).toBe(8000);

    // Dashboard now reports the real AIC.
    const dash = getDashboard(db);
    expect(dash.dailyCost).toHaveLength(1);
    expect(dash.dailyCost[0].aic).toBe(AIC_VALUE);
  });
});
