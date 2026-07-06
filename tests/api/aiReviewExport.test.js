/**
 * @fileoverview Tests for the AI review pack export and channel derivation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Database } = require('../../src/db/db');
const { exportSession, getSessions } = require('../../src/api/sessionApi');

describe('ai-review export + channel derivation', () => {
  let db;
  let dbDir;

  beforeEach(async () => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-rev-db-'));
    db = new Database(dbDir);
    await db.init();
  });

  afterEach(() => {
    if (db && db.db) db.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  function seedSession({ sid, sourceType = 'debug-logs', sourcePath = '/x/debug-logs/s1', premium = null }) {
    db.run(`INSERT INTO sessions (
        session_id, workspace_hash, workspace_path, title, start_time, end_time,
        models_used_json, total_llm_calls, total_input_tokens, total_output_tokens,
        total_cached_tokens, computed_aic, computed_cost, cache_hit_pct,
        data_quality, source_path, source_type, total_premium_requests
      ) VALUES ($sid, 'wh', '/ws/proj', 'Test session', 1781889325, 1781892604,
        '["claude-x"]', 3, 100000, 5000, 90000, 12000000000, 0.12, 90.0,
        'full', $src, $type, $prem)`,
      { $sid: sid, $src: sourcePath, $type: sourceType, $prem: premium });
    db.run(`INSERT INTO user_messages (session_id, turn_number, content, is_canceled, interruption_type)
      VALUES ($sid, 1, 'build the thing', 0, NULL)`, { $sid: sid });
    db.run(`INSERT INTO user_messages (session_id, turn_number, content, is_canceled, interruption_type)
      VALUES ($sid, 2, 'continue', 1, 'stopped')`, { $sid: sid });
    db.run(`INSERT INTO llm_calls (session_id, turn_number, call_number, model, input_tokens, output_tokens, cached_tokens, cache_break_type)
      VALUES ($sid, 1, 1, 'claude-x', 50000, 2500, 45000, NULL)`, { $sid: sid });
    db.run(`INSERT INTO llm_calls (session_id, turn_number, call_number, model, input_tokens, output_tokens, cached_tokens, cache_break_type)
      VALUES ($sid, 2, 2, 'claude-x', 50000, 2500, 10000, 'user_interruption')`, { $sid: sid });
    db.run(`INSERT INTO agent_responses (session_id, turn_number, response_text)
      VALUES ($sid, 1, 'I built the thing by doing X then Y.')`, { $sid: sid });
  }

  it('builds a self-contained markdown pack with facts, glossary and turn states', () => {
    seedSession({ sid: 's1' });
    const out = exportSession(db, 's1', { format: 'ai-review' });

    expect(out.mimeType).toBe('text/markdown');
    expect(out.filename).toBe('session-s1-ai-review.md');
    const md = out.data;

    // Preamble + glossary so the reviewing agent needs nothing else
    expect(md).toContain('Do NOT ask');
    expect(md).toContain('## Glossary');
    // Measured facts
    expect(md).toContain('cache hit 90.0%');
    expect(md).toContain('Cache breaks: 1 (1× user_interruption)');
    // Turn-by-turn with end states and verbatim user messages
    expect(md).toContain('### Turn 1 — completed');
    expect(md).toContain('**Me:** build the thing');
    expect(md).toContain('### Turn 2 — stopped');
    expect(md).toContain('cache break: user_interruption');
    // Assistant response trimmed summary
    expect(md).toContain('**Agent (summary):** I built the thing');
    // Wall-clock span under 8h renders as minutes/hours, not a giant number
    expect(md).toMatch(/Duration: (54|55) min/);
  });

  it('includes premium requests for CLI sessions', () => {
    seedSession({ sid: 's2', sourceType: 'copilot-cli', sourcePath: '/home/u/.copilot/session-state/s2/events.jsonl', premium: 7 });
    const md = exportSession(db, 's2', { format: 'ai-review' }).data;
    expect(md).toContain('Source: Copilot CLI');
    expect(md).toContain('Billed premium requests: 7');
  });

  it('derives channel per session in getSessions', () => {
    seedSession({ sid: 'a', sourcePath: '/Users/u/Library/Application Support/Code/User/workspaceStorage/h/GitHub.copilot-chat/debug-logs/a' });
    seedSession({ sid: 'b', sourcePath: '/Users/u/Library/Application Support/Code - Insiders/User/workspaceStorage/h/GitHub.copilot-chat/debug-logs/b' });
    seedSession({ sid: 'c', sourceType: 'copilot-cli', sourcePath: '/home/u/.copilot/session-state/c/events.jsonl' });
    seedSession({ sid: 'd', sourcePath: '/home/u/.vscode-server/data/User/workspaceStorage/h/GitHub.copilot-chat/debug-logs/d' });

    const byId = new Map(getSessions(db).map(s => [s.session_id, s.channel]));
    expect(byId.get('a')).toBe('vscode');
    expect(byId.get('b')).toBe('vscode-insiders');
    expect(byId.get('c')).toBe('cli');
    expect(byId.get('d')).toBe('remote');
  });
});
