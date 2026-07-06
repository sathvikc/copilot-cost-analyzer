/**
 * @fileoverview Parser for GitHub Copilot CLI session logs
 * (~/.copilot/session-state/<id>/events.jsonl).
 *
 * The CLI writes a flat event stream (type + data + timestamp). Unlike VS Code
 * debug logs there is no per-request token breakdown, but the final
 * `session.shutdown` event carries GROUND-TRUTH session totals: premium
 * requests, nano-AIU, and input / cache_read / cache_write / output token
 * counts (also per model in `modelMetrics`). Event types (observed in
 * copilot-agent 1.0.x):
 *   session.start            — sessionId, copilotVersion, startTime, context {cwd, repository, branch}
 *   session.model_change     — newModel (also fires once at session start)
 *   user.message             — content, delivery ('idle' = sent while agent idle)
 *   assistant.message        — model, content, reasoningText, outputTokens, toolRequests
 *   assistant.turn_start/end — agent step markers (NOT user-turn boundaries)
 *   tool.execution_start/complete — toolCallId, toolName, arguments / success, result
 *   abort                    — reason ('user_initiated' = user pressed Esc/Ctrl+C)
 *   subagent.started/completed
 *   session.shutdown         — totalPremiumRequests, totalNanoAiu, tokenDetails, modelMetrics
 *
 * Returns the same shape as parseSessionDirectory so sync can persist it
 * through the shared row writers, plus `totals` (from session.shutdown) and
 * `workspacePath` (from session.start context.cwd).
 */

const fs = require('fs');

/** Parse an ISO event timestamp to Unix seconds (float), or null. */
function toSec(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms / 1000;
}

/** Flatten a tool result payload to text for size accounting. */
function resultText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result.content === 'string') return result.content;
  try { return JSON.stringify(result); } catch { return String(result); }
}

/**
 * Parse a Copilot CLI events.jsonl file.
 * @param {string} filePath - absolute path to events.jsonl
 * @param {string} sessionId - session UUID (the directory name)
 * @returns {object} parseSessionDirectory-shaped result + { totals, workspacePath, repository }
 */
