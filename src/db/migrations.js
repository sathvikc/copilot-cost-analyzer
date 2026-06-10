/**
 * @fileoverview Database migrations.
 *
 * Each migration has a version number, description, and run function.
 * The schema_version table tracks which migrations have been applied.
 * Migrations run in order and only once.
 */

/**
 * @typedef {Object} Migration
 * @property {number} version
 * @property {string} description
 * @property {Function} run - (db) => void, where db has .run() method
 */

/** @type {Migration[]} */
const MIGRATIONS = [
  {
    version: 1,
    description: 'Add first_prompt column to sessions',
    run: (db) => {
      try { db.run('ALTER TABLE sessions ADD COLUMN first_prompt TEXT;'); } catch (e) { /* already exists */ }
    }
  },
  {
    version: 2,
    description: 'Add computed metrics columns (v0.5.0)',
    run: (db) => {
      try { db.run('ALTER TABLE sessions ADD COLUMN computed_aic INTEGER DEFAULT 0;'); } catch (e) { /* already exists */ }
      try { db.run('ALTER TABLE sessions ADD COLUMN computed_cost REAL DEFAULT 0;'); } catch (e) { /* already exists */ }
      try { db.run('ALTER TABLE sessions ADD COLUMN is_aic_approx INTEGER DEFAULT 0;'); } catch (e) { /* already exists */ }
      try { db.run('ALTER TABLE sessions ADD COLUMN cache_hit_pct REAL DEFAULT 0;'); } catch (e) { /* already exists */ }
    }
  },
  {
    version: 3,
    description: 'Add cache_write_tokens and subagent_counts (v0.5.1)',
    run: (db) => {
      try { db.run('ALTER TABLE sessions ADD COLUMN total_cache_write_tokens INTEGER;'); } catch (e) { /* already exists */ }
      try { db.run('ALTER TABLE sessions ADD COLUMN subagent_counts_json TEXT;'); } catch (e) { /* already exists */ }
      try { db.run('ALTER TABLE llm_calls ADD COLUMN cache_write_tokens INTEGER;'); } catch (e) { /* already exists */ }
    }
  },
  {
    version: 4,
    description: 'Add user_messages table (v0.5.3)',
    run: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS user_messages (
          msg_id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          turn_number INTEGER DEFAULT 0,
          content TEXT,
          timestamp INTEGER,
          FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
        );
      `);
      db.run('CREATE INDEX IF NOT EXISTS idx_user_messages_session ON user_messages(session_id);');
    }
  },
  {
    version: 5,
    description: 'Add parser_version to sync_log',
    run: (db) => {
      try { db.run('ALTER TABLE sync_log ADD COLUMN parser_version INTEGER DEFAULT 1;'); } catch (e) { /* already exists */ }
    }
  },
  {
    version: 6,
    description: 'Add is_subagent flag to llm_calls (v0.5.24)',
    run: (db) => {
      try { db.run('ALTER TABLE llm_calls ADD COLUMN is_subagent INTEGER DEFAULT 0;'); } catch (e) { /* already exists */ }
    }
  },
  {
    version: 7,
    description: 'Add status column to llm_calls (v0.5.58)',
    run: (db) => {
      try { db.run("ALTER TABLE llm_calls ADD COLUMN status TEXT DEFAULT 'ok';"); } catch (e) { /* already exists */ }
    }
  },
  {
    version: 8,
    description: 'Add ttft to llm_calls and dur to tool_calls (v0.5.63)',
    run: (db) => {
      try { db.run('ALTER TABLE llm_calls ADD COLUMN ttft INTEGER;'); } catch (e) { /* already exists */ }
      try { db.run('ALTER TABLE tool_calls ADD COLUMN dur INTEGER;'); } catch (e) { /* already exists */ }
    }
  },
  {
    version: 9,
    description: 'Add span_id to llm_calls and parent_span_id to tool_calls (v0.5.65)',
    run: (db) => {
      try { db.run('ALTER TABLE llm_calls ADD COLUMN span_id TEXT;'); } catch (e) { /* already exists */ }
      try { db.run('ALTER TABLE tool_calls ADD COLUMN parent_span_id TEXT;'); } catch (e) { /* already exists */ }
    }
  },
  {
    version: 10,
    description: 'Add file_size to sync_log for incremental sync (v0.5.66)',
    run: (db) => {
      try { db.run('ALTER TABLE sync_log ADD COLUMN file_size INTEGER;'); } catch (e) { /* already exists */ }
    }
  },
  {
    version: 11,
    description: 'Add is_canceled to user_messages for edited/canceled turn detection',
    run: (db) => {
      try { db.run('ALTER TABLE user_messages ADD COLUMN is_canceled INTEGER DEFAULT 0;'); } catch (e) { /* already exists */ }
    }
  },
  {
    version: 12,
    description: 'Schema expansion: model_catalog, agent_responses, discovery_events, transcripts, full tool data (v0.5.83)',
    run: (db) => {
      // --- Session metadata columns ---
      try { db.run('ALTER TABLE sessions ADD COLUMN copilot_version TEXT;'); } catch (e) { /* already exists */ }
      try { db.run('ALTER TABLE sessions ADD COLUMN vscode_version TEXT;'); } catch (e) { /* already exists */ }
      try { db.run('ALTER TABLE sessions ADD COLUMN mode TEXT;'); } catch (e) { /* already exists */ }
      try { db.run('ALTER TABLE sessions ADD COLUMN initial_location TEXT;'); } catch (e) { /* already exists */ }

      // --- Expanded tool_calls columns ---
      try { db.run('ALTER TABLE tool_calls ADD COLUMN args_full TEXT;'); } catch (e) { /* already exists */ }
      try { db.run('ALTER TABLE tool_calls ADD COLUMN result_text TEXT;'); } catch (e) { /* already exists */ }

      // --- Model catalog table ---
      db.run(`
        CREATE TABLE IF NOT EXISTS model_catalog (
          model_id TEXT PRIMARY KEY,
          display_name TEXT,
          vendor TEXT,
          family TEXT,
          category TEXT,
          price_category TEXT,
          is_preview INTEGER DEFAULT 0,
          supports_vision INTEGER DEFAULT 0,
          supports_tool_calls INTEGER DEFAULT 0,
          supports_thinking INTEGER DEFAULT 0,
          max_context_tokens INTEGER,
          max_output_tokens INTEGER,
          input_price_per_mtok INTEGER,
          output_price_per_mtok INTEGER,
          cache_price_per_mtok INTEGER,
          capabilities_json TEXT,
          updated_at INTEGER DEFAULT (strftime('%s', 'now'))
        );
      `);

      // --- Agent responses table ---
      db.run(`
        CREATE TABLE IF NOT EXISTS agent_responses (
          response_id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          turn_number INTEGER DEFAULT 0,
          response_text TEXT,
          reasoning_text TEXT,
          timestamp INTEGER,
          span_id TEXT,
          parent_span_id TEXT,
          FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
        );
      `);
      db.run('CREATE INDEX IF NOT EXISTS idx_agent_responses_session ON agent_responses(session_id);');

      // --- Discovery events table ---
      db.run(`
        CREATE TABLE IF NOT EXISTS discovery_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          event_name TEXT,
          details TEXT,
          timestamp INTEGER,
          FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
        );
      `);
      db.run('CREATE INDEX IF NOT EXISTS idx_discovery_events_session ON discovery_events(session_id);');

      // --- Transcripts table (full conversation replay) ---
      db.run(`
        CREATE TABLE IF NOT EXISTS transcripts (
          transcript_id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          event_data TEXT,
          event_uuid TEXT,
          parent_uuid TEXT,
          timestamp INTEGER,
          FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
        );
      `);
      db.run('CREATE INDEX IF NOT EXISTS idx_transcripts_session ON transcripts(session_id);');
      db.run('CREATE INDEX IF NOT EXISTS idx_transcripts_type ON transcripts(event_type);');

      // --- Missing indexes on existing tables ---
      db.run('CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_hash);');
      db.run('CREATE INDEX IF NOT EXISTS idx_sessions_start_time ON sessions(start_time);');
      db.run('CREATE INDEX IF NOT EXISTS idx_llm_calls_turn ON llm_calls(session_id, turn_number);');
      db.run('CREATE INDEX IF NOT EXISTS idx_tool_calls_turn ON tool_calls(session_id, turn_number);');
    }
  },
  {
    version: 13,
    description: 'Add parent_span_id to llm_calls for turn correlation (v0.5.89)',
    run: (db) => {
      try { db.run('ALTER TABLE llm_calls ADD COLUMN parent_span_id TEXT;'); } catch (e) { /* already exists */ }
    }
  },
  {
    version: 14,
    description: 'Add cache_break_type and system_prompt_file to llm_calls (v0.6.11)',
    run: (db) => {
      try { db.run('ALTER TABLE llm_calls ADD COLUMN system_prompt_file TEXT;'); } catch (e) { /* already exists */ }
      try { db.run('ALTER TABLE llm_calls ADD COLUMN cache_break_type TEXT;'); } catch (e) { /* already exists */ }
    }
  },
  {
    version: 15,
    description: 'Add time_since_prev to llm_calls, retry cache break type (v0.6.11)',
    run: (db) => {
      try { db.run('ALTER TABLE llm_calls ADD COLUMN time_since_prev INTEGER;'); } catch (e) { /* already exists */ }
    }
  },
  {
    version: 16,
    description: 'Add tools_file and request_options to llm_calls for tools_changed/options_changed classification (v0.6.12)',
    run: (db) => {
      try { db.run('ALTER TABLE llm_calls ADD COLUMN tools_file TEXT;'); } catch (e) { /* already exists */ }
      try { db.run('ALTER TABLE llm_calls ADD COLUMN request_options TEXT;'); } catch (e) { /* already exists */ }
    }
  }
];

module.exports = { MIGRATIONS };
