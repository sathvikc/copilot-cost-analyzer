/**
 * @fileoverview Stream parser for Copilot debug logs (main.jsonl, runSubagent-*.jsonl).
 *
 * Uses Node.js readline for memory-efficient streaming of large JSONL files.
 * Returns structured session data: LLM calls, tool calls, model switches.
 */

const fs = require('fs');
const readline = require('readline');
const path = require('path');

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * FNV-1a 32-bit hash of a string — fast and compact. We only use it to detect
 * whether two normalized messages differ; it is never reversed or persisted.
 * @param {string} str
 * @returns {number} unsigned 32-bit hash
 */
function hashText(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * Normalize a request's `inputMessages` into compact per-message signatures
 * `{role, name, len, hash}`, mirroring VS Code's Cache Explorer normalization so
 * we can diff two consecutive requests' prompt prefixes. We keep only the text
 * length + hash (not the text itself) so signatures stay tiny and never reach
 * the DB. Part concatenation matches the Cache Explorer:
 *   text / reasoning            -> content
 *   tool_call                   -> "call:<name>" + JSON(arguments)
 *   tool_call_response / result -> response (or content), stringified
 *   tool_search_output          -> JSON({id,status,tools})
 *
 * @param {Array|string} inputMessages - array of {role, parts} or a JSON string
 * @returns {Array<{role:string,name:string|undefined,len:number,hash:number}>|null}
 */
function normalizeMessagesForCache(inputMessages) {
  let msgs = inputMessages;
  if (typeof msgs === 'string') {
    try { msgs = JSON.parse(msgs); } catch { return null; }
  }
  if (!Array.isArray(msgs) || msgs.length === 0) return null;
  const out = [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') { out.push({ role: 'unknown', name: undefined, len: 0, hash: 0 }); continue; }
    let role = typeof m.role === 'string' ? m.role : 'unknown';
    const name = typeof m.name === 'string' ? m.name : undefined;
    let text = '';
    let sawTool = false, sawText = false, sawSearch = false;
    if (Array.isArray(m.parts)) {
      for (const p of m.parts) {
        if (!p || typeof p !== 'object') continue;
        switch (p.type) {
          case undefined:
          case 'text':
          case 'reasoning':
            if (typeof p.content === 'string') { text += p.content; sawText = true; }
            break;
          case 'tool_call':
            if (p.name) text += `call:${p.name}`;
            if (p.arguments !== undefined) text += safeJson(p.arguments);
            break;
          case 'tool_call_response':
          case 'tool_result':
            if (typeof p.response === 'string') text += p.response;
            else if (p.response !== undefined) text += safeJson(p.response);
            else if (typeof p.content === 'string') text += p.content;
            else if (p.content !== undefined) text += safeJson(p.content);
            sawTool = true;
            break;
          case 'tool_search_output':
            text += safeJson({ id: p.id, status: p.status, tools: p.tools });
            sawSearch = true;
            break;
        }
      }
    }
    if (sawSearch && !sawText) role = 'tool_search';
    else if (sawTool && !sawText) role = 'tool';
    if (text.length === 0 && role === 'unknown') text = safeJson(m);
    out.push({ role, name, len: text.length, hash: hashText(text) });
  }
  return out;
}

/**
 * Compare two requests' normalized prompt prefixes (prev → curr) to localize a
 * cache break. Mirrors the Cache Explorer's index-by-index walk, but — unlike it
 * — a tail-only append is NOT treated as a break: messages added at the END
 * cannot evict a previously-cached prefix. So a byte-identical shared prefix
 * means the drop was a true provider-side eviction (nothing structural changed),
 * while a difference INSIDE the shared prefix is a real structural cause the
 * cached-token counts alone cannot localize.
 *
 * @param {Array|null} a - prev signatures
 * @param {Array|null} b - curr signatures
 * @returns {{comparable:boolean, prefixIdentical?:boolean, firstChange?:number, how?:string}}
 */
function diffMessagePrefix(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return { comparable: false };
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const x = a[i], y = b[i];
    if (x.role === y.role && x.name === y.name && x.len === y.len && x.hash === y.hash) continue;
    return { comparable: true, prefixIdentical: false, firstChange: i, how: x.len !== y.len ? 'lengthChange' : 'contentDrift' };
  }
  return { comparable: true, prefixIdentical: true };
}

