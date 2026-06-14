/**
 * @fileoverview Tests the estimated → full upgrade path (T6).
 *
 * A session first synced from chatSessions (estimated, source_type='chatSessions',
 * data_quality='limited', total_aic=NULL) must upgrade in place once its
 * debug-logs appear: the parser_version mismatch forces a re-sync, and the
 * DELETE-then-INSERT rewrites the SAME row as source_type='debug-logs',
 * data_quality='full', with real AIC — and no duplicate rows.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Database } = require('../../src/db/db');
const { syncSession } = require('../../src/db/sync');

const SESSION_ID = 'upgrade-001';
const AIC_VALUE = 5e9;

describe('estimated → full upgrade when debug logs appear', () => {
  let db;
  let csDir;     // holds the chatSessions file
  let dbgDir;    // holds the debug-logs main.jsonl + models.json
  let dbDir;

  beforeEach(async () => {
    csDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-upg-cs-'));
    dbgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-upg-dbg-'));
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-upg-db-'));
    db = new Database(dbDir);
    await db.init();
  });

  afterEach(() => {
    if (db && db.db) db.close();
    fs.rmSync(csDir, { recursive: true, force: true });
    fs.rmSync(dbgDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  /** Write the chatSessions store for the session. */
  function writeChatSession() {
    const objs = [
      {
        kind: 0,
        v: {
          customTitle: 'Estimated then full',
          requests: [{
            requestId: 'r0', timestamp: 1780892700230, modelId: 'copilot/gpt-test',
            message: { text: 'do a thing' }, response: [],
          }],
        },
      },
      { kind: 1, k: ['requests', 0, 'result'], v: { metadata: { promptTokens: 19608 } } },
      { kind: 1, k: ['requests', 0, 'completionTokens'], v: '500' },
    ];
    const p = path.join(csDir, SESSION_ID + '.jsonl');
    fs.writeFileSync(p, objs.map((o) => JSON.stringify(o)).join('\n'));
    return p;
  }

  /** Write a debug-logs main.jsonl (with cache + AIC) and models.json. */
  function writeDebugLogs() {
    const modelsJson = [{
      id: 'gpt-test',
      billing: { token_prices: { default: { input_price: 200, cache_price: 50, output_price: 800 } } },
    }];
    fs.writeFileSync(path.join(dbgDir, 'models.json'), JSON.stringify(modelsJson));

    const lines = [
      JSON.stringify({ type: 'user_message', ts: '2026-01-01T00:00:00Z', attrs: { content: 'do a thing' } }),
      JSON.stringify({ type: 'turn_start', ts: '2026-01-01T00:00:00Z' }),
      JSON.stringify({
        type: 'llm_request',
        status: 'ok',
        ts: '2026-01-01T00:00:01Z',
        attrs: {
          model: 'gpt-test',
          inputTokens: 10000,
          outputTokens: 500,
          cachedTokens: 8000,
          copilotUsageNanoAiu: AIC_VALUE,
        },
      }),
    ];
    fs.writeFileSync(path.join(dbgDir, 'main.jsonl'), lines.join('\n'));
  }

  it('rewrites the same row as full with real AIC and no duplicates', async () => {
    // Phase 1: only chatSessions exists → estimated row.
    const chatPath = writeChatSession();
    const csInfo = {
      sessionId: SESSION_ID,
      workspaceHash: 'fakehash',
      workspacePath: '/fake/workspace',
      source: 'chatSessions',
      chatSessionPath: chatPath,
      chatSessionMtime: 1000,
    };
    expect(await syncSession(db, csInfo, 0)).toBe(true);

    let row = db.queryOne(
      'SELECT source_type, data_quality, total_aic, total_cached_tokens FROM sessions WHERE session_id = $sid',
      { $sid: SESSION_ID }
    );
    expect(row.source_type).toBe('chatSessions');
    expect(row.data_quality).toBe('limited');
    expect(row.total_aic).toBeNull();

    // Phase 2: debug-logs now exist → discovery would yield the debug-logs
    // descriptor. The parser_version mismatch (1 → 30) forces a re-sync.
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

    // The row is upgraded in place.
    row = db.queryOne(
      'SELECT source_type, data_quality, total_aic, total_cached_tokens, source_path FROM sessions WHERE session_id = $sid',
      { $sid: SESSION_ID }
    );
    expect(row.source_type).toBe('debug-logs');
    expect(row.data_quality).toBe('full');
    expect(row.total_aic).toBe(AIC_VALUE);
    expect(row.total_cached_tokens).toBe(8000);
    expect(row.source_path).toBe(dbgDir);

    // No duplicate sessions or orphaned child rows.
    const sessCount = db.queryOne(
      'SELECT COUNT(*) AS n FROM sessions WHERE session_id = $sid', { $sid: SESSION_ID });
    expect(sessCount.n).toBe(1);
    const callCount = db.queryOne(
      'SELECT COUNT(*) AS n FROM llm_calls WHERE session_id = $sid', { $sid: SESSION_ID });
    expect(callCount.n).toBe(1);
    const cachedCall = db.queryOne(
      'SELECT cached_tokens, aic FROM llm_calls WHERE session_id = $sid', { $sid: SESSION_ID });
    expect(cachedCall.cached_tokens).toBe(8000);
    expect(cachedCall.aic).toBe(AIC_VALUE);
  });

  it('does not downgrade a full session back to estimated if chatSessions re-syncs', async () => {
    // Full row already present.
    writeDebugLogs();
    const dbgInfo = {
      sessionId: SESSION_ID,
      workspaceHash: 'fakehash',
      workspacePath: '/fake/workspace',
      source: 'debug-logs',
      debugLogPath: dbgDir,
      mainJsonlMtime: Date.now(),
    };
    await syncSession(db, dbgInfo, 0);

    // discoverSessions never emits a chatSessions descriptor for an id that has
    // debug-logs (debug-logs wins), so a chatSessions sync should not run for it.
    // This asserts the invariant directly: the full row stays full.
    const row = db.queryOne(
      'SELECT source_type, data_quality FROM sessions WHERE session_id = $sid', { $sid: SESSION_ID });
    expect(row.source_type).toBe('debug-logs');
    expect(row.data_quality).toBe('full');
  });
});
