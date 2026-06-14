/**
 * @fileoverview Session API layer — transforms raw DB rows into structured,
 * turn-grouped data for the UI. Keeps the webview as a pure display layer.
 */

const path = require('path');
const { classifySessionCalls, turnLevelClass } = require('./compute/aicClassifier');

/**
 * Build a turn-grouped session detail from raw DB rows.
 * @param {Object} db — Database instance
 * @param {string} sessionId
 * @returns {{
 *   session: Object|null,
 *   turns: Array<{
 *     turnNumber: number,
 *     userMessages: Array<{content: string, ts: string|null}>,
 *     toolCalls: Array<Object>,
 *     llmCalls: Array<Object>,
 *     aic: number,
 *     aicClass: string,
 *     aicBadge: string,
 *     toolNames: string
 *   }>,
 *   llmCalls: Array<Object>,
 *   toolCalls: Array<Object>,
 *   userMessages: Array<Object>,
 *   modelSwitches: Array<Object>
 * }}
 */
function getSessionDetail(db, sessionId) {
  try {
    const session = db.queryOne(
      'SELECT * FROM sessions WHERE session_id = $sid',
      { $sid: sessionId }
    );

    const llmCalls = db.query(
      'SELECT * FROM llm_calls WHERE session_id = $sid ORDER BY call_number',
      { $sid: sessionId }
    );

    const toolCalls = db.query(
      'SELECT * FROM tool_calls WHERE session_id = $sid ORDER BY tool_id',
      { $sid: sessionId }
    );

    const userMessages = db.query(
      'SELECT * FROM user_messages WHERE session_id = $sid ORDER BY msg_id',
      { $sid: sessionId }
    );

    const modelSwitches = getModelSwitches(db, sessionId);
    const toolLeaderboard = getToolLeaderboard(db, sessionId);

    // Group by turn (pass session for estimated AIC distribution)
    // buildTurns mutates llmCalls to add aicClass and estimated AIC (is_aic_approx)
    const turns = buildTurns(llmCalls, toolCalls, userMessages, session);

    return {
      session: session || null,
      turns,
      llmCalls,
      toolCalls,
      userMessages,
      modelSwitches,
      toolLeaderboard
    };
  } catch (err) {
    console.error('[sessionApi] getSessionDetail failed:', err.message);
    return { session: null, turns: [], llmCalls: [], toolCalls: [], userMessages: [], modelSwitches: [], toolLeaderboard: [] };
  }
}

/**
 * Group raw flat arrays into turns and compute per-turn metrics.
 * @param {Array} llmCalls
 * @param {Array} toolCalls
 * @param {Array} userMessages
 * @param {Object|null} session - Session row with is_aic_approx, computed_aic
 */
