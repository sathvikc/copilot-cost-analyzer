/**
 * @fileoverview Unit tests for Database class (db.js).
 *
 * Uses sql.js with temp directory — tests full init/persist cycle.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Database } = require('../../src/db/db');
const { MIGRATIONS } = require('../../src/db/migrations');

describe('Database', () => {
  let db;
  let tmpDir;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-test-'));
    db = new Database(tmpDir);
    await db.init();
  });

  afterEach(() => {
    if (db && db.db) db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('init()', () => {
    it('creates database and runs schema', () => {
      expect(db.db).not.toBeNull();
      expect(db.tableExists('sessions')).toBe(true);
      expect(db.tableExists('llm_calls')).toBe(true);
      expect(db.tableExists('tool_calls')).toBe(true);
      expect(db.tableExists('user_messages')).toBe(true);
      expect(db.tableExists('model_switches')).toBe(true);
      expect(db.tableExists('sync_log')).toBe(true);
      expect(db.tableExists('schema_version')).toBe(true);
    });

    it('advances schema_version to the latest migration on fresh install', () => {
      const latest = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
      expect(db.schemaVersion).toBe(latest);
    });

    it('has source_type column on sessions (debug-logs default)', () => {
      const cols = db.query('PRAGMA table_info(sessions)').map((r) => r.name);
      expect(cols).toContain('source_type');
      db.run("INSERT INTO sessions (session_id, workspace_hash) VALUES ('st-1', 'h1')");
      const row = db.queryOne("SELECT source_type FROM sessions WHERE session_id = 'st-1'");
      expect(row.source_type).toBe('debug-logs');
    });

    it('persists to disk', () => {
      expect(fs.existsSync(db.dbPath)).toBe(true);
      expect(db.fileSize).toBeGreaterThan(0);
    });

    it('reloads persisted database', async () => {
      db.run("INSERT INTO sessions (session_id, workspace_hash) VALUES ('test-1', 'ws-1')");
      db.persist();
      db.close();

      const db2 = new Database(tmpDir);
      await db2.init();
      const row = db2.queryOne("SELECT session_id FROM sessions WHERE session_id = 'test-1'");
      expect(row).not.toBeNull();
      expect(row.session_id).toBe('test-1');
      db2.close();
    });
  });

  describe('run() / query() / queryOne()', () => {
    it('inserts and queries rows', () => {
      db.run("INSERT INTO sessions (session_id, workspace_hash) VALUES ($sid, $wh)", {
        $sid: 'abc-123', $wh: 'hash1'
      });
      const rows = db.query("SELECT * FROM sessions WHERE session_id = $sid", { $sid: 'abc-123' });
      expect(rows).toHaveLength(1);
      expect(rows[0].session_id).toBe('abc-123');
    });

    it('queryOne returns null for no match', () => {
      const row = db.queryOne("SELECT * FROM sessions WHERE session_id = 'nonexistent'");
      expect(row).toBeNull();
    });
  });

  describe('scalar()', () => {
    it('returns single value', () => {
      db.run("INSERT INTO sessions (session_id, workspace_hash) VALUES ('s1', 'h1')");
      db.run("INSERT INTO sessions (session_id, workspace_hash) VALUES ('s2', 'h1')");
      const count = db.scalar("SELECT COUNT(*) FROM sessions");
      expect(count).toBe(2);
    });

    it('returns null for empty result', () => {
      const val = db.scalar("SELECT session_id FROM sessions WHERE session_id = 'none'");
      expect(val).toBeNull();
    });
  });

  describe('count()', () => {
    it('counts all rows', () => {
      db.run("INSERT INTO sessions (session_id, workspace_hash) VALUES ('s1', 'h1')");
      db.run("INSERT INTO sessions (session_id, workspace_hash) VALUES ('s2', 'h1')");
      expect(db.count('sessions')).toBe(2);
    });

    it('counts with WHERE clause', () => {
      db.run("INSERT INTO sessions (session_id, workspace_hash) VALUES ('s1', 'h1')");
      db.run("INSERT INTO sessions (session_id, workspace_hash) VALUES ('s2', 'h2')");
      expect(db.count('sessions', 'workspace_hash = $wh', { $wh: 'h1' })).toBe(1);
    });
  });

  describe('transaction()', () => {
    it('commits on success', () => {
      db.transaction(() => {
        db.run("INSERT INTO sessions (session_id, workspace_hash) VALUES ('t1', 'h1')");
        db.run("INSERT INTO sessions (session_id, workspace_hash) VALUES ('t2', 'h1')");
      });
      expect(db.count('sessions')).toBe(2);
    });

    it('rolls back on error', () => {
      try {
        db.transaction(() => {
          db.run("INSERT INTO sessions (session_id, workspace_hash) VALUES ('t1', 'h1')");
          throw new Error('test error');
        });
      } catch {
        // expected
      }
      expect(db.count('sessions')).toBe(0);
    });

    it('supports nested calls (no-op inner transaction)', () => {
      db.transaction(() => {
        db.run("INSERT INTO sessions (session_id, workspace_hash) VALUES ('t1', 'h1')");
        db.transaction(() => {
          db.run("INSERT INTO sessions (session_id, workspace_hash) VALUES ('t2', 'h1')");
        });
      });
      expect(db.count('sessions')).toBe(2);
    });

    it('returns the function result', () => {
      const result = db.transaction(() => {
        db.run("INSERT INTO sessions (session_id, workspace_hash) VALUES ('t1', 'h1')");
        return 42;
      });
      expect(result).toBe(42);
    });
  });

  describe('exec()', () => {
    it('runs multiple statements', () => {
      db.exec(`
        INSERT INTO sessions (session_id, workspace_hash) VALUES ('e1', 'h1');
        INSERT INTO sessions (session_id, workspace_hash) VALUES ('e2', 'h1');
      `);
      expect(db.count('sessions')).toBe(2);
    });
  });

  describe('tableExists()', () => {
    it('returns true for existing table', () => {
      expect(db.tableExists('sessions')).toBe(true);
    });

    it('returns false for non-existing table', () => {
      expect(db.tableExists('nonexistent_table')).toBe(false);
    });
  });

  describe('error handling', () => {
    it('throws on operation before init', () => {
      const uninitDb = new Database(tmpDir);
      expect(() => uninitDb.run('SELECT 1')).toThrow('not initialized');
    });
  });
});
