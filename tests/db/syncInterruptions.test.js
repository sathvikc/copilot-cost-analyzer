/**
 * @fileoverview End-to-end tests for the debug-logs × chatSessions interruption
 * cross-reference: edited / steered / interrupted flags on user_messages, and
 * the user_interruption cache-break reclassification.
 *
 * Reproduces the ground-truth shape of test-samples session 18d04628 with a
 * minimal fixture: the chatSessions file is discovered through the platform
 * workspaceStorage candidates, so HOME is pointed at a temp dir containing
 * both the macOS and Linux layouts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Database } = require('../../src/db/db');
const { syncSession } = require('../../src/db/sync');

const SESSION_ID = 'itest-session-001';
const WS_HASH = 'itesthash';

describe('syncSession — interruption cross-reference', () => {
  let db;
  let dbDir;
  let fakeHome;
  let savedHome;
  let debugLogDir;

  beforeEach(async () => {
    savedHome = process.env.HOME;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-int-home-'));
    process.env.HOME = fakeHome;

    // chatSessions file must be reachable via getWorkspaceStoragePaths();
    // create both the macOS and Linux candidate layouts.
    const storageBases = [
      path.join(fakeHome, 'Library/Application Support/Code/User/workspaceStorage'),
      path.join(fakeHome, '.config/Code/User/workspaceStorage'),
    ];
    for (const base of storageBases) {
      fs.mkdirSync(path.join(base, WS_HASH, 'chatSessions'), { recursive: true });
    }
    debugLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-int-logs-'));

    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-int-db-'));
    db = new Database(dbDir);
    await db.init();
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    if (db && db.db) db.close();
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(debugLogDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  /** Write the chatSessions patch stream for this session into both layouts. */
  function writeChatSession(requests) {
    const lines = [JSON.stringify({ kind: 0, v: { sessionId: SESSION_ID, initialLocation: 'panel', requests } })];
    for (const base of [
      path.join(fakeHome, 'Library/Application Support/Code/User/workspaceStorage'),
      path.join(fakeHome, '.config/Code/User/workspaceStorage'),
    ]) {
      fs.writeFileSync(path.join(base, WS_HASH, 'chatSessions', `${SESSION_ID}.jsonl`), lines.join('\n'));
    }
  }

  /** Write main.jsonl events into the debug-log dir. */
  function writeMainJsonl(events) {
    fs.writeFileSync(
      path.join(debugLogDir, 'main.jsonl'),
      events.map((e) => JSON.stringify(e)).join('\n')
    );
  }

  function sessionInfo() {
    return {
      sessionId: SESSION_ID,
      workspaceHash: WS_HASH,
      workspacePath: '/fake/ws',
      source: 'debug-logs',
      debugLogPath: debugLogDir,
      mainJsonlMtime: Math.floor(Date.now()),
    };
  }

  const T = 1781889000000; // base epoch ms

  function llmEvent(ts, { input, cached }) {
    return {
      type: 'llm_request', ts, debugName: 'panel/editAgent', status: 'ok',
      attrs: { model: 'claude-x', inputTokens: input, outputTokens: 100, cachedTokens: cached },
    };
  }

  it('flags steered / interrupted / edited turns and reclassifies the cache break', async () => {
    // Debug log: 4 user turns. Turn 2 gets edited away (absent from chat
    // history), turn 3 is interrupted (empty result), and turn 4's first call
    // shows an otherwise-unexplained cache drop → user_interruption.
    writeMainJsonl([
      { type: 'user_message', ts: T, content: 'first prompt' },
      llmEvent(T + 1000, { input: 10000, cached: 0 }),
      { type: 'user_message', ts: T + 100000, content: 'edited original' },
      llmEvent(T + 101000, { input: 11000, cached: 9800 }),
      { type: 'user_message', ts: T + 200000, content: 'steering follow-up' },
      llmEvent(T + 201000, { input: 12000, cached: 10800 }),
      { type: 'user_message', ts: T + 300000, content: 'after the stop' },
      // Cache fell 10800 → 2000 with same model/prompt/tools and input NOT
      // trimmed → provider_eviction by the metadata ladder, reclassified to
      // user_interruption because turn 3 was interrupted.
      llmEvent(T + 301000, { input: 12500, cached: 2000 }),
    ]);

    // Chat history: 'edited original' is GONE (edited & resent), 'steering
    // follow-up' has an empty result (Stop mid-run, nothing recorded), the
    // first and last completed normally.
    writeChatSession([
      { requestId: 'r0', timestamp: T, message: { text: 'first prompt' },
        result: { timings: { totalElapsed: 5000 }, metadata: {} }, response: [] },
      { requestId: 'r2', timestamp: T + 200000, message: { text: 'steering follow-up' },
        result: {}, response: [] },
      { requestId: 'r3', timestamp: T + 300000, message: { text: 'after the stop' },
        result: { timings: { totalElapsed: 9000 }, metadata: {} }, response: [] },
    ]);

    const didSync = await syncSession(db, sessionInfo(), 0);
    expect(didSync).toBe(true);

    const msgs = db.query(
      'SELECT turn_number, content, is_canceled, interruption_type FROM user_messages WHERE session_id = $sid ORDER BY turn_number',
      { $sid: SESSION_ID }
    );
    expect(msgs).toHaveLength(4);
    expect(msgs[0].interruption_type).toBe(null);
    expect(msgs[1].interruption_type).toBe('edited');
    expect(msgs[1].is_canceled).toBe(1);
    expect(msgs[2].interruption_type).toBe('interrupted');
    expect(msgs[3].interruption_type).toBe(null);

    // The break on turn 4's first call is attributed to the turn-3 interruption.
    const brk = db.queryOne(
      "SELECT cache_break_type, cache_break_detail FROM llm_calls WHERE session_id = $sid AND cache_break_type IS NOT NULL",
      { $sid: SESSION_ID }
    );
    expect(brk.cache_break_type).toBe('user_interruption');
    const detail = JSON.parse(brk.cache_break_detail);
    expect(detail.kind).toBe('user_interruption');
    expect(detail.interruptedTurn).toBe(3);
    expect(detail.how).toBe('interrupted');
  });

  it('flags a steered turn when the canceled request is followed machine-fast', async () => {
    writeMainJsonl([
      { type: 'user_message', ts: T, content: 'do the thing' },
      llmEvent(T + 1000, { input: 10000, cached: 0 }),
      { type: 'user_message', ts: T + 60500, content: 'actually do it differently' },
      llmEvent(T + 61000, { input: 11000, cached: 9800 }),
    ]);

    // Request 0 canceled at T+60000 (elapsed 60s), next sent 500ms later → steered.
    writeChatSession([
      { requestId: 'r0', timestamp: T, message: { text: 'do the thing' },
        result: { errorDetails: { code: 'canceled' }, timings: { totalElapsed: 60000 } }, response: [] },
      { requestId: 'r1', timestamp: T + 60500, message: { text: 'actually do it differently' },
        result: { timings: { totalElapsed: 8000 }, metadata: {} }, response: [] },
    ]);

    await syncSession(db, sessionInfo(), 0);

    const msgs = db.query(
      'SELECT interruption_type FROM user_messages WHERE session_id = $sid ORDER BY turn_number',
      { $sid: SESSION_ID }
    );
    expect(msgs[0].interruption_type).toBe('steered');
    expect(msgs[1].interruption_type).toBe(null);
  });

  it('keeps a confirmed byte-identical eviction as provider_eviction even after an interruption', async () => {
    // Same structural setup as the first test, but both calls around the break
    // carry identical inputMessages prefixes → the content diff proves a true
    // eviction, which must NOT be blamed on the interruption.
    const msgsJson = [
      { role: 'user', parts: [{ type: 'text', content: 'stable prefix' }] },
    ];
    writeMainJsonl([
      { type: 'user_message', ts: T, content: 'first prompt' },
      { type: 'llm_request', ts: T + 1000, debugName: 'panel/editAgent', status: 'ok',
        attrs: { model: 'claude-x', inputTokens: 10000, outputTokens: 100, cachedTokens: 9000, inputMessages: msgsJson } },
      { type: 'user_message', ts: T + 100000, content: 'second prompt' },
      { type: 'llm_request', ts: T + 101000, debugName: 'panel/editAgent', status: 'ok',
        attrs: { model: 'claude-x', inputTokens: 10500, outputTokens: 100, cachedTokens: 1000, inputMessages: msgsJson } },
    ]);
    writeChatSession([
      { requestId: 'r0', timestamp: T, message: { text: 'first prompt' },
        result: {}, response: [] }, // interrupted (unrecorded, not last)
      { requestId: 'r1', timestamp: T + 100000, message: { text: 'second prompt' },
        result: { timings: { totalElapsed: 4000 }, metadata: {} }, response: [] },
    ]);

    await syncSession(db, sessionInfo(), 0);

    const brk = db.queryOne(
      'SELECT cache_break_type, cache_break_detail FROM llm_calls WHERE session_id = $sid AND cache_break_type IS NOT NULL',
      { $sid: SESSION_ID }
    );
    expect(brk.cache_break_type).toBe('provider_eviction');
    expect(JSON.parse(brk.cache_break_detail).kind).toBe('eviction');
  });
});
