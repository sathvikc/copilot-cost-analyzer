/**
 * @fileoverview Sync engine: scan debug logs, parse, compute costs, persist to SQLite.
 *
 * This is the bridge between raw VS Code workspaceStorage and the extension's
 * persistent database. Called on startup and on manual refresh.
 */

const fs = require('fs');
const path = require('path');
const { parseSessionDirectory } = require('../api/parser/mainJsonlParser');
const { parseChatSessionFile } = require('../api/parser/chatSessionParser');
const { loadPricing, computeCallCost } = require('../api/compute/costComputer');
const { computeGlobalAicRatio, computeSessionMetrics } = require('../api/compute/sessionMetrics');
const { getWorkspaceStoragePaths, findWorkspaceFile } = require('../utils/paths');
const { createLogger } = require('../utils/logger');

const log = createLogger('sync');

/**
 * Resolve the real on-disk workspace path from a workspace storage dir's
 * workspace.json (handles file:// URLs and percent-encoded Windows drives).
 * @param {string} wsDir - <basePath>/<workspaceHash>
 * @returns {string|null}
 */
function resolveWorkspacePath(wsDir) {
  const wsJsonPath = path.join(wsDir, 'workspace.json');
  if (!fs.existsSync(wsJsonPath)) return null;
  try {
    const wsData = JSON.parse(fs.readFileSync(wsJsonPath, 'utf-8'));
    const raw = wsData.workspace || wsData.folder || '';
    if (!raw) return null;
    try {
      // Use URL API to correctly decode percent-encoded paths (e.g. c%3A → c: on Windows)
      const pathname = new URL(raw).pathname;
      // Strip leading slash before Windows drive letters: /C:/Users → C:/Users
      return pathname.replace(/^\/([A-Za-z]:)/, '$1') || null;
    } catch {
      return raw.replace(/^file:\/\/\//, '/') || null;
    }
  } catch {
    return null;
  }
}

/**
 * Discover all Copilot Chat sessions across all workspace storages.
 *
 * Two sources, in priority order:
 *   1. debug-logs/<id>/main.jsonl — full data (tokens, AIC, cache). `source: 'debug-logs'`.
 *   2. chatSessions/<id>.jsonl    — always-written fallback (estimated; no cache/AIC).
 *      `source: 'chatSessions'`. Only emitted for sessions NOT already covered by
 *      debug-logs (full data always wins).
 *
 * @param {string[]} [basePaths] - workspace storage roots (defaults to the live
 *   VS Code locations; injectable for tests).
 * @returns {Array<{
 *   sessionId: string,
 *   workspaceHash: string,
 *   workspacePath: string|null,
 *   source: 'debug-logs'|'chatSessions',
 *   debugLogPath?: string,
 *   mainJsonlMtime?: number,
 *   chatSessionPath?: string,
 *   chatSessionMtime?: number
 * }>}
 */
function discoverSessions(basePaths) {
  // Scan ALL valid VS Code workspace storage paths (Stable + Insiders)
  if (basePaths === undefined) basePaths = getWorkspaceStoragePaths();

  if (basePaths.length === 0) {
    return [];
  }

  const sessions = [];
  const debugLogIds = new Set();   // sessions with full data — chatSessions must defer to these
  const chatSessionIds = new Set(); // guard against the same id in multiple workspaces

  // Pass 1: debug-logs (full data). Collected first so chatSessions can dedupe.
  for (const basePath of basePaths) {
    for (const wsHash of listDirs(basePath)) {
      const wsDir = path.join(basePath, wsHash);
      const debugLogsDir = path.join(wsDir, 'GitHub.copilot-chat', 'debug-logs');
      if (!fs.existsSync(debugLogsDir)) continue;

      const workspacePath = resolveWorkspacePath(wsDir);
      for (const sessionId of listDirs(debugLogsDir)) {
        const sessionPath = path.join(debugLogsDir, sessionId);
        const mainJsonlPath = path.join(sessionPath, 'main.jsonl');
        if (!fs.existsSync(mainJsonlPath)) continue;

        const mtime = fs.statSync(mainJsonlPath).mtimeMs;
        sessions.push({
          sessionId,
          workspaceHash: wsHash,
          workspacePath,
          source: 'debug-logs',
          debugLogPath: sessionPath,
          mainJsonlMtime: Math.floor(mtime)
        });
        debugLogIds.add(sessionId);
      }
    }
  }

  // Pass 2: chatSessions (estimated fallback) for sessions without debug-logs.
  for (const basePath of basePaths) {
    for (const wsHash of listDirs(basePath)) {
      const wsDir = path.join(basePath, wsHash);
      const chatSessionsDir = path.join(wsDir, 'chatSessions');
      if (!fs.existsSync(chatSessionsDir)) continue;

      let workspacePath; // resolve lazily — only when this workspace yields a session
      const files = fs.readdirSync(chatSessionsDir, { withFileTypes: true })
        .filter(d => d.isFile() && d.name.endsWith('.jsonl'))
        .map(d => d.name);

      for (const file of files) {
        const sessionId = file.slice(0, -('.jsonl'.length));
        if (debugLogIds.has(sessionId) || chatSessionIds.has(sessionId)) continue;

        const chatSessionPath = path.join(chatSessionsDir, file);
        const mtime = fs.statSync(chatSessionPath).mtimeMs;
        if (workspacePath === undefined) workspacePath = resolveWorkspacePath(wsDir);
        sessions.push({
          sessionId,
          workspaceHash: wsHash,
          workspacePath,
          source: 'chatSessions',
          chatSessionPath,
          chatSessionMtime: Math.floor(mtime)
        });
        chatSessionIds.add(sessionId);
      }
    }
  }

  return sessions;
}

/** List immediate subdirectory names of a dir (empty array if unreadable). */
function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }
}