function buildTurns(llmCalls, toolCalls, userMessages, session) {
  const byTurn = new Map();

  // Collect LLM calls by turn
  for (const call of llmCalls) {
    const tn = call.turn_number || 0;
    if (!byTurn.has(tn)) byTurn.set(tn, { llmCalls: [], toolCalls: [], userMessages: [] });
    byTurn.get(tn).llmCalls.push(call);
  }

  // Collect tool calls by turn
  for (const tool of toolCalls) {
    const tn = tool.turn_number || 0;
    if (!byTurn.has(tn)) byTurn.set(tn, { llmCalls: [], toolCalls: [], userMessages: [] });
    byTurn.get(tn).toolCalls.push(tool);
  }

  // Collect user messages by turn
  for (const msg of userMessages) {
    const tn = msg.turn_number || 0;
    if (!byTurn.has(tn)) byTurn.set(tn, { llmCalls: [], toolCalls: [], userMessages: [] });
    byTurn.get(tn).userMessages.push(msg);
  }

  // --- Estimated AIC distribution ---
  // When session has no actual AIC data, distribute the session-level estimated AIC
  // proportionally across calls based on (input_tokens + output_tokens).
  const isAicApprox = session && session.is_aic_approx === 1;
  if (isAicApprox && session.computed_aic > 0) {
    const totalTokens = llmCalls.reduce((s, c) => s + (c.input_tokens || 0) + (c.output_tokens || 0), 0);
    if (totalTokens > 0) {
      for (const call of llmCalls) {
        const callTokens = (call.input_tokens || 0) + (call.output_tokens || 0);
        call.aic = Math.round(session.computed_aic * callTokens / totalTokens);
        call.is_aic_approx = true;
      }
    }
  }

  // --- AIC classification using centralized classifier ---
  const classificationMap = classifySessionCalls(llmCalls);

  // Build turn objects sorted by turn number
  const sortedTurns = [...byTurn.entries()].sort((a, b) => a[0] - b[0]);
  const turns = [];

  for (const [turnNum, data] of sortedTurns) {
    const turnAic = data.llmCalls.reduce((s, c) => s + (c.aic || 0), 0);
    const aicValue = turnAic > 0 ? (turnAic / 1e9).toFixed(2) : '';
    const toolNames = data.toolCalls.map(t => t.tool_name).join(', ');

    // Per-call AIC classification from centralized classifier
    const callsWithClass = data.llmCalls.map(c => {
      const aicClass = classificationMap.get(c.call_number) || 'none';
      c.aicClass = aicClass; // mutate original for store.llmCalls
      return { ...c, aicClass };
    });

    // Turn-level class = highest class among its calls
    const turnAicClass = turnLevelClass(callsWithClass.map(c => c.aicClass));

    // Cold start = no cache benefit on any call in this turn (cached_tokens === 0 or null)
    const isColdStart = data.llmCalls.length > 0 && data.llmCalls.every(c => c.cached_tokens === null || c.cached_tokens === 0);

    // Canceled = user edited/resent this message (detected from chatSessions cross-reference)
    const isCanceled = data.userMessages.some(m => m.is_canceled === 1);

    // Build unified chronological events within this turn
    const events = [];
    for (const msg of data.userMessages) {
      events.push({ type: 'userMessage', content: msg.content || '', ts: msg.timestamp || null, _order: 0 });
    }
    for (const tool of data.toolCalls) {
      events.push({
        type: 'toolCall',
        toolName: tool.tool_name,
        argsPreview: tool.args_preview,
        resultSize: tool.result_size,
        status: tool.status,
        compressionMethod: tool.compression_method,
        linkedLlmCallId: tool.linked_llm_call_id,
        ts: tool.timestamp || null,
        _order: 1
      });
    }
    for (const call of callsWithClass) {
      events.push({
        type: 'llmCall',
        ...call,
        ts: call.timestamp || null,
        _order: 2
      });
    }
    events.sort((a, b) => {
      if (a.ts !== null && b.ts !== null) return a.ts - b.ts;
      if (a.ts === null && b.ts !== null) return 1;
      if (a.ts !== null && b.ts === null) return -1;
      return a._order - b._order;
    });

    turns.push({
      turnNumber: turnNum,
      isColdStart,
      isCanceled,
      events,
      userMessages: data.userMessages.map(m => ({
        content: m.content || '',
        ts: m.timestamp || null
      })),
      toolCalls: data.toolCalls,
      llmCalls: callsWithClass,
      aic: turnAic,
      aicClass: turnAicClass,
      aicBadge: aicValue,
      toolNames
    });
  }

  return turns;
}

/**
 * Get list of all sessions.
 */
function getSessions(db) {
  try {
    return db.query(`
      SELECT
        s.session_id, s.workspace_hash, s.workspace_path, s.title, s.start_time, s.end_time,
        s.models_used_json, s.total_llm_calls, s.total_input_tokens,
        s.total_output_tokens, s.total_cached_tokens, s.total_cache_write_tokens, s.total_cost, s.total_aic,
        s.computed_aic, s.computed_cost, s.is_aic_approx, s.cache_hit_pct,
        s.subagent_counts_json,
        s.data_quality, s.source_type, s.has_model_switch, s.has_subagent, s.source_path,
        COALESCE((SELECT COUNT(*) FROM llm_calls lc WHERE lc.session_id = s.session_id AND lc.debug_name LIKE '%retry%'), 0) AS retry_count
      FROM sessions s
      ORDER BY s.start_time DESC
    `);
  } catch (err) {
    console.error('[sessionApi] getSessions failed:', err.message);
    return [];
  }
}

/**
 * Get dashboard data.
 */
