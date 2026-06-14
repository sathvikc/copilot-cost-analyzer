-- Copilot Cost Analyzer — SQLite Schema (base tables)
-- ALTER TABLE migrations are tracked in migrations.js and applied via schema_version table.

-- Sessions table: one row per Copilot Chat session
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  workspace_hash TEXT NOT NULL,
  workspace_path TEXT,
  title TEXT,
  start_time INTEGER, -- Unix timestamp (seconds)
  end_time INTEGER,
  models_used_json TEXT, -- JSON array of model IDs
  total_llm_calls INTEGER DEFAULT 0,
  total_input_tokens INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  total_cached_tokens INTEGER,
  total_cache_write_tokens INTEGER,
  total_cost REAL DEFAULT 0,
  total_aic INTEGER,
  subagent_counts_json TEXT,
  computed_aic INTEGER DEFAULT 0,
  computed_cost REAL DEFAULT 0,
  is_aic_approx INTEGER DEFAULT 0,
  cache_hit_pct REAL DEFAULT 0,
  data_quality TEXT DEFAULT 'limited', -- 'full' | 'limited'
  has_model_switch INTEGER DEFAULT 0,
  has_subagent INTEGER DEFAULT 0,
  source_path TEXT,
  source_type TEXT DEFAULT 'debug-logs', -- 'debug-logs' | 'chatSessions' (estimated fallback)
  first_prompt TEXT,
  copilot_version TEXT,
  vscode_version TEXT,
  mode TEXT, -- 'agent' | 'edit' | 'ask'
  initial_location TEXT, -- 'panel' | 'inline'
  synced_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- User messages table
CREATE TABLE IF NOT EXISTS user_messages (
  msg_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_number INTEGER DEFAULT 0,
  content TEXT,
  timestamp INTEGER,
  is_canceled INTEGER DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_messages_session ON user_messages(session_id);

-- LLM calls table: one row per llm_request event
CREATE TABLE IF NOT EXISTS llm_calls (
  call_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_number INTEGER DEFAULT 0,
  call_number INTEGER NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  cached_tokens INTEGER,
  cache_write_tokens INTEGER,
  output_tokens INTEGER NOT NULL,
  cost REAL DEFAULT 0,
  aic INTEGER,
  timestamp INTEGER,
  debug_name TEXT,
  status TEXT DEFAULT 'ok',
  span_id TEXT,
  ttft INTEGER,
  delta_input INTEGER,
  delta_cached INTEGER,
  is_subagent INTEGER DEFAULT 0,
  parent_span_id TEXT,
  system_prompt_file TEXT,
  tools_file TEXT,
  request_options TEXT,
  cache_break_type TEXT,
  time_since_prev INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_llm_calls_session ON llm_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_llm_calls_model ON llm_calls(model);

-- Tool calls table: one row per tool_call event
CREATE TABLE IF NOT EXISTS tool_calls (
  tool_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_number INTEGER DEFAULT 0,
  tool_name TEXT NOT NULL,
  args_preview TEXT,
  result_size INTEGER DEFAULT 0,
  status TEXT DEFAULT 'ok',
  linked_llm_call_id INTEGER,
  timestamp INTEGER,
  dur INTEGER,
  parent_span_id TEXT,
  compression_method TEXT, -- 'outputDeltas' | 'compressOutput' | NULL
  args_full TEXT, -- full args JSON
  result_text TEXT, -- full result text
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_calls_turn ON tool_calls(session_id, turn_number);

-- Model switches table: one row per model change within a session
CREATE TABLE IF NOT EXISTS model_switches (
  switch_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  from_model TEXT NOT NULL,
  to_model TEXT NOT NULL,
  at_call_number INTEGER NOT NULL,
  cache_before INTEGER,
  cache_after INTEGER,
  input_delta INTEGER,
  timestamp INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_model_switches_session ON model_switches(session_id);

-- Sync log table: tracks when each session folder was last scanned
CREATE TABLE IF NOT EXISTS sync_log (
  session_id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  main_jsonl_mtime INTEGER,
  total_lines INTEGER,
  file_size INTEGER,
  parser_version INTEGER DEFAULT 1,
  synced_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Additional session indexes
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_start_time ON sessions(start_time);
CREATE INDEX IF NOT EXISTS idx_llm_calls_turn ON llm_calls(session_id, turn_number);

-- Model catalog: metadata from models.json (vendor, capabilities, pricing tiers)
CREATE TABLE IF NOT EXISTS model_catalog (
  model_id TEXT PRIMARY KEY,
  display_name TEXT,
  vendor TEXT,
  family TEXT,
  category TEXT, -- 'powerful' | 'versatile' | etc.
  price_category TEXT, -- 'high' | 'medium' | 'low'
  is_preview INTEGER DEFAULT 0,
  supports_vision INTEGER DEFAULT 0,
  supports_tool_calls INTEGER DEFAULT 0,
  supports_thinking INTEGER DEFAULT 0,
  max_context_tokens INTEGER,
  max_output_tokens INTEGER,
  input_price_per_mtok INTEGER, -- per million tokens (batch_size units from models.json)
  output_price_per_mtok INTEGER,
  cache_price_per_mtok INTEGER,
  capabilities_json TEXT, -- full capabilities object as JSON
  updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Agent responses: response text and reasoning for conversation review
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
CREATE INDEX IF NOT EXISTS idx_agent_responses_session ON agent_responses(session_id);

-- Discovery events: agents, instructions, skills, hooks loaded per session
CREATE TABLE IF NOT EXISTS discovery_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL, -- 'Agent Discovery' | 'Instructions Discovery' | 'Skill Discovery' | etc.
  event_name TEXT,
  details TEXT,
  timestamp INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_discovery_events_session ON discovery_events(session_id);

-- Transcripts: full conversation replay from transcripts/*.jsonl
CREATE TABLE IF NOT EXISTS transcripts (
  transcript_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL, -- 'session.start' | 'assistant.message' | 'tool.execution_start' | etc.
  event_data TEXT, -- full event JSON
  event_uuid TEXT, -- unique event ID from transcript
  parent_uuid TEXT,
  timestamp INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_transcripts_session ON transcripts(session_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_type ON transcripts(event_type);