/**
 * Find the chatSessions JSONL file for a session (cross-platform).
 */
function findChatSessionFile(workspaceHash, sessionId) {
  return findWorkspaceFile(workspaceHash, 'chatSessions', sessionId + '.jsonl');
}

/**
 * Parse chatSessions JSONL file ONCE and extract all needed data.
 * @param {string} sessionId
 * @param {string} workspaceHash
 * @returns {{ title: string|null, canceledTurns: Set<number>, mode: string|null, initialLocation: string|null }}
 */
function parseChatSession(sessionId, workspaceHash) {
  const result = { title: null, canceledTurns: new Set(), mode: null, initialLocation: null };
  
  const chatPath = findChatSessionFile(workspaceHash, sessionId);
  if (!chatPath || !fs.existsSync(chatPath)) return result;
  
  try {
    const lines = fs.readFileSync(chatPath, 'utf8').split('\n');
    const canceledIndices = new Set();
    let maxRequestIndex = -1;
    
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        
        if (obj.kind === 0 && obj.v) {
          // Initial snapshot — extract title, mode, location
          if (!result.title && typeof obj.v.customTitle === 'string' && obj.v.customTitle) {
            result.title = obj.v.customTitle;
          }
          if (!result.initialLocation) {
            result.initialLocation = obj.v.initialLocation || null;
          }
          const reqs = obj.v.requests;
          if (!result.mode && Array.isArray(reqs) && reqs.length > 0) {
            const modeInfo = reqs[0].modeInfo;
            result.mode = modeInfo?.modeId || modeInfo?.kind || null;
          }
        } else if (obj.kind === 1) {
          const k = obj.k;
          // Title update
          if (Array.isArray(k) && k.length === 1 && k[0] === 'customTitle'
              && typeof obj.v === 'string' && obj.v) {
            result.title = obj.v;
          }
          // Cancel detection
          if (Array.isArray(k) && k.length >= 2 && k[0] === 'requests' && typeof k[1] === 'number') {
            if (k[1] > maxRequestIndex) maxRequestIndex = k[1];
          }
          if (Array.isArray(k) && k.length === 3 && k[0] === 'requests' && typeof k[1] === 'number' && k[2] === 'result') {
            const v = obj.v;
            if (v && typeof v === 'object' && v.errorDetails && v.errorDetails.code === 'canceled') {
              canceledIndices.add(k[1]);
            }
          }
        }
      } catch { /* malformed line */ }
    }
    
    // Determine edited/hidden turns
    for (const idx of canceledIndices) {
      const nextIdx = idx + 1;
      if (nextIdx <= maxRequestIndex && !canceledIndices.has(nextIdx)) {
        result.canceledTurns.add(idx);
      }
    }
  } catch { /* unreadable */ }
  
  return result;
}