function getDashboard(db) {
  try {
  const dailyCost = db.query(`
    SELECT
      date(start_time, 'unixepoch') as day,
      COUNT(*) as sessions,
      SUM(total_llm_calls) as calls,
      SUM(computed_cost) as cost,
      SUM(computed_aic) as aic
    FROM sessions
    WHERE start_time IS NOT NULL
    GROUP BY day
    ORDER BY day DESC
    LIMIT 30
  `);

  const toolsBySession = db.query(`
    SELECT session_id, tool_name, COUNT(*) as calls, SUM(result_size) as total_size
    FROM tool_calls
    GROUP BY session_id, tool_name
    ORDER BY session_id, calls DESC
  `);

  const modelsBySession = db.query(`
    SELECT
      session_id, model,
      COUNT(*) as calls,
      SUM(cost) as cost,
      SUM(aic) as aic,
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens,
      SUM(cached_tokens) as cached_tokens
    FROM llm_calls
    GROUP BY session_id, model
    ORDER BY session_id, aic DESC
  `);

  // Enrich model data with vendor from model_catalog (falls back to string matching)
  const catalogMap = new Map();
  try {
    const catalog = db.query('SELECT model_id, vendor, display_name FROM model_catalog');
    for (const entry of catalog) {
      catalogMap.set(entry.model_id, entry);
    }
  } catch { /* model_catalog may not exist in older DBs */ }

  for (const m of modelsBySession || []) {
    const catalogEntry = catalogMap.get(m.model);
    if (catalogEntry && catalogEntry.vendor) {
      m.vendor = catalogEntry.vendor;
      m.display_name = catalogEntry.display_name || m.model;
    } else {
      // Fallback: string matching for sessions without models.json
      const name = (m.model || '').toLowerCase();
      if (name.includes('claude')) m.vendor = 'Anthropic';
      else if (name.includes('gpt')) m.vendor = 'OpenAI';
      else if (name.includes('gemini')) m.vendor = 'Google';
      else m.vendor = '';
    }
  }

  return { dailyCost: dailyCost || [], toolsBySession: toolsBySession || [], modelsBySession: modelsBySession || [] };
  } catch (err) {
    console.error('[sessionApi] getDashboard failed:', err.message);
    return { dailyCost: [], toolsBySession: [], modelsBySession: [] };
  }
}

/**
 * Get tool leaderboard for a session.
 */
function getToolLeaderboard(db, sessionId) {
  try {
    return db.query(`
      SELECT
        tool_name,
        COUNT(*) as calls,
        SUM(result_size) as total_result_size,
        AVG(result_size) as avg_result_size,
        MAX(result_size) as max_result_size,
        SUM(CASE WHEN compression_method IS NOT NULL THEN 1 ELSE 0 END) as compression_count
      FROM tool_calls
      WHERE session_id = $sid
      GROUP BY tool_name
      ORDER BY total_result_size DESC
    `, { $sid: sessionId });
  } catch (err) {
    console.error('[sessionApi] getToolLeaderboard failed:', err.message);
    return [];
  }
}

/**
 * Get model switches for a session.
 */
function getModelSwitches(db, sessionId) {
  try {
    return db.query(
      'SELECT * FROM model_switches WHERE session_id = $sid ORDER BY at_call_number',
      { $sid: sessionId }
    );
  } catch (err) {
    console.error('[sessionApi] getModelSwitches failed:', err.message);
    return [];
  }
}

/**
 * Get all models from the model catalog with capabilities.
 * @param {Object} db
 * @returns {Array<import('./parser/types').ModelCatalogEntry>}
 */
function getModelCatalog(db) {
  try {
    return db.query(`
      SELECT
        model_id, display_name, vendor, family, category, price_category,
        is_preview, supports_vision, supports_tool_calls, supports_thinking,
        max_context_tokens, max_output_tokens,
        input_price_per_mtok, output_price_per_mtok, cache_price_per_mtok,
        capabilities_json, updated_at
      FROM model_catalog
      ORDER BY vendor, display_name
    `);
  } catch (err) {
    console.error('[sessionApi] getModelCatalog failed:', err.message);
    return [];
  }
}

/**
 * Get agent responses for a session (conversation review).
 * @param {Object} db
 * @param {string} sessionId
 * @returns {Array<import('./parser/types').AgentResponse>}
 */
function getAgentResponses(db, sessionId) {
  try {
    const rows = db.query(
      'SELECT * FROM agent_responses WHERE session_id = $sid ORDER BY turn_number, timestamp',
      { $sid: sessionId }
    );
    return rows.map(r => ({
      ...r,
      response_text: extractTextFromParts(r.response_text),
      reasoning_text: extractTextFromParts(r.reasoning_text)
    }));
  } catch (err) {
    console.error('[sessionApi] getAgentResponses failed:', err.message);
    return [];
  }
}