/**
 * Parse a debug log JSONL file into session events.
 * @param {string} filePath - Absolute path to main.jsonl or subagent file
 * @param {string} sessionId - Session UUID
 * @returns {Promise<{
 *   llmCalls: import('./types').LlmCall[],
 *   toolCalls: import('./types').ToolCall[],
 *   modelSwitches: import('./types').ModelSwitch[],
 *   userMessages: {content: string, ts: string|null}[],
 *   firstTs: number|null,
 *   lastTs: number|null,
 *   lineCount: number
 * }>}
 */
async function parseDebugLog(filePath, sessionId) {
  const llmCalls = [];
  const toolCalls = [];
  const modelSwitches = [];
  const userMessages = [];
  const agentResponses = [];
  const discoveryEvents = [];
  let sessionMeta = null; // session_start metadata

  let callNumber = 0;
  let turnNumber = 0;
  let lastModel = null;
  let lastLlmCall = null;
  let firstTs = null;
  let lastTs = null;
  let lineCount = 0;
  let titleFile = null;

  // Track all non-message events with line index for post-processing turn alignment
  const eventLog = []; // { type, lineIndex, turnNumber }

  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    lineCount++;
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const ts = event.ts ? new Date(event.ts).getTime() / 1000 : null;
    if (ts !== null) {
      if (firstTs === null) firstTs = ts;
      lastTs = ts;
    }

    // A user turn starts when the user sends a message, not on every agent step.
    // Debug logs emit turn_start/turn_end for each agent reasoning step; those
    // are NOT user turn boundaries. The real boundary is a user_message with content.
    if (event.type === 'user_message') {
      const content = event.content || event.text || event.message || event.prompt
        || event.attrs?.content || event.attrs?.text || event.attrs?.message || event.attrs?.prompt || '';
      const text = String(content).trim();
      if (text) {
        turnNumber++;
        userMessages.push({ content: text, ts: event.ts || null, turnNumber, lineIndex: lineCount });
      }
      continue;
    }

    if (event.type === 'session_start') {
      const attrs = event.attrs || {};
      sessionMeta = {
        copilotVersion: attrs.copilotVersion || null,
        vscodeVersion: attrs.vscodeVersion || null
      };
      continue;
    }

    if (event.type === 'turn_start') {
      // turn_start is an agent step marker, not a user turn boundary.
      // No-op; turnNumber was already advanced by the preceding user_message.
      continue;
    }

    if (event.type === 'child_session_ref' && event.name === 'title' && event.attrs?.childLogFile) {
      titleFile = event.attrs.childLogFile;
      continue;
    }

    if (event.type === 'agent_response') {
      const attrs = event.attrs || {};
      agentResponses.push({
        sessionId,
        turnNumber,
        responseText: attrs.response || null,
        reasoningText: attrs.reasoning || null,
        timestamp: ts,
        spanId: event.spanId || null,
        parentSpanId: event.parentSpanId || null
      });
      continue;
    }

    if (event.type === 'discovery') {
      const attrs = event.attrs || {};
      discoveryEvents.push({
        sessionId,
        eventType: event.name || 'unknown',
        eventName: event.name || null,
        details: attrs.details || null,
        timestamp: ts
      });
      continue;
    }

    if (event.type === 'llm_request') {
      callNumber++;
      const attrs = event.attrs || {};
      const model = attrs.model || '';
      const inputTokens = parseInt(attrs.inputTokens, 10) || 0;
      const outputTokens = parseInt(attrs.outputTokens, 10) || 0;
      const cachedTokens = 'cachedTokens' in attrs ? parseInt(attrs.cachedTokens, 10) : null;
      const cacheWriteTokens = 'cacheWriteTokens' in attrs ? parseInt(attrs.cacheWriteTokens, 10) : null;
      // AIC may be at top-level attrs or nested in attrs.usage (older formats)
      const aic = 'copilotUsageNanoAiu' in attrs ? parseInt(attrs.copilotUsageNanoAiu, 10)
        : attrs.usage && 'copilotUsageNanoAiu' in attrs.usage ? parseInt(attrs.usage.copilotUsageNanoAiu, 10)
        : null;

      const deltaInput = lastLlmCall ? inputTokens - lastLlmCall.inputTokens : 0;
      const deltaCached = lastLlmCall && cachedTokens !== null && lastLlmCall.cachedTokens !== null
        ? cachedTokens - lastLlmCall.cachedTokens
        : null;

      const ttft = 'ttft' in attrs ? parseInt(attrs.ttft, 10) : null;

      const spanId = event.spanId || null;
      const parentSpanId = event.parentSpanId || null;

      const call = {
        sessionId,
        turnNumber,
        callNumber,
        model,
        inputTokens,
        cachedTokens,
        cacheWriteTokens,
        outputTokens,
        cost: 0, // computed later
        aic,
        timestamp: ts,
        debugName: event.debugName || attrs.debugName || '',
        status: event.status || 'ok',
        spanId,
        parentSpanId,
        ttft,
        deltaInput,
        deltaCached,
        isSubagent: false, // set by parseSessionDirectory
        systemPromptFile: attrs.systemPromptFile || null,
        toolsFile: attrs.toolsFile || null,
        requestOptions: attrs.requestOptions || null,
        cacheBreakType: null,   // classified after all calls are collected
        cacheBreakDetail: null, // content-diff verdict for the break (JSON string)
        timeSincePrev: null     // seconds since previous call (set during classification)
      };

      // Transient prompt-prefix signature used only during classification to
      // diff this request against the previous one; stripped before returning so
      // it never reaches the DB layer.
      call._msgSig = normalizeMessagesForCache(attrs.inputMessages);

      llmCalls.push(call);
      eventLog.push({ type: 'llm_request', lineIndex: lineCount, turnNumber });

      // Extract user prompt from llm_request messages as fallback
      if (userMessages.length === 0 && attrs.messages) {
        try {
          const msgs = typeof attrs.messages === 'string' ? JSON.parse(attrs.messages) : attrs.messages;
          if (Array.isArray(msgs)) {
            const userMsg = msgs.find(m => m.role === 'user' || m.role === 'User');
            if (userMsg && userMsg.content) {
              const text = String(userMsg.content);
              const alreadySeen = userMessages.some(m => m.content === text);
              if (!alreadySeen) {
                userMessages.push({ content: text, ts: event.ts || null, turnNumber, lineIndex: lineCount });
              }
            }
          }
        } catch { /* ignore parse errors */ }
      }

      // Detect model switch. A retry with the SAME model is NOT a switch,
      // but a retry that changes model IS a legitimate switch.
      const isRetry = (event.debugName || attrs.debugName || '').includes('retry');
      const isSameModelRetry = isRetry && lastModel === model;
      if (lastModel && lastModel !== model && !isSameModelRetry) {
        modelSwitches.push({
          sessionId,
          fromModel: lastModel,
          toModel: model,
          atCallNumber: callNumber,
          cacheBefore: lastLlmCall ? lastLlmCall.cachedTokens : null,
          cacheAfter: cachedTokens,
          inputDelta: deltaInput,
          timestamp: ts
        });
      }

      lastModel = model;
      lastLlmCall = call;
      continue;
    }

    if (event.type === 'tool_call') {
      const attrs = event.attrs || {};
      const result = attrs.result || '';
      const args = attrs.args || '';
      const resultSize = result.length;

      // Detect VS Code compression methods from result content
      let compressionMethod = null;
      if (result.includes('unchanged since previous poll')) {
        compressionMethod = 'outputDeltas';
      } else if (result.includes('since previous poll')) {
        compressionMethod = 'outputDeltas';
      } else if (result.includes('Output compressed by')) {
        compressionMethod = 'compressOutput';
      } else if (result.includes('Same output as last run')) {
        compressionMethod = 'compressOutput';
      }

      const dur = event.dur !== undefined ? parseInt(event.dur, 10) : null;
      const parentSpanId = event.parentSpanId || null;

      toolCalls.push({
        sessionId,
        turnNumber,
        toolName: event.name || 'unknown',
        argsPreview: String(args).slice(0, 200),
        argsFull: args ? String(args) : null,
        resultText: result || null,
        resultSize,
        status: event.status || 'ok',
        linkedLlmCallId: null, // resolved later by spanId or timestamp
        timestamp: ts,
        dur,
        parentSpanId,
        compressionMethod
      });
      eventLog.push({ type: 'tool_call', lineIndex: lineCount, turnNumber });
    }
  }

  // Post-process: align user messages to correct turns.
  // A user_message may appear BEFORE its turn_start in the log.
  // Assign it to the turn of the first subsequent tool/LLM event.
  const anchorEvents = eventLog
    .filter(e => e.type === 'llm_request' || e.type === 'tool_call')
    .sort((a, b) => a.lineIndex - b.lineIndex);
  for (const msg of userMessages) {
    if (!msg.lineIndex) continue;
    const anchor = anchorEvents.find(e => e.lineIndex > msg.lineIndex);
    if (anchor && anchor.turnNumber !== msg.turnNumber) {
      msg.turnNumber = anchor.turnNumber;
    }
  }

  // Keep only the LAST user message per turn.
  // Debug logs replay the full conversation history before each turn_start;
  // the last message before a turn_start is the one that initiated that turn.
  const lastByTurn = new Map();
  for (const msg of userMessages) {
    // Only overwrite if this message has a higher lineIndex (appears later in log)
    const existing = lastByTurn.get(msg.turnNumber);
    if (!existing || (msg.lineIndex || 0) > (existing.lineIndex || 0)) {
      lastByTurn.set(msg.turnNumber, msg);
    }
  }
  userMessages.length = 0;
  const sorted = [...lastByTurn.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, msg] of sorted) {
    delete msg.lineIndex;
    userMessages.push(msg);
  }

  // Link tool calls to the LLM call that consumed their output.
  // Strategy: tools and LLM calls that share the same parentSpanId are siblings
  // within the same turn/request span. Link each tool to the first LLM call
  // with the same parent that comes chronologically after the tool.
  // Fallback: timestamp proximity when parentSpanId is missing.
  for (const tool of toolCalls) {
    if (tool.parentSpanId) {
      const sibling = llmCalls.find(c =>
        c.parentSpanId === tool.parentSpanId &&
        c.timestamp !== null && tool.timestamp !== null &&
        c.timestamp >= tool.timestamp
      );
      if (sibling) {
        tool.linkedLlmCallId = sibling.callNumber;
        continue;
      }
    }
    // Fallback: first LLM call at or after this tool's timestamp
    if (tool.timestamp === null) continue;
    const nextLlm = llmCalls.find(c => c.timestamp !== null && c.timestamp >= tool.timestamp);
    if (nextLlm) {
      tool.linkedLlmCallId = nextLlm.callNumber;
    }
  }

  return { llmCalls, toolCalls, modelSwitches, userMessages, agentResponses, discoveryEvents, sessionMeta, firstTs, lastTs, lineCount, titleFile };
}