/**
 * Sync a single session. Dispatches by source:
 *   - 'chatSessions' → estimated fallback (no cache/AIC) via syncChatSession.
 *   - anything else  → full debug-logs path via syncDebugLogSession.
 * @param {Object} db - Database instance
 * @param {Object} sessionInfo - From discoverSessions()
 * @param {number} [globalAicRatio] - Pre-computed AIC-per-token ratio for estimating missing AIC
 * @returns {Promise<boolean>} true if synced, false if skipped (up to date)
 */
const PARSER_VERSION = 30; // bump when debug-logs parser logic changes to force re-sync
const CHAT_PARSER_VERSION = 1; // bump when chatSessions parser logic changes to force re-sync

async function syncSession(db, sessionInfo, globalAicRatio) {
  if (globalAicRatio === undefined) globalAicRatio = 0;
  if (sessionInfo.source === 'chatSessions') {
    return syncChatSession(db, sessionInfo, globalAicRatio);
  }
  return syncDebugLogSession(db, sessionInfo, globalAicRatio);
}

/**
 * Sync a single debug-logs session: parse main.jsonl, compute costs, insert into DB.
 * @param {Object} db - Database instance
 * @param {Object} sessionInfo - From discoverSessions() with source 'debug-logs'
 * @param {number} globalAicRatio - Pre-computed AIC-per-token ratio for estimating missing AIC
 * @returns {Promise<boolean>} true if synced, false if skipped (up to date)
 */
async function syncDebugLogSession(db, sessionInfo, globalAicRatio) {
  const { sessionId, workspaceHash, workspacePath, debugLogPath, mainJsonlMtime } = sessionInfo;

  // Get current file size for incremental sync tracking
  const mainJsonlPath = path.join(debugLogPath, 'main.jsonl');
  const currentFileSize = fs.existsSync(mainJsonlPath) ? fs.statSync(mainJsonlPath).size : 0;

  // Check sync log: skip if mtime hasn't changed, file_size hasn't changed, AND parser version matches
  const existing = db.queryOne(
    'SELECT main_jsonl_mtime, file_size, parser_version FROM sync_log WHERE session_id = $sid',
    { $sid: sessionId }
  );

  if (existing && existing.main_jsonl_mtime >= mainJsonlMtime && existing.file_size === currentFileSize && existing.parser_version === PARSER_VERSION) {
    return false; // up to date
  }

  // Parse the session
  const parsed = await parseSessionDirectory(debugLogPath, sessionId);

  if (parsed.llmCalls.length === 0) {
    return false; // nothing to sync
  }

  // Parse chatSessions JSONL once for title, canceled turns, mode, location
  const chatData = parseChatSession(sessionId, workspaceHash);
  
  let sessionTitle = parsed.title;
  if (!sessionTitle) sessionTitle = chatData.title;
  if (sessionTitle) {
    log.log(`Session ${sessionId.slice(0, 8)} title: "${sessionTitle.slice(0, 40)}..."`);
  }

  const canceledTurns = chatData.canceledTurns;

  // Load pricing
  const pricingPath = path.join(debugLogPath, 'models.json');
  const pricingMap = loadPricing(pricingPath);

  // Compute costs for each call
  let totalCost = 0;
  let totalAic = null;
  const modelsUsed = new Set();

  for (const call of parsed.llmCalls) {
    call.cost = computeCallCost(call, pricingMap);
    totalCost += call.cost;
    modelsUsed.add(call.model);

    if (call.aic !== null && call.aic !== undefined) {
      totalAic = (totalAic || 0) + call.aic;
    }
  }

  // totalCost stays as pure token pricing (from computeCallCost).
  // AIC-based cost is stored separately via computeSessionMetrics → computed_cost.
  // The API layer decides which to display.

  // Compute derived metrics using shared module
  const totalInputTokens = parsed.llmCalls.reduce((s, c) => s + c.inputTokens, 0);
  const totalOutputTokens = parsed.llmCalls.reduce((s, c) => s + c.outputTokens, 0);
  const totalCachedTokens = parsed.llmCalls.some(c => c.cachedTokens !== null)
    ? parsed.llmCalls.reduce((s, c) => s + (c.cachedTokens || 0), 0)
    : null;

  const rawSession = {
    total_aic: totalAic,
    total_input_tokens: totalInputTokens,
    total_output_tokens: totalOutputTokens,
    total_cached_tokens: totalCachedTokens
  };
  const metrics = computeSessionMetrics(rawSession, globalAicRatio, totalCost);

  // Determine data quality — based only on whether cache data is present
  const hasCacheData = parsed.llmCalls.some(c => c.cachedTokens !== null);
  const dataQuality = hasCacheData ? 'full' : 'limited';

  // Wrap all writes in a transaction for atomicity
  db.transaction(() => {
    deleteSessionRows(db, sessionId);

    insertSessionRow(db, {
      $sid: sessionId,
      $wh: workspaceHash,
      $wp: workspacePath,
      $title: sessionTitle || parsed.userMessages[0]?.content || null,
      $st: parsed.firstTs,
      $et: parsed.lastTs,
      $models: JSON.stringify([...modelsUsed]),
      $calls: parsed.llmCalls.length,
      $input: totalInputTokens,
      $output: totalOutputTokens,
      $cached: totalCachedTokens,
      $cacheWrite: parsed.llmCalls.some(c => c.cacheWriteTokens !== null)
        ? parsed.llmCalls.reduce((s, c) => s + (c.cacheWriteTokens || 0), 0)
        : null,
      $cost: totalCost,
      $aic: totalAic,
      $compAic: Math.round(metrics.computedAic),
      $compCost: metrics.computedCost,
      $isApprox: metrics.isAicApprox ? 1 : 0,
      $cacheHit: metrics.cacheHitPct,
      $subagentCounts: parsed.subagentCounts && Object.keys(parsed.subagentCounts).length > 0
        ? JSON.stringify(parsed.subagentCounts)
        : null,
      $quality: dataQuality,
      $hasSwitch: parsed.modelSwitches.length > 0 ? 1 : 0,
      $hasSub: parsed.hasSubagent ? 1 : 0,
      $src: debugLogPath,
      $srcType: 'debug-logs',
      $prompt: parsed.userMessages[0]?.content || null,
      $copilotVer: parsed.sessionMeta?.copilotVersion || null,
      $vscodeVer: parsed.sessionMeta?.vscodeVersion || null,
      $mode: chatData.mode,
      $location: chatData.initialLocation
    });

    insertLlmCalls(db, parsed.llmCalls);
    insertToolCalls(db, parsed.toolCalls);
    insertModelSwitches(db, parsed.modelSwitches);
    insertUserMessages(db, sessionId, parsed.userMessages, canceledTurns);
    insertAgentResponses(db, sessionId, parsed.agentResponses || []);
    insertDiscoveryEvents(db, sessionId, parsed.discoveryEvents || []);

    // Sync model catalog from models.json + full transcript replay
    syncModelCatalog(db, pricingPath);
    syncTranscripts(db, sessionId, workspaceHash);

    upsertSyncLog(db, {
      sessionId,
      sourcePath: debugLogPath,
      mtime: mainJsonlMtime,
      totalLines: parsed.totalLines,
      fileSize: currentFileSize,
      parserVersion: PARSER_VERSION
    });
  }); // end transaction

  return true;
}