/**
 * Parse agent response JSON parts structure, extracting only text content.
 * Handles format: [{ role, parts: [{ type: 'text', content }, { type: 'tool_call', ... }] }]
 */
function extractTextFromParts(raw) {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .flatMap(msg => (msg.parts || [])
          .filter(p => p.type === 'text' && p.content)
          .map(p => p.content))
        .join('\n\n');
    }
  } catch { /* not JSON — return as-is */ }
  return raw;
}

/**
 * Get discovery events for a session (agents, skills, instructions loaded).
 * @param {Object} db
 * @param {string} sessionId
 * @returns {Array<import('./parser/types').DiscoveryEvent>}
 */
function getDiscoveryEvents(db, sessionId) {
  try {
    return db.query(
      'SELECT * FROM discovery_events WHERE session_id = $sid ORDER BY timestamp',
      { $sid: sessionId }
    );
  } catch (err) {
    console.error('[sessionApi] getDiscoveryEvents failed:', err.message);
    return [];
  }
}

/**
 * Get transcript events for a session (conversation replay).
 * @param {Object} db
 * @param {string} sessionId
 * @returns {Array<import('./parser/types').TranscriptEvent>}
 */
function getTranscripts(db, sessionId) {
  try {
    return db.query(
      'SELECT * FROM transcripts WHERE session_id = $sid ORDER BY timestamp, transcript_id',
      { $sid: sessionId }
    );
  } catch (err) {
    console.error('[sessionApi] getTranscripts failed:', err.message);
    return [];
  }
}

/**
 * Get conversation messages from transcripts (user + assistant) in a lightweight format.
 * @param {Object} db
 * @param {string} sessionId
 * @returns {Array<{role: string, content: string, timestamp: number|null, turnId: string|null}>}
 */
function getConversation(db, sessionId) {
  try {
    // User messages: always from user_messages table (reliable source from main.jsonl).
    // Transcripts often lack user.message events entirely.
    const userRows = db.query(
      `SELECT content, timestamp FROM user_messages
       WHERE session_id = $sid AND content IS NOT NULL AND content != ''
       ORDER BY timestamp`,
      { $sid: sessionId }
    );
    const userMsgs = userRows.map(r => ({
      role: 'user', content: r.content, timestamp: r.timestamp, turnId: null
    }));

    // Assistant messages: from transcripts (only source for assistant text).
    const asstRows = db.query(
      `SELECT event_data, timestamp FROM transcripts
       WHERE session_id = $sid AND event_type = 'assistant.message'
       ORDER BY timestamp, transcript_id`,
      { $sid: sessionId }
    );
    const asstMsgs = asstRows.map(row => {
      try {
        const evt = JSON.parse(row.event_data);
        return {
          role: 'assistant',
          content: evt.data?.content || '',
          timestamp: row.timestamp,
          turnId: evt.data?.turnId || evt.parentId || null
        };
      } catch { return null; }
    }).filter(m => m && m.content);

    // Merge chronologically
    const all = [...userMsgs, ...asstMsgs];
    all.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    // Collapse consecutive assistant messages into single entries.
    // Copilot emits many short status-update messages per user turn;
    // combine them so the conversation reads: user → one collapsed assistant block → user → ...
    const collapsed = [];
    let pendingAssistant = [];
    for (const m of all) {
      if (m.role === 'user') {
        if (pendingAssistant.length) {
          collapsed.push({
            role: 'assistant',
            content: pendingAssistant.map(a => a.content).join('\n\n'),
            timestamp: pendingAssistant[0].timestamp,
            turnId: pendingAssistant[0].turnId
          });
          pendingAssistant = [];
        }
        collapsed.push(m);
      } else {
        pendingAssistant.push(m);
      }
    }
    if (pendingAssistant.length) {
      collapsed.push({
        role: 'assistant',
        content: pendingAssistant.map(a => a.content).join('\n\n'),
        timestamp: pendingAssistant[0].timestamp,
        turnId: pendingAssistant[0].turnId
      });
    }
    return collapsed;
  } catch (err) {
    console.error('[sessionApi] getConversation failed:', err.message);
    return [];
  }
}