/**
 * Scan a debug log directory for all JSONL files (main + subagents).
 * @param {string} dirPath - Absolute path to debug-logs/<session>/
 * @param {string} sessionId
 * @returns {Promise<{
 *   llmCalls: import('./types').LlmCall[],
 *   toolCalls: import('./types').ToolCall[],
 *   modelSwitches: import('./types').ModelSwitch[],
 *   userMessages: {content: string, ts: string|null}[],
 *   firstTs: number|null,
 *   lastTs: number|null,
 *   totalLines: number,
 *   hasSubagent: boolean
 * }>}
 */
async function parseSessionDirectory(dirPath, sessionId) {
  const mainPath = path.join(dirPath, 'main.jsonl');
  if (!fs.existsSync(mainPath)) {
    return {
      llmCalls: [], toolCalls: [], modelSwitches: [],
      userMessages: [], firstTs: null, lastTs: null,
      totalLines: 0, hasSubagent: false
    };
  }

  const mainResult = await parseDebugLog(mainPath, sessionId);

  // Extract title from child log file if available
  let title = null;
  if (mainResult.titleFile) {
    const titlePath = path.join(dirPath, mainResult.titleFile);
    if (fs.existsSync(titlePath)) {
      try {
        const titleLines = fs.readFileSync(titlePath, 'utf8').split('\n').slice(0, 50);
        for (const line of titleLines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'agent_response' && typeof obj.attrs?.response === 'string') {
              const raw = obj.attrs.response;
              let t = null;
              // Try multiple response formats
              try {
                const parsed = JSON.parse(raw);
                // Format: [{role:'assistant', parts:[{type:'text', content:'...'}]}]
                t = parsed?.[0]?.parts?.[0]?.content
                  // Format: {content:'...'} or {text:'...'}
                  || parsed?.content
                  || parsed?.text
                  // Format: [{text:'...'}] or [{content:'...'}]
                  || parsed?.[0]?.text
                  || parsed?.[0]?.content
                  // Format: {parts:[{content:'...'}]}
                  || parsed?.parts?.[0]?.content
                  // Format: {response:'...'}
                  || parsed?.response;
              } catch {
                // If not JSON, use raw string directly
                t = raw;
              }
              if (t) {
                title = String(t).trim();
                console.log(`[parser] Title extracted from ${mainResult.titleFile}: "${title.slice(0, 40)}..."`);
                break;
              }
            }
            // Also check for direct text attrs
            if (obj.type === 'agent_response' && typeof obj.attrs?.text === 'string') {
              title = obj.attrs.text.trim();
              console.log(`[parser] Title extracted from ${mainResult.titleFile} (text attr): "${title.slice(0, 40)}..."`);
              break;
            }
          } catch { /* malformed */ }
        }
      } catch (err) {
        console.warn(`[parser] Failed to read title file ${titlePath}:`, err.message);
      }
    } else {
      console.warn(`[parser] Title file not found: ${titlePath}`);
    }
  }

  // Look for subagent files
  const files = fs.readdirSync(dirPath);
  const subagentFiles = files.filter(f => f.startsWith('runSubagent-') && f.endsWith('.jsonl'));

  let allLlmCalls = [...mainResult.llmCalls];
  let allToolCalls = [...mainResult.toolCalls];
  let allModelSwitches = [...mainResult.modelSwitches];
  let allUserMessages = [...mainResult.userMessages];
  let allAgentResponses = [...mainResult.agentResponses];
  let allDiscoveryEvents = [...mainResult.discoveryEvents];
  const sessionMeta = mainResult.sessionMeta;
  let totalLines = mainResult.lineCount;
  let firstTs = mainResult.firstTs;
  let lastTs = mainResult.lastTs;

  // Track subagent call counts per model for display
  const subagentCounts = {};

  for (const subFile of subagentFiles) {
    const subPath = path.join(dirPath, subFile);
    const subResult = await parseDebugLog(subPath, sessionId);
    // Subagent calls need renumbered to avoid collision
    const baseCallNum = allLlmCalls.length;
    for (const call of subResult.llmCalls) {
      call.callNumber += baseCallNum;
      call.isSubagent = true;
      allLlmCalls.push(call);
      // Count subagent calls per model
      const m = call.model || 'unknown';
      subagentCounts[m] = (subagentCounts[m] || 0) + 1;
    }
    allToolCalls.push(...subResult.toolCalls);
    allAgentResponses.push(...subResult.agentResponses);
    // NOTE: Subagent model switches are internal to the subagent and should
    // NOT count as session-level model switches. Only main log switches matter.
    // allModelSwitches.push(...subResult.modelSwitches);
    // NOTE: subagent userMessages are prompts TO the subagent (from main agent),
    // not FROM the user. Don't merge them into main session userMessages.
    totalLines += subResult.lineCount;
    if (subResult.firstTs !== null && (firstTs === null || subResult.firstTs < firstTs)) {
      firstTs = subResult.firstTs;
    }
    if (subResult.lastTs !== null && (lastTs === null || subResult.lastTs > lastTs)) {
      lastTs = subResult.lastTs;
    }
  }

  // Re-sort LLM calls by timestamp (or callNumber as fallback)
  allLlmCalls.sort((a, b) => {
    if (a.timestamp !== null && b.timestamp !== null) return a.timestamp - b.timestamp;
    return a.callNumber - b.callNumber;
  });

  // Recompute deltas, but keep separate baselines for main vs subagent contexts.
  // A subagent is an independent conversation; its deltas should never reference
  // the main agent's previous call (and vice versa).
  let lastMain = null;
  let lastSub = null;
  for (const call of allLlmCalls) {
    if (call.isSubagent) {
      call.deltaInput = lastSub ? call.inputTokens - lastSub.inputTokens : 0;
      call.deltaCached = (lastSub && call.cachedTokens !== null && lastSub.cachedTokens !== null)
        ? call.cachedTokens - lastSub.cachedTokens
        : null;
      lastSub = call;
    } else {
      call.deltaInput = lastMain ? call.inputTokens - lastMain.inputTokens : 0;
      call.deltaCached = (lastMain && call.cachedTokens !== null && lastMain.cachedTokens !== null)
        ? call.cachedTokens - lastMain.cachedTokens
        : null;
      lastMain = call;
    }
  }

  // Re-number after merge
  allLlmCalls.forEach((c, i) => { c.callNumber = i + 1; });

  // Classify cache breaks: detect WHY cached_tokens dropped between consecutive calls.
  // Uses separate baselines for main vs subagent (matching delta recomputation above).
  //
  // A "break" is judged relative to the prior cache, not by an absolute token count:
  // a fixed 1k threshold flags trivial ~4% dips (cache churn / rounding) as breaks
  // while under-reporting on small contexts. We require the cache to fall by a
  // meaningful FRACTION of its previous value (and clear a small floor so we ignore
  // rounding noise on tiny caches). This matches the Cache-tab UI's 20%-drop rule.
  const CACHE_BREAK_FRACTION = 0.2; // cached fell by >20% of the prior value …
  const CACHE_BREAK_FLOOR = 256;    // … and by at least this many tokens
  const isCacheBreak = (prev, curr) => {
    const drop = (prev.cachedTokens || 0) - (curr.cachedTokens || 0);
    return drop > CACHE_BREAK_FLOOR && drop > (prev.cachedTokens || 0) * CACHE_BREAK_FRACTION;
  };
  let prevMain = null;
  let prevSub = null;
  for (const curr of allLlmCalls) {
    const prev = curr.isSubagent ? prevSub : prevMain;
    if (prev) {
      if (isCacheBreak(prev, curr)) {
        const isRetry = (curr.debugName || '').startsWith('retry');
        // Compaction = the SAME model's input was trimmed substantially (>20%) to
        // fit the context window; judged proportionally for the same reason.
        const inputDrop = (prev.inputTokens || 0) - (curr.inputTokens || 0);
        const isCompaction = inputDrop > (prev.inputTokens || 0) * CACHE_BREAK_FRACTION;
        // Order matters: an identity change (model / subagent / system prompt /
        // tools / options) invalidates the cache on its own and brings a fresh
        // input baseline, so it must be checked BEFORE compaction. A model switch
        // in particular drops input as a side effect — classifying that as
        // "compaction" is wrong. Compaction only applies when nothing structural
        // changed but the same model's context was trimmed to fit the window.
        if (curr.model !== prev.model) {
          curr.cacheBreakType = 'model_switch';
        } else if (curr.isSubagent !== prev.isSubagent) {
          curr.cacheBreakType = 'subagent_boundary';
        } else if (curr.systemPromptFile && prev.systemPromptFile && curr.systemPromptFile !== prev.systemPromptFile) {
          curr.cacheBreakType = 'system_prompt_change';
        } else if (curr.toolsFile && prev.toolsFile && curr.toolsFile !== prev.toolsFile) {
          curr.cacheBreakType = 'tools_changed';
        } else if (curr.requestOptions && prev.requestOptions && curr.requestOptions !== prev.requestOptions) {
          curr.cacheBreakType = 'options_changed';
        } else if (isCompaction) {
          curr.cacheBreakType = 'compaction';
        } else if (isRetry) {
          curr.cacheBreakType = 'retry';
        } else {
          curr.cacheBreakType = 'provider_eviction';
        }
        // Content-diff refinement: when the metadata ladder found no structural
        // cause (provider_eviction), compare the actual prompt prefixes. A
        // byte-identical prefix confirms a genuine provider-side eviction — the
        // cached content was unchanged, the provider simply dropped it (do NOT
        // blame appended messages, the mistake VS Code's Cache Explorer makes).
        // A change INSIDE the established prefix (index >= 1) is a real
        // structural cause the token counts can't localize, e.g. an earlier tool
        // result was pruned/edited. A change at index 0 is inconclusive (some
        // logs record only the per-turn delta, not the full prefix), so we leave
        // it as a plain eviction.
        if (curr.cacheBreakType === 'provider_eviction' && prev._msgSig && curr._msgSig) {
          const d = diffMessagePrefix(prev._msgSig, curr._msgSig);
          if (d.comparable && d.prefixIdentical) {
            curr.cacheBreakDetail = JSON.stringify({ kind: 'eviction' });
          } else if (d.comparable && !d.prefixIdentical && d.firstChange >= 1) {
            curr.cacheBreakDetail = JSON.stringify({ kind: 'prefix_change', at: d.firstChange, how: d.how });
          }
        }
        // Compute time gap from previous call (useful for eviction analysis)
        if (prev.timestamp && curr.timestamp) {
          curr.timeSincePrev = Math.round(curr.timestamp - prev.timestamp);
        }
      }
    }
    if (curr.isSubagent) { prevSub = curr; } else { prevMain = curr; }
  }

  // Also classify subagent boundary transitions (main→sub or sub→main)
  for (let i = 1; i < allLlmCalls.length; i++) {
    const prev = allLlmCalls[i - 1];
    const curr = allLlmCalls[i];
    if (curr.isSubagent !== prev.isSubagent && !curr.cacheBreakType) {
      if (isCacheBreak(prev, curr)) {
        curr.cacheBreakType = 'subagent_boundary';
      }
    }
  }

  // Drop the transient prompt-prefix signatures — they exist only for the diff
  // above and must not flow into the DB layer or callers.
  for (const c of allLlmCalls) { delete c._msgSig; }

  return {
    llmCalls: allLlmCalls,
    toolCalls: allToolCalls,
    modelSwitches: allModelSwitches,
    userMessages: allUserMessages,
    agentResponses: allAgentResponses,
    discoveryEvents: allDiscoveryEvents,
    sessionMeta,
    firstTs,
    lastTs,
    totalLines,
    hasSubagent: subagentFiles.length > 0,
    subagentCounts,
    title
  };
}

module.exports = { parseDebugLog, parseSessionDirectory };