/**
 * Sync a single chatSessions-only session (estimated fallback). Copilot always
 * writes chatSessions/<id>.jsonl regardless of the agentDebugLog setting, so this
 * surfaces sessions that have no debug-logs. There is no cache split, no AIC and
 * no token pricing — cost/AIC are estimated downstream from the global ratio and
 * the row is flagged `source_type='chatSessions'`, `data_quality='limited'`.
 *
 * @param {Object} db - Database instance
 * @param {Object} sessionInfo - From discoverSessions() with source 'chatSessions'
 * @param {number} globalAicRatio - Pre-computed AIC-per-token ratio for estimating AIC
 * @returns {Promise<boolean>} true if synced, false if skipped (up to date)
 */
async function syncChatSession(db, sessionInfo, globalAicRatio) {
  const { sessionId, workspaceHash, workspacePath, chatSessionPath, chatSessionMtime } = sessionInfo;

  const currentFileSize = fs.existsSync(chatSessionPath) ? fs.statSync(chatSessionPath).size : 0;

  // sync_log is keyed on the chatSessions file mtime/size + CHAT_PARSER_VERSION.
  // (parser_version differs from debug-logs, so if debug-logs appear later the
  // mismatch forces a re-sync that upgrades the row — see T6.)
  const existing = db.queryOne(
    'SELECT main_jsonl_mtime, file_size, parser_version FROM sync_log WHERE session_id = $sid',
    { $sid: sessionId }
  );
  if (existing && existing.main_jsonl_mtime >= chatSessionMtime
      && existing.file_size === currentFileSize && existing.parser_version === CHAT_PARSER_VERSION) {
    return false; // up to date
  }

  const parsed = parseChatSessionFile(chatSessionPath, sessionId);
  if (parsed.llmCalls.length === 0) {
    return false; // nothing ran in this session yet
  }

  const modelsUsed = new Set(parsed.llmCalls.map(c => c.model));
  const totalInputTokens = parsed.llmCalls.reduce((s, c) => s + c.inputTokens, 0);
  const totalOutputTokens = parsed.llmCalls.reduce((s, c) => s + c.outputTokens, 0);

  // No AIC and no cache data → cost is purely estimated from the global ratio.
  const rawSession = {
    total_aic: null,
    total_input_tokens: totalInputTokens,
    total_output_tokens: totalOutputTokens,
    total_cached_tokens: null
  };
  const metrics = computeSessionMetrics(rawSession, globalAicRatio, 0);

  db.transaction(() => {
    deleteSessionRows(db, sessionId);

    insertSessionRow(db, {
      $sid: sessionId,
      $wh: workspaceHash,
      $wp: workspacePath,
      $title: parsed.title || parsed.firstPrompt || null,
      $st: parsed.firstTs,
      $et: parsed.lastTs,
      $models: JSON.stringify([...modelsUsed]),
      $calls: parsed.llmCalls.length,
      $input: totalInputTokens,
      $output: totalOutputTokens,
      $cached: null,       // no cache split in chatSessions
      $cacheWrite: null,
      $cost: 0,            // no token pricing alongside chatSessions
      $aic: null,          // estimated downstream
      $compAic: Math.round(metrics.computedAic),
      $compCost: metrics.computedCost,
      $isApprox: metrics.isAicApprox ? 1 : 0,
      $cacheHit: metrics.cacheHitPct,
      $subagentCounts: null,
      $quality: 'limited',
      $hasSwitch: parsed.modelSwitches.length > 0 ? 1 : 0,
      $hasSub: 0,          // sub-agents are not recorded in chatSessions
      $src: chatSessionPath,
      $srcType: 'chatSessions',
      $prompt: parsed.firstPrompt || null,
      $copilotVer: null,
      $vscodeVer: null,
      $mode: parsed.mode,
      $location: parsed.initialLocation
    });

    insertLlmCalls(db, parsed.llmCalls);
    insertToolCalls(db, parsed.toolCalls);
    insertModelSwitches(db, parsed.modelSwitches);
    // chatSessions carries no cancel cross-reference → no canceled turns.
    insertUserMessages(db, sessionId, parsed.userMessages, new Set());
    insertAgentResponses(db, sessionId, parsed.agentResponses || []);

    upsertSyncLog(db, {
      sessionId,
      sourcePath: chatSessionPath,
      mtime: chatSessionMtime,
      totalLines: parsed.totalLines,
      fileSize: currentFileSize,
      parserVersion: CHAT_PARSER_VERSION
    });
  }); // end transaction

  return true;
}

