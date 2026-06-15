/**
 * @fileoverview Tests for syncSession's chatSessions fallback branch (T4).
 *
 * A chatSessions-only session lands in the DB as a limited row:
 *   source_type='chatSessions', data_quality='limited', total_aic=NULL,
 *   total_cost=0, with populated llm_calls / user_messages / agent_responses.
 * Input/cache/cost/AIC are NOT fabricated (they need debug logs); output is
 * counted from real token counts when present, else estimated from the text.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Database } = require('../../src/db/db');
const { syncSession } = require('../../src/db/sync');

/** Write a chatSessions patch-stream JSONL file and return its path. */
function writeChatSession(dir, name, objs) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, objs.map((o) => JSON.stringify(o)).join('\n'));
  return p;
}

describe('syncSession — chatSessions fallback', () => {
  let db;
  let tmpDir;
  let dbDir;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-cs-sync-'));
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-cs-db-'));
    db = new Database(dbDir);
    await db.init();
  });

  afterEach(() => {
    if (db && db.db) db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  function buildSessionInfo(chatSessionPath, mtime) {
    return {
      sessionId: 'chat-only-001',
      workspaceHash: 'fakehash',
      workspacePath: '/fake/workspace',
      source: 'chatSessions',
      chatSessionPath,
      chatSessionMtime: mtime ?? Math.floor(Date.now())
    };
  }

  it('persists a chatSessions-only session as an estimated row', async () => {
    const chatPath = writeChatSession(tmpDir, 'chat-only-001.jsonl', [
      {
        kind: 0,
        v: {
          customTitle: 'Estimated session',
          initialLocation: 'panel',
          requests: [{
            requestId: 'r0',
            timestamp: 1780892700230,
            modelId: 'copilot/gpt-5-mini',
            modeInfo: { modeId: 'agent' },
            message: { text: 'estimate this turn' },
            response: [],
          }],
        },
      },
      { kind: 1, k: ['requests', 0, 'result'], v: { metadata: { promptTokens: 19608, outputTokens: 49 } } },
      { kind: 1, k: ['requests', 0, 'completionTokens'], v: '1089' },
      { kind: 2, k: ['requests', 0, 'response'], v: { 0: { value: 'Here is the answer.' } } },
    ]);

    const didSync = await syncSession(db, buildSessionInfo(chatPath), 0);
    expect(didSync).toBe(true);

    const row = db.queryOne(
      `SELECT source_type, data_quality, total_aic, total_cost, total_input_tokens,
              total_output_tokens, total_cached_tokens, total_llm_calls, title, mode,
              initial_location, first_prompt
         FROM sessions WHERE session_id = $sid`,
      { $sid: 'chat-only-001' }
    );

    expect(row).not.toBeNull();
    expect(row.source_type).toBe('chatSessions');
    expect(row.data_quality).toBe('limited');
    expect(row.total_aic).toBeNull();
    expect(row.total_cost).toBe(0);
    expect(row.total_cached_tokens).toBeNull();
    expect(row.total_input_tokens).toBe(19608);
    expect(row.total_output_tokens).toBe(1089); // cumulative completionTokens
    expect(row.total_llm_calls).toBe(1);
    expect(row.title).toBe('Estimated session');
    expect(row.mode).toBe('agent');
    expect(row.initial_location).toBe('panel');
    expect(row.first_prompt).toBe('estimate this turn');

    // Child rows are populated so the existing UI renders the conversation.
    const call = db.queryOne(
      'SELECT model, input_tokens, output_tokens, cached_tokens, aic FROM llm_calls WHERE session_id = $sid',
      { $sid: 'chat-only-001' }
    );
    expect(call.model).toBe('gpt-5-mini');
    expect(call.cached_tokens).toBeNull();
    expect(call.aic).toBeNull();

    const msg = db.queryOne(
      'SELECT content FROM user_messages WHERE session_id = $sid', { $sid: 'chat-only-001' });
    expect(msg.content).toBe('estimate this turn');

    const resp = db.queryOne(
      'SELECT response_text FROM agent_responses WHERE session_id = $sid', { $sid: 'chat-only-001' });
    expect(resp.response_text).toBe('Here is the answer.');
  });

  it('never fabricates AIC or cost — even when a global ratio is available', async () => {
    const chatPath = writeChatSession(tmpDir, 'chat-only-001.jsonl', [
      {
        kind: 0,
        v: {
          requests: [{
            requestId: 'r0', timestamp: 1780892700230, modelId: 'copilot/gpt-5-mini',
            message: { text: 'hi' }, response: [],
          }],
        },
      },
      { kind: 1, k: ['requests', 0, 'result'], v: { metadata: { promptTokens: 1000 } } },
      { kind: 1, k: ['requests', 0, 'completionTokens'], v: '500' },
    ]);

    // A ratio is available, but input (the dominant cost) is unrecoverable from
    // chatSessions and debug logs can't be enabled retroactively — so cost/AIC
    // are left at 0 (rendered "—"), never estimated from the ratio.
    await syncSession(db, buildSessionInfo(chatPath), 2);

    const row = db.queryOne(
      'SELECT computed_aic, computed_cost, is_aic_approx FROM sessions WHERE session_id = $sid',
      { $sid: 'chat-only-001' }
    );
    expect(row.computed_aic).toBe(0);
    expect(row.is_aic_approx).toBe(0);
    expect(row.computed_cost).toBe(0);
  });

  it('estimates output tokens from the response text when no counts were recorded', async () => {
    // A completed turn that recorded the assistant text but NO token counts —
    // typical of sessions captured while Copilot debug-logging was off.
    const responseText = 'x'.repeat(400); // 400 chars → ceil(400 / 4) = 100 tokens
    const chatPath = writeChatSession(tmpDir, 'chat-only-001.jsonl', [
      {
        kind: 0,
        v: {
          requests: [{
            requestId: 'r0', timestamp: 1780892700230, modelId: 'copilot/gpt-5-mini',
            message: { text: 'hi' }, response: [],
          }],
        },
      },
      { kind: 2, k: ['requests', 0, 'response'], v: { 0: { value: responseText } } },
    ]);

    await syncSession(db, buildSessionInfo(chatPath), 0);

    const row = db.queryOne(
      `SELECT total_input_tokens, total_output_tokens, computed_aic, is_aic_approx
         FROM sessions WHERE session_id = $sid`,
      { $sid: 'chat-only-001' }
    );
    expect(row.total_input_tokens).toBe(0);     // no system-prompt data → "—" in the UI
    expect(row.total_output_tokens).toBe(100);  // estimated from the response text
    expect(row.computed_aic).toBe(0);           // still never fabricated
    expect(row.is_aic_approx).toBe(0);

    const call = db.queryOne(
      'SELECT input_tokens, output_tokens FROM llm_calls WHERE session_id = $sid',
      { $sid: 'chat-only-001' }
    );
    expect(call.input_tokens).toBe(0);
    expect(call.output_tokens).toBe(100);
  });

  it('does not overwrite a real output count with an estimate', async () => {
    // When the turn carries a real completionTokens count, the response text is
    // ignored for estimation — the recorded number wins.
    const chatPath = writeChatSession(tmpDir, 'chat-only-001.jsonl', [
      {
        kind: 0,
        v: {
          requests: [{
            requestId: 'r0', timestamp: 1780892700230, modelId: 'copilot/gpt-5-mini',
            message: { text: 'hi' }, response: [],
          }],
        },
      },
      { kind: 1, k: ['requests', 0, 'result'], v: { metadata: { promptTokens: 1000 } } },
      { kind: 1, k: ['requests', 0, 'completionTokens'], v: '500' },
      { kind: 2, k: ['requests', 0, 'response'], v: { 0: { value: 'x'.repeat(4000) } } },
    ]);

    await syncSession(db, buildSessionInfo(chatPath), 0);
    const row = db.queryOne(
      'SELECT total_input_tokens, total_output_tokens FROM sessions WHERE session_id = $sid',
      { $sid: 'chat-only-001' }
    );
    expect(row.total_input_tokens).toBe(1000);
    expect(row.total_output_tokens).toBe(500); // real count, not the 1000-token text estimate
  });

  it('skips re-sync when the chatSessions file is unchanged', async () => {
    const chatPath = writeChatSession(tmpDir, 'chat-only-001.jsonl', [
      {
        kind: 0,
        v: {
          requests: [{
            requestId: 'r0', timestamp: 1780892700230, modelId: 'copilot/gpt-5-mini',
            message: { text: 'hi' }, response: [],
          }],
        },
      },
      { kind: 1, k: ['requests', 0, 'completionTokens'], v: '5' },
    ]);

    const info = buildSessionInfo(chatPath, 1000);
    expect(await syncSession(db, info, 0)).toBe(true);
    // Same mtime/size/parser_version → skipped.
    expect(await syncSession(db, info, 0)).toBe(false);
  });

  it('returns false for a session where nothing ran (no model)', async () => {
    const chatPath = writeChatSession(tmpDir, 'chat-only-001.jsonl', [
      { kind: 0, v: { requests: [{ requestId: 'r0', message: { text: 'pending' } }] } },
    ]);
    expect(await syncSession(db, buildSessionInfo(chatPath), 0)).toBe(false);

    const row = db.queryOne(
      'SELECT session_id FROM sessions WHERE session_id = $sid', { $sid: 'chat-only-001' });
    expect(row).toBeNull();
  });
});