function parseCliEventsFile(filePath, sessionId) {
  const empty = {
    llmCalls: [], toolCalls: [], modelSwitches: [], userMessages: [],
    interruptions: new Map(), agentResponses: [], discoveryEvents: [],
    sessionMeta: { copilotVersion: null, vscodeVersion: null },
    firstTs: null, lastTs: null, totalLines: 0, hasSubagent: false,
    subagentCounts: {}, title: null, mode: 'cli', initialLocation: 'cli',
    firstPrompt: null, workspacePath: null, repository: null, totals: null,
  };

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return empty;
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  empty.totalLines = lines.length;

  const llmCalls = [];
  const toolCalls = [];
  const modelSwitches = [];
  const userMessages = [];
  const agentResponses = [];
  const interruptions = new Map();
  const subagentCounts = {};

  let sessionMeta = { copilotVersion: null, vscodeVersion: null };
  let workspacePath = null;
  let repository = null;
  let totals = null;
  let firstTs = null;
  let lastTs = null;
  let currentModel = null;
  let turnNumber = 0;
  let callNumber = 0;
  let hasSubagent = false;
  let sawActivitySinceUserMsg = false; // guards abort attribution
  const pendingTools = new Map(); // toolCallId → { toolName, args, ts }

  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const data = event.data || {};
    const ts = toSec(event.timestamp || data.startTime);
    if (ts !== null) {
      if (firstTs === null) firstTs = ts;
      lastTs = ts;
    }

    switch (event.type) {
      case 'session.start': {
        sessionMeta = { copilotVersion: data.copilotVersion || null, vscodeVersion: null };
        workspacePath = data.context?.cwd || null;
        repository = data.context?.repository || null;
        break;
      }

      case 'session.model_change': {
        const newModel = data.newModel || null;
        if (newModel && currentModel && currentModel !== newModel) {
          modelSwitches.push({
            sessionId,
            fromModel: currentModel,
            toModel: newModel,
            atCallNumber: callNumber + 1,
            cacheBefore: null,
            cacheAfter: null,
            inputDelta: null,
            timestamp: ts,
          });
        }
        if (newModel) currentModel = newModel;
        break;
      }

      case 'user.message': {
        const content = String(data.content || '').trim();
        if (!content) break;
        turnNumber++;
        userMessages.push({ content, ts: event.timestamp || null, turnNumber });
        sawActivitySinceUserMsg = false;
        break;
      }

      case 'assistant.message': {
        callNumber++;
        sawActivitySinceUserMsg = true;
        const model = data.model || currentModel || 'unknown';
        llmCalls.push({
          sessionId,
          turnNumber,
          callNumber,
          model,
          // The CLI does not log per-call input/cache tokens — only outputTokens
          // per message and real session totals at shutdown. Never fabricated.
          inputTokens: 0,
          cachedTokens: null,
          cacheWriteTokens: null,
          outputTokens: parseInt(data.outputTokens, 10) || 0,
          cost: 0,
          aic: null,
          timestamp: ts,
          debugName: 'cli',
          status: 'ok',
          spanId: data.apiCallId || data.requestId || null,
          parentSpanId: data.interactionId || null,
          ttft: null,
          deltaInput: 0,
          deltaCached: null,
          isSubagent: false,
          systemPromptFile: null,
          toolsFile: null,
          requestOptions: null,
          cacheBreakType: null,
          cacheBreakDetail: null,
          timeSincePrev: null,
        });
        if (data.content || data.reasoningText) {
          agentResponses.push({
            sessionId,
            turnNumber,
            responseText: data.content || null,
            reasoningText: data.reasoningText || null,
            timestamp: ts,
            spanId: data.messageId || null,
            parentSpanId: data.interactionId || null,
          });
        }
        break;
      }

      case 'tool.execution_start': {
        sawActivitySinceUserMsg = true;
        if (data.toolCallId) {
          pendingTools.set(data.toolCallId, { toolName: data.toolName, args: data.arguments, ts });
        }
        break;
      }

      case 'tool.execution_complete': {
        const started = data.toolCallId ? pendingTools.get(data.toolCallId) : null;
        if (data.toolCallId) pendingTools.delete(data.toolCallId);
        const args = started?.args !== undefined
          ? (typeof started.args === 'string' ? started.args : JSON.stringify(started.args))
          : '';
        const text = resultText(data.result);
        toolCalls.push({
          sessionId,
          turnNumber,
          toolName: started?.toolName || 'unknown',
          argsPreview: String(args).slice(0, 200),
          argsFull: args || null,
          resultText: text || null,
          resultSize: text.length,
          status: data.success === false ? 'error' : 'ok',
          linkedLlmCallId: callNumber || null,
          timestamp: ts,
          dur: started?.ts != null && ts != null ? Math.round((ts - started.ts) * 1000) : null,
          parentSpanId: data.interactionId || null,
          compressionMethod: null,
        });
        break;
      }

      case 'abort': {
        // The user aborted the in-flight run (Esc / Ctrl+C). Attribute it to the
        // current turn's message — but only if the agent actually did something
        // since (an abort with no activity has nothing to interrupt).
        if (userMessages.length > 0 && sawActivitySinceUserMsg) {
          const type = data.reason === 'user_initiated' ? 'stopped' : 'interrupted';
          interruptions.set(userMessages.length - 1, type);
        }
        break;
      }

      case 'subagent.started': {
        hasSubagent = true;
        const name = data.agentName || data.name || 'subagent';
        subagentCounts[name] = (subagentCounts[name] || 0) + 1;
        break;
      }

      case 'session.shutdown': {
        const td = data.tokenDetails || {};
        totals = {
          shutdownType: data.shutdownType || null,
          premiumRequests: typeof data.totalPremiumRequests === 'number' ? data.totalPremiumRequests : null,
          nanoAiu: typeof data.totalNanoAiu === 'number' ? data.totalNanoAiu : null,
          inputTokens: td.input?.tokenCount ?? null,
          cacheReadTokens: td.cache_read?.tokenCount ?? null,
          cacheWriteTokens: td.cache_write?.tokenCount ?? null,
          outputTokens: td.output?.tokenCount ?? null,
          apiDurationMs: data.totalApiDurationMs ?? null,
          modelMetrics: data.modelMetrics || null,
        };
        break;
      }
    }
  }

  return {
    llmCalls,
    toolCalls,
    modelSwitches,
    userMessages,
    interruptions,
    agentResponses,
    discoveryEvents: [],
    sessionMeta,
    firstTs,
    lastTs,
    totalLines: lines.length,
    hasSubagent,
    subagentCounts,
    title: null,
    mode: 'cli',
    initialLocation: 'cli',
    firstPrompt: userMessages[0]?.content || null,
    workspacePath,
    repository,
    totals,
  };
}

module.exports = { parseCliEventsFile };