/* ------------------------------------------------------------------ *
 * Shared row writers — used by both syncDebugLogSession and
 * syncChatSession so the two paths persist through identical SQL.
 * ------------------------------------------------------------------ */

/** Delete a session and all its child rows (explicit deletes + CASCADE backup). */
function deleteSessionRows(db, sessionId) {
  db.run('DELETE FROM llm_calls WHERE session_id = $sid', { $sid: sessionId });
  db.run('DELETE FROM tool_calls WHERE session_id = $sid', { $sid: sessionId });
  db.run('DELETE FROM model_switches WHERE session_id = $sid', { $sid: sessionId });
  db.run('DELETE FROM user_messages WHERE session_id = $sid', { $sid: sessionId });
  db.run('DELETE FROM agent_responses WHERE session_id = $sid', { $sid: sessionId });
  db.run('DELETE FROM discovery_events WHERE session_id = $sid', { $sid: sessionId });
  db.run('DELETE FROM transcripts WHERE session_id = $sid', { $sid: sessionId });
  db.run('DELETE FROM sessions WHERE session_id = $sid', { $sid: sessionId });
}

/** Insert one sessions row. `fields` uses the $-prefixed bind names below. */
function insertSessionRow(db, fields) {
  db.run(`
    INSERT INTO sessions (
      session_id, workspace_hash, workspace_path, title, start_time, end_time,
      models_used_json, total_llm_calls, total_input_tokens, total_output_tokens,
      total_cached_tokens, total_cache_write_tokens, total_cost, total_aic,
      computed_aic, computed_cost, is_aic_approx, cache_hit_pct,
      subagent_counts_json,
      data_quality, has_model_switch, has_subagent, source_path, source_type, first_prompt,
      copilot_version, vscode_version, mode, initial_location
    ) VALUES (
      $sid, $wh, $wp, $title, $st, $et,
      $models, $calls, $input, $output,
      $cached, $cacheWrite, $cost, $aic,
      $compAic, $compCost, $isApprox, $cacheHit,
      $subagentCounts,
      $quality, $hasSwitch, $hasSub, $src, $srcType, $prompt,
      $copilotVer, $vscodeVer, $mode, $location
    )
  `, fields);
}