/**
 * Export session data in the requested format.
 * @param {Object} db
 * @param {string} sessionId
 * @param {Object} [options]
 * @param {'json'|'csv'|'markdown'} [options.format='json']
 * @param {boolean} [options.includeTurns=true]
 * @param {boolean} [options.includeToolCalls=true]
 * @param {boolean} [options.includeLlmCalls=true]
 * @param {boolean} [options.includeAgentResponses=false]
 * @returns {{ data: string, mimeType: string, filename: string }}
 */
function exportSession(db, sessionId, options = {}) {
  const format = options.format || 'json';
  const includeTurns = options.includeTurns !== false;
  const includeToolCalls = options.includeToolCalls !== false;
  const includeLlmCalls = options.includeLlmCalls !== false;
  const includeAgentResponses = options.includeAgentResponses === true;

  const detail = getSessionDetail(db, sessionId);
  const payload = { session: detail.session };

  if (includeTurns) payload.turns = detail.turns;
  if (includeToolCalls) payload.toolCalls = detail.toolCalls;
  if (includeLlmCalls) payload.llmCalls = detail.llmCalls;
  if (includeAgentResponses) payload.agentResponses = getAgentResponses(db, sessionId);

  const shortId = (sessionId || 'unknown').slice(0, 8);

  switch (format) {
    case 'csv': {
      // CSV-escape: wrap fields containing comma/quote/newline in double quotes
      const esc = (v) => {
        const s = v === null || v === undefined ? '' : String(v);
        return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const rows = (detail.llmCalls || []).map(c => [
        esc(c.session_id), esc(c.turn_number), esc(c.call_number), esc(c.model),
        esc(c.input_tokens), esc(c.cached_tokens), esc(c.output_tokens),
        esc(c.cost), esc(c.aic), esc(c.status)
      ]);
      const header = 'session_id,turn,call,model,input_tokens,cached_tokens,output_tokens,cost,aic,status';
      const csv = [header, ...rows.map(r => r.join(','))].join('\n');
      return { data: csv, mimeType: 'text/csv', filename: `session-${shortId}.csv` };
    }
    case 'markdown': {
      const lines = [`# Session ${shortId}`, ''];
      if (detail.session) {
        lines.push(`**Title:** ${detail.session.title || '(none)'}`);
        lines.push(`**Models:** ${detail.session.models_used_json || '[]'}`);
        lines.push(`**LLM Calls:** ${detail.session.total_llm_calls}`);
        lines.push('');
      }
      if (includeTurns) {
        lines.push('## Turns', '');
        for (const turn of detail.turns) {
          lines.push(`### Turn ${turn.turnNumber}`);
          lines.push(`- LLM calls: ${turn.llmCalls.length}`);
          lines.push(`- Tool calls: ${turn.toolCalls.length}`);
          lines.push(`- AIC: ${turn.aicBadge || '—'}`);
          lines.push('');
        }
      }
      return { data: lines.join('\n'), mimeType: 'text/markdown', filename: `session-${shortId}.md` };
    }
    default: {
      return { data: JSON.stringify(payload, null, 2), mimeType: 'application/json', filename: `session-${shortId}.json` };
    }
  }
}

/**
 * Get cache break summary for a session.
 * @param {Object} db
 * @param {string} sessionId
 * @returns {{ total: number, byType: Object<string, number>, breaks: Array }}
 */
function getCacheBreakSummary(db, sessionId) {
  try {
    const breaks = db.query(`
      SELECT call_number, turn_number, model, cached_tokens, delta_cached,
             cache_break_type, system_prompt_file, tools_file, is_subagent, input_tokens, delta_input, time_since_prev
      FROM llm_calls
      WHERE session_id = $sid AND cache_break_type IS NOT NULL
      ORDER BY call_number
    `, { $sid: sessionId });

    const byType = {};
    for (const b of breaks) {
      byType[b.cache_break_type] = (byType[b.cache_break_type] || 0) + 1;
    }

    return { total: breaks.length, byType, breaks };
  } catch (err) {
    console.error('[sessionApi] getCacheBreakSummary failed:', err.message);
    return { total: 0, byType: {}, breaks: [] };
  }
}

module.exports = {
  getSessionDetail,
  getSessions,
  getDashboard,
  getToolLeaderboard,
  getModelSwitches,
  getModelCatalog,
  getAgentResponses,
  getDiscoveryEvents,
  getTranscripts,
  getConversation,
  exportSession,
  getCacheBreakSummary
};
