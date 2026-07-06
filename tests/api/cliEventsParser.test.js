/**
 * @fileoverview Tests for the Copilot CLI events.jsonl parser and its sync path.
 *
 * Event shapes mirror copilot-agent 1.0.x (see test-samples/copilot-cli-data):
 * per-message outputTokens only, ground-truth session totals (premium requests,
 * nano-AIU, token details, per-model metrics) in session.shutdown, and
 * abort/user_initiated for explicit user cancellation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { parseCliEventsFile } = require('../../src/api/parser/cliEventsParser');
const { Database } = require('../../src/db/db');
const { syncSession, discoverSessions } = require('../../src/db/sync');

const SID = 'cli-test-0001';

function iso(ms) { return new Date(ms).toISOString(); }

const T = 1782831323749;

function fixtureEvents() {
  return [
    { type: 'session.start', data: { sessionId: SID, copilotVersion: '1.0.66', startTime: iso(T),
      context: { cwd: '/Users/me/proj', repository: 'me/proj', branch: 'main' } }, timestamp: iso(T) },
    { type: 'session.model_change', data: { newModel: 'claude-opus-4.6' }, timestamp: iso(T + 100) },
    { type: 'user.message', data: { content: 'build the feature', delivery: 'idle' }, timestamp: iso(T + 1000) },
    { type: 'assistant.turn_start', data: { turnId: '0' }, timestamp: iso(T + 1500) },
    { type: 'assistant.message', data: { messageId: 'm1', model: 'claude-opus-4.6', content: 'On it.',
      reasoningText: 'thinking...', outputTokens: 120, toolRequests: [{ toolCallId: 'tc1', name: 'bash' }] }, timestamp: iso(T + 3000) },
    { type: 'tool.execution_start', data: { toolCallId: 'tc1', toolName: 'bash', arguments: { cmd: 'ls' } }, timestamp: iso(T + 3500) },
    { type: 'tool.execution_complete', data: { toolCallId: 'tc1', success: true, result: { content: 'file-a\nfile-b' } }, timestamp: iso(T + 4200) },
    { type: 'session.model_change', data: { newModel: 'gpt-5.2' }, timestamp: iso(T + 5000) },
    { type: 'assistant.message', data: { messageId: 'm2', model: 'gpt-5.2', content: 'Done.', outputTokens: 60 }, timestamp: iso(T + 6000) },
    { type: 'assistant.turn_end', data: { turnId: '0' }, timestamp: iso(T + 6100) },
    { type: 'user.message', data: { content: 'now run the tests', delivery: 'idle' }, timestamp: iso(T + 10000) },
    { type: 'assistant.message', data: { messageId: 'm3', model: 'gpt-5.2', content: '', outputTokens: 15 }, timestamp: iso(T + 11000) },
    { type: 'tool.execution_start', data: { toolCallId: 'tc2', toolName: 'bash', arguments: { cmd: 'npm test' } }, timestamp: iso(T + 11500) },
    { type: 'abort', data: { reason: 'user_initiated' }, timestamp: iso(T + 12000) },
    { type: 'session.shutdown', data: {
      shutdownType: 'routine', totalPremiumRequests: 3, totalNanoAiu: 83017750000,
      tokenDetails: { input: { tokenCount: 3 }, cache_read: { tokenCount: 500 }, cache_write: { tokenCount: 85298 }, output: { tokenCount: 195 } },
      totalApiDurationMs: 133211,
      modelMetrics: {
        'claude-opus-4.6': { requests: { count: 1, cost: 1 }, usage: { inputTokens: 60000, outputTokens: 120, cacheReadTokens: 400, cacheWriteTokens: 59000 } },
        'gpt-5.2': { requests: { count: 2, cost: 2 }, usage: { inputTokens: 25301, outputTokens: 75, cacheReadTokens: 100, cacheWriteTokens: 26298 } },
      },
    }, timestamp: iso(T + 12500) },
  ];
}

describe('parseCliEventsFile', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-cli-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function writeEvents(events) {
    const p = path.join(tmpDir, 'events.jsonl');
    fs.writeFileSync(p, events.map((e) => JSON.stringify(e)).join('\n'));
    return p;
  }

  it('parses calls, tools, switches, totals and workspace from the event stream', () => {
    const parsed = parseCliEventsFile(writeEvents(fixtureEvents()), SID);

    expect(parsed.workspacePath).toBe('/Users/me/proj');
    expect(parsed.sessionMeta.copilotVersion).toBe('1.0.66');
    expect(parsed.mode).toBe('cli');

    expect(parsed.userMessages.map((m) => m.turnNumber)).toEqual([1, 2]);
    expect(parsed.llmCalls).toHaveLength(3);
    expect(parsed.llmCalls[0].model).toBe('claude-opus-4.6');
    expect(parsed.llmCalls[0].outputTokens).toBe(120);
    expect(parsed.llmCalls[0].inputTokens).toBe(0); // never fabricated
    expect(parsed.llmCalls[0].cachedTokens).toBe(null);
    expect(parsed.llmCalls[2].turnNumber).toBe(2);

    // model_change events: the first (session init) is not a switch; the second is.
    expect(parsed.modelSwitches).toHaveLength(1);
    expect(parsed.modelSwitches[0].fromModel).toBe('claude-opus-4.6');
    expect(parsed.modelSwitches[0].toModel).toBe('gpt-5.2');

    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].toolName).toBe('bash');
    expect(parsed.toolCalls[0].dur).toBe(700);
    expect(parsed.toolCalls[0].resultSize).toBeGreaterThan(0);

    // abort/user_initiated during turn 2 → 'stopped' on that message (index 1).
    expect(parsed.interruptions.get(1)).toBe('stopped');
    expect(parsed.interruptions.has(0)).toBe(false);

    expect(parsed.totals.premiumRequests).toBe(3);
    expect(parsed.totals.nanoAiu).toBe(83017750000);
    expect(parsed.totals.modelMetrics['gpt-5.2'].usage.outputTokens).toBe(75);
    expect(parsed.agentResponses.length).toBe(2); // m3 had no content/reasoning
  });

  it('handles a crashed session (no shutdown) without fabricating totals', () => {
    const events = fixtureEvents().filter((e) => e.type !== 'session.shutdown' && e.type !== 'abort');
    const parsed = parseCliEventsFile(writeEvents(events), SID);
    expect(parsed.totals).toBe(null);
    expect(parsed.llmCalls.reduce((s, c) => s + c.outputTokens, 0)).toBe(195);
  });
});

describe('syncSession — copilot-cli source', () => {
  let db;
  let dbDir;
  let cliBase;

  beforeEach(async () => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-cli-db-'));
    cliBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-cli-state-'));
    db = new Database(dbDir);
    await db.init();
  });

  afterEach(() => {
    if (db && db.db) db.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
    fs.rmSync(cliBase, { recursive: true, force: true });
  });

  function writeSession(events) {
    const dir = path.join(cliBase, SID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));
  }

  it('is discovered via the injectable CLI path and lands as a full-quality row', async () => {
    writeSession(fixtureEvents());

    const found = discoverSessions([], [cliBase]);
    expect(found).toHaveLength(1);
    expect(found[0].source).toBe('copilot-cli');
    expect(found[0].sessionId).toBe(SID);

    const didSync = await syncSession(db, found[0], 0);
    expect(didSync).toBe(true);

    const row = db.queryOne('SELECT * FROM sessions WHERE session_id = $sid', { $sid: SID });
    expect(row.source_type).toBe('copilot-cli');
    expect(row.data_quality).toBe('full');
    expect(row.workspace_path).toBe('/Users/me/proj');
    expect(row.total_premium_requests).toBe(3);
    expect(row.total_aic).toBe(83017750000);
    // modelMetrics preferred: input includes cache reads/writes (VS Code semantic)
    expect(row.total_input_tokens).toBe(85301);
    expect(row.total_output_tokens).toBe(195);
    expect(row.total_cached_tokens).toBe(500);
    expect(row.total_cache_write_tokens).toBe(85298);
    expect(row.has_model_switch).toBe(1);
    expect(row.mode).toBe('cli');

    const interrupted = db.query(
      'SELECT interruption_type FROM user_messages WHERE session_id = $sid ORDER BY turn_number',
      { $sid: SID }
    );
    expect(interrupted[0].interruption_type).toBe(null);
    expect(interrupted[1].interruption_type).toBe('stopped');

    // Re-sync with unchanged file is skipped.
    expect(await syncSession(db, discoverSessions([], [cliBase])[0], 0)).toBe(false);
  });

  it('marks a session without shutdown totals as limited', async () => {
    writeSession(fixtureEvents().filter((e) => e.type !== 'session.shutdown'));
    const found = discoverSessions([], [cliBase]);
    await syncSession(db, found[0], 0);
    const row = db.queryOne('SELECT data_quality, total_premium_requests, total_input_tokens FROM sessions WHERE session_id = $sid', { $sid: SID });
    expect(row.data_quality).toBe('limited');
    expect(row.total_premium_requests).toBe(null);
    expect(row.total_input_tokens).toBe(0);
  });
});