/** Insert all LLM calls for a session. */
function insertLlmCalls(db, calls) {
  for (const call of calls) {
    db.run(`
      INSERT INTO llm_calls (
        session_id, turn_number, call_number, model, input_tokens,
        cached_tokens, cache_write_tokens, output_tokens, cost, aic, timestamp, debug_name, status, span_id, ttft,
        delta_input, delta_cached, is_subagent, parent_span_id, system_prompt_file, tools_file, request_options, cache_break_type, time_since_prev
      ) VALUES (
        $sid, $turn, $num, $model, $input,
        $cached, $cacheWrite, $output, $cost, $aic, $ts, $debug, $status, $spanId, $ttft,
        $dInput, $dCached, $isSub, $parentSpanId, $sysPrompt, $toolsFile, $reqOpts, $cacheBreak, $timeSincePrev
      )
    `, {
      $sid: call.sessionId,
      $turn: call.turnNumber,
      $num: call.callNumber,
      $model: call.model,
      $input: call.inputTokens,
      $cached: call.cachedTokens,
      $cacheWrite: call.cacheWriteTokens,
      $output: call.outputTokens,
      $cost: call.cost,
      $aic: call.aic,
      $ts: call.timestamp,
      $debug: call.debugName || null,
      $status: call.status || 'ok',
      $spanId: call.spanId || null,
      $ttft: call.ttft !== null ? call.ttft : null,
      $dInput: call.deltaInput,
      $dCached: call.deltaCached,
      $isSub: call.isSubagent ? 1 : 0,
      $parentSpanId: call.parentSpanId || null,
      $sysPrompt: call.systemPromptFile || null,
      $toolsFile: call.toolsFile || null,
      $reqOpts: call.requestOptions || null,
      $cacheBreak: call.cacheBreakType || null,
      $timeSincePrev: call.timeSincePrev !== null ? call.timeSincePrev : null
    });
  }
}

/** Insert all tool calls for a session. */
function insertToolCalls(db, tools) {
  for (const tool of tools) {
    db.run(`
      INSERT INTO tool_calls (
        session_id, turn_number, tool_name, args_preview, result_size,
        status, linked_llm_call_id, timestamp, dur, parent_span_id, compression_method,
        args_full, result_text
      ) VALUES (
        $sid, $turn, $name, $args, $size,
        $status, $linked, $ts, $dur, $parentSpanId, $compression,
        $argsFull, $resultText
      )
    `, {
      $sid: tool.sessionId,
      $turn: tool.turnNumber,
      $name: tool.toolName,
      $args: tool.argsPreview,
      $size: tool.resultSize,
      $status: tool.status,
      $linked: tool.linkedLlmCallId,
      $ts: tool.timestamp,
      $dur: tool.dur !== null ? tool.dur : null,
      $parentSpanId: tool.parentSpanId || null,
      $compression: tool.compressionMethod,
      $argsFull: tool.argsFull || null,
      $resultText: tool.resultText || null
    });
  }
}

/** Insert all model switches for a session. */
function insertModelSwitches(db, switches) {
  for (const sw of switches) {
    db.run(`
      INSERT INTO model_switches (
        session_id, from_model, to_model, at_call_number,
        cache_before, cache_after, input_delta, timestamp
      ) VALUES (
        $sid, $from, $to, $call,
        $cacheBefore, $cacheAfter, $inputDelta, $ts
      )
    `, {
      $sid: sw.sessionId,
      $from: sw.fromModel,
      $to: sw.toModel,
      $call: sw.atCallNumber,
      $cacheBefore: sw.cacheBefore,
      $cacheAfter: sw.cacheAfter,
      $inputDelta: sw.inputDelta,
      $ts: sw.timestamp
    });
  }
}

