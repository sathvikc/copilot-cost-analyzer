/**
 * @fileoverview Tests for discoverSessions() dual-source discovery + dedupe.
 *
 * Builds a fake workspaceStorage tree under a temp dir and passes it via the
 * injectable basePaths argument, so no real VS Code data is touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { discoverSessions } = require('../../src/db/sync');

/** mkdir -p + write a file. */
function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe('discoverSessions', () => {
  let base;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-disc-'));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('discovers debug-logs and chatSessions-only sessions, deduping in favor of debug-logs', () => {
    const wsHash = 'workspaceA';
    const wsDir = path.join(base, wsHash);

    // workspace.json so workspacePath resolves
    writeFile(path.join(wsDir, 'workspace.json'),
      JSON.stringify({ folder: 'file:///Users/me/proj' }));

    // SESSION_X: present in BOTH stores → debug-logs must win
    writeFile(path.join(wsDir, 'GitHub.copilot-chat', 'debug-logs', 'SESSION_X', 'main.jsonl'), '{}\n');
    writeFile(path.join(wsDir, 'chatSessions', 'SESSION_X.jsonl'), '{"kind":0,"v":{}}\n');

    // SESSION_Y: chatSessions only → emitted as fallback
    writeFile(path.join(wsDir, 'chatSessions', 'SESSION_Y.jsonl'), '{"kind":0,"v":{}}\n');

    const found = discoverSessions([base]);

    const x = found.filter((s) => s.sessionId === 'SESSION_X');
    const y = found.filter((s) => s.sessionId === 'SESSION_Y');

    expect(x).toHaveLength(1);
    expect(x[0].source).toBe('debug-logs');
    expect(x[0].debugLogPath).toContain('SESSION_X');
    expect(x[0].mainJsonlMtime).toBeGreaterThan(0);
    expect(x[0].workspacePath).toBe('/Users/me/proj');

    expect(y).toHaveLength(1);
    expect(y[0].source).toBe('chatSessions');
    expect(y[0].chatSessionPath).toContain('SESSION_Y.jsonl');
    expect(y[0].chatSessionMtime).toBeGreaterThan(0);
    expect(y[0].workspacePath).toBe('/Users/me/proj');
  });

  it('does not emit the same chatSessions id twice across workspaces', () => {
    writeFile(path.join(base, 'wsA', 'chatSessions', 'DUP.jsonl'), '{"kind":0,"v":{}}\n');
    writeFile(path.join(base, 'wsB', 'chatSessions', 'DUP.jsonl'), '{"kind":0,"v":{}}\n');

    const found = discoverSessions([base]);
    expect(found.filter((s) => s.sessionId === 'DUP')).toHaveLength(1);
  });

  it('returns [] when no base paths exist', () => {
    expect(discoverSessions([])).toEqual([]);
  });
});
