/**
 * @fileoverview Tests for syncSession's chatSessions fallback branch (T4).
 *
 * A chatSessions-only session must land in the DB as an estimated row:
 *   source_type='chatSessions', data_quality='limited', total_aic=NULL,
 *   total_cost=0, with populated llm_calls / user_messages / agent_responses.
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

  it('estimates AIC and cost when a global ratio is available', async () => {
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

    // ratio = 2 AIC/token → computedAic = (1000 + 500) * 2 = 3000
    const ratio = 2;
    await syncSession(db, buildSessionInfo(chatPath), ratio);

    const row = db.queryOne(
      'SELECT computed_aic, computed_cost, is_aic_approx FROM sessions WHERE session_id = $sid',
      { $sid: 'chat-only-001' }
    );
    expect(row.computed_aic).toBe(3000);
    expect(row.is_aic_approx).toBe(1);
    expect(row.computed_cost).toBeCloseTo(3000 / 1e11, 12);
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