/**
 * Insert user messages for a session. `canceledTurns` is a Set of 0-based turn
 * indices flagged canceled (debug-logs cross-reference); pass an empty Set when
 * there is no cancel data (chatSessions).
 */
function insertUserMessages(db, sessionId, userMessages, canceledTurns) {
  for (let i = 0; i < userMessages.length; i++) {
    const msg = userMessages[i];
    const isCanceled = canceledTurns.has(i) ? 1 : 0;
    db.run(`
      INSERT INTO user_messages (session_id, turn_number, content, timestamp, is_canceled)
      VALUES ($sid, $turn, $content, $ts, $canceled)
    `, {
      $sid: sessionId,
      $turn: msg.turnNumber || 0,
      $content: msg.content || null,
      $ts: msg.ts ? new Date(msg.ts).getTime() / 1000 : null,
      $canceled: isCanceled
    });
  }
}

/** Insert agent responses for a session. */
function insertAgentResponses(db, sessionId, agentResponses) {
  for (const resp of agentResponses) {
    db.run(`
      INSERT INTO agent_responses (
        session_id, turn_number, response_text, reasoning_text, timestamp, span_id, parent_span_id
      ) VALUES (
        $sid, $turn, $resp, $reasoning, $ts, $spanId, $parentSpanId
      )
    `, {
      $sid: sessionId,
      $turn: resp.turnNumber,
      $resp: resp.responseText,
      $reasoning: resp.reasoningText,
      $ts: resp.timestamp,
      $spanId: resp.spanId,
      $parentSpanId: resp.parentSpanId
    });
  }
}

/** Insert discovery events for a session. */
function insertDiscoveryEvents(db, sessionId, discoveryEvents) {
  for (const disc of discoveryEvents) {
    db.run(`
      INSERT INTO discovery_events (
        session_id, event_type, event_name, details, timestamp
      ) VALUES (
        $sid, $type, $name, $details, $ts
      )
    `, {
      $sid: sessionId,
      $type: disc.eventType,
      $name: disc.eventName,
      $details: disc.details,
      $ts: disc.timestamp
    });
  }
}

/** Upsert the sync_log row that gates incremental re-sync. */
function upsertSyncLog(db, { sessionId, sourcePath, mtime, totalLines, fileSize, parserVersion }) {
  db.run(`
    INSERT OR REPLACE INTO sync_log (session_id, source_path, main_jsonl_mtime, total_lines, file_size, parser_version, synced_at)
    VALUES ($sid, $src, $mtime, $lines, $fsize, $pver, $now)
  `, {
    $sid: sessionId,
    $src: sourcePath,
    $mtime: mtime,
    $lines: totalLines,
    $fsize: fileSize,
    $pver: parserVersion,
    $now: Math.floor(Date.now() / 1000)
  });
}

/**
 * Parse models.json and upsert into model_catalog table.
 * @param {Object} db
 * @param {string} modelsJsonPath
 */
function syncModelCatalog(db, modelsJsonPath) {
  if (!fs.existsSync(modelsJsonPath)) return;
  try {
    const models = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf-8'));
    if (!Array.isArray(models)) return;
    for (const model of models) {
      const caps = model.capabilities || {};
      const supports = caps.supports || {};
      const limits = caps.limits || {};
      const billing = model.billing || {};
      const prices = billing.token_prices?.default || {};

      db.run(`
        INSERT OR REPLACE INTO model_catalog (
          model_id, display_name, vendor, family, category, price_category,
          is_preview, supports_vision, supports_tool_calls, supports_thinking,
          max_context_tokens, max_output_tokens,
          input_price_per_mtok, output_price_per_mtok, cache_price_per_mtok,
          capabilities_json, updated_at
        ) VALUES (
          $id, $name, $vendor, $family, $cat, $priceCat,
          $preview, $vision, $tools, $thinking,
          $maxCtx, $maxOut,
          $inputPrice, $outputPrice, $cachePrice,
          $capsJson, $now
        )
      `, {
        $id: model.id,
        $name: model.name || null,
        $vendor: model.vendor || null,
        $family: caps.family || null,
        $cat: model.model_picker_category || null,
        $priceCat: model.model_picker_price_category || null,
        $preview: model.preview ? 1 : 0,
        $vision: supports.vision ? 1 : 0,
        $tools: supports.tool_calls ? 1 : 0,
        $thinking: supports.adaptive_thinking ? 1 : 0,
        $maxCtx: limits.max_context_window_tokens || null,
        $maxOut: limits.max_output_tokens || null,
        $inputPrice: prices.input_price || null,
        $outputPrice: prices.output_price || null,
        $cachePrice: prices.cache_price || null,
        $capsJson: JSON.stringify(caps),
        $now: Math.floor(Date.now() / 1000)
      });
    }
  } catch (err) {
    console.warn('[sync] Failed to parse models.json:', err.message);
  }
}

/**
 * Parse and store transcript JSONL file.
 * @param {Object} db
 * @param {string} sessionId
 * @param {string} workspaceHash
 */
function syncTranscripts(db, sessionId, workspaceHash) {
  const transcriptPath = findWorkspaceFile(
    workspaceHash, 'GitHub.copilot-chat', 'transcripts', sessionId + '.jsonl'
  );
  if (!transcriptPath) return;

  try {
    const lines = fs.readFileSync(transcriptPath, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const eventType = event.type || 'unknown';
        const ts = event.timestamp ? new Date(event.timestamp).getTime() / 1000 : null;
        db.run(`
          INSERT INTO transcripts (
            session_id, event_type, event_data, event_uuid, parent_uuid, timestamp
          ) VALUES (
            $sid, $type, $data, $uuid, $parent, $ts
          )
        `, {
          $sid: sessionId,
          $type: eventType,
          $data: line,
          $uuid: event.id || null,
          $parent: event.parentId || null,
          $ts: ts
        });
      } catch { /* malformed line */ }
    }
  } catch (err) {
    console.warn('[sync] Failed to parse transcript:', err.message);
  }
}

/**
 * After sync, recompute computed_aic / computed_cost / is_aic_approx for all sessions
 * that don't have their own AIC data, using the current global ratio.
 * This ensures approx estimates are always based on the latest globalAicRatio
 * (which can change when new sessions with actual AIC data are first synced).
 * @param {Object} db
 * @param {number} globalAicRatio
 */
function recomputeApproxSessions(db, globalAicRatio) {
  db.run(`
    UPDATE sessions
    SET
      computed_aic = ROUND((total_input_tokens + total_output_tokens) * $ratio),
      computed_cost = CASE
        WHEN (total_input_tokens + total_output_tokens) * $ratio > 0
          THEN (total_input_tokens + total_output_tokens) * $ratio / 1e11
          ELSE total_cost
        END,
      is_aic_approx = CASE
        WHEN (total_input_tokens + total_output_tokens) * $ratio > 0 THEN 1
        ELSE 0
        END
    WHERE (total_aic IS NULL OR total_aic = 0)
  `, { $ratio: globalAicRatio });
}

/**
 * Full sync: discover all sessions and sync each one.
 * @param {Object} db - Database instance
 * @returns {Promise<{ synced: number, skipped: number, errors: number }>}
 */
let _syncInProgress = false;

async function fullSync(db) {
  if (_syncInProgress) {
    log.warn('Sync already in progress — skipping concurrent call');
    return { synced: 0, skipped: 0, errors: 0 };
  }
  _syncInProgress = true;

  const sessions = discoverSessions();
  let synced = 0;
  let skipped = 0;
  let errors = 0;

  try {
    // Pre-compute global AIC ratio from existing data before parsing new sessions
    const globalAicRatio = computeGlobalAicRatio(db);

    for (const sessionInfo of sessions) {
      try {
        const didSync = await syncSession(db, sessionInfo, globalAicRatio);
        if (didSync) {
          synced++;
          // Persist after each successful sync for crash safety
          if (synced % 5 === 0) db.persist();
        } else {
          skipped++;
        }
      } catch (err) {
        log.error(`Sync error for session ${sessionInfo.sessionId}:`, err.message);
        errors++;
      }
    }

    // Recompute approx metrics for ALL sessions without their own AIC data.
    // Uses the updated ratio (post-sync) so sessions that were skipped (mtime unchanged)
    // still benefit when new sessions with actual AIC data were parsed above.
    const updatedRatio = computeGlobalAicRatio(db);
    recomputeApproxSessions(db, updatedRatio);

    db.persist();
  } finally {
    _syncInProgress = false;
  }

  return { synced, skipped, errors };
}

module.exports = { discoverSessions, syncSession, fullSync, recomputeApproxSessions };
