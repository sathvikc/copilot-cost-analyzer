/**
 * @fileoverview Full parser for Copilot's chatSessions store (<id>.jsonl).
 *
 * Unlike debug-logs/main.jsonl (gated behind the agentDebugLog setting), the
 * chatSessions file is always written. It is a PATCH STREAM:
 *   - kind:0  → full snapshot, payload in `.v` (the session object)
 *   - kind:1  → set the value at key-path `.k` to `.v`
 *   - kind:2  → numeric-keyed `.v` ({"0":el,"1":el,…}) merged by index into the
 *               array at key-path `.k` (used to append requests and stream the
 *               per-turn `response` parts)
 *
 * We reconstruct the final session object by applying patches in order, then map
 * each request (a user turn) onto the SAME shape `parseSessionDirectory` returns,
 * so the sync layer can persist it through the existing code path.
 *
 * IMPORTANT — data limits (verified against debug-logs ground truth):
 *   - `promptTokens` is the FINAL internal call only → input is undercounted.
 *   - `completionTokens` is cumulative for the turn → output is accurate.
 *   - There is NO cache split and NO AIC/cost in chatSessions. Those stay NULL
 *     and are estimated downstream (never fabricated here).
 */

const fs = require('fs');

/**
 * Apply one patch to the reconstructed root object (mutates in place).
 * @param {object} root - the session object being rebuilt
 * @param {Array<string|number>} k - key-path
 * @param {*} v - value
 * @param {number} kind - 1 (set) or 2 (numeric-keyed array merge)
 */
function applyPatch(root, k, v, kind) {
  if (!Array.isArray(k) || k.length === 0) return;
  let node = root;
  // Navigate (creating containers as needed) to the parent of the last key.
  for (let i = 0; i < k.length - 1; i++) {
    const key = k[i];
    if (node[key] == null || typeof node[key] !== 'object') {
      node[key] = typeof k[i + 1] === 'number' ? [] : {};
    }
    node = node[key];
  }
  const last = k[k.length - 1];
  const isNumericKeyed = kind === 2 && v && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).every((x) => !Number.isNaN(Number(x)));
  if (isNumericKeyed) {
    if (!Array.isArray(node[last])) node[last] = [];
    for (const idxKey of Object.keys(v)) {
      node[last][Number(idxKey)] = v[idxKey];
    }
  } else {
    node[last] = v;
  }
}

/**
 * Reconstruct the final session object from a chatSessions patch stream.
 * @param {string[]} lines - non-empty JSONL lines
 * @returns {object|null} the rebuilt session object (snapshot `.v` + patches)
 */
function reconstructSession(lines) {
  let root = null;
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.kind === 0 && obj.v && typeof obj.v === 'object') {
      root = obj.v;
    } else if ((obj.kind === 1 || obj.kind === 2) && root) {
      applyPatch(root, obj.k, obj.v, obj.kind);
    }
  }
  return root;
}

/**
 * Extract assistant text and reasoning from a request's `response` parts and,
 * as a fallback, its `result.metadata.toolCallRounds`.
 * @param {object} request
 * @returns {{ responseText: string|null, reasoningText: string|null }}
 */
function extractResponse(request) {
  const textParts = [];
  const reasoningParts = [];

  const partValue = (part) => {
    if (typeof part.value === 'string') return part.value;
    if (part.value && typeof part.value === 'object' && typeof part.value.value === 'string') {
      return part.value.value;
    }
    return null;
  };

  if (Array.isArray(request.response)) {
    for (const part of request.response) {
      if (!part || typeof part !== 'object') continue;
      if (part.kind === 'thinking') {
        const val = partValue(part);
        if (val) reasoningParts.push(val);
      } else if (part.kind === undefined || part.kind === 'markdownContent') {
        // A rendered markdown text part (the user-visible assistant answer).
        const val = partValue(part);
        if (val) textParts.push(val);
      }
    }
  }

  // Fallback to toolCallRounds when the response array carried no text.
  const rounds = request.result?.metadata?.toolCallRounds;
  if (textParts.length === 0 && Array.isArray(rounds)) {
    for (const round of rounds) {
      if (round && typeof round.response === 'string' && round.response.trim()) {
        textParts.push(round.response);
      }
    }
  }
  if (reasoningParts.length === 0 && Array.isArray(rounds)) {
    for (const round of rounds) {
      if (round && typeof round.thinking === 'string' && round.thinking.trim()) {
        reasoningParts.push(round.thinking);
      }
    }
  }

  return {
    responseText: textParts.length ? textParts.join('\n\n') : null,
    reasoningText: reasoningParts.length ? reasoningParts.join('\n\n') : null,
  };
}

/**
 * Flatten a toolCallResults entry into plain result text.
 * @param {*} entry
 * @returns {string}
 */
function toolResultText(entry) {
  if (entry == null) return '';
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry.content)) {
    return entry.content
      .map((c) => (typeof c === 'string' ? c : c && typeof c.value === 'string' ? c.value : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof entry.value === 'string') return entry.value;
  return '';
}

/** Detect VS Code output-compression markers in tool result text. */
function detectCompression(result) {
  if (!result) return null;
  if (result.includes('since previous poll')) return 'outputDeltas';
  if (result.includes('Output compressed by') || result.includes('Same output as last run')) return 'compressOutput';
  return null;
}

/** Pull the user prompt text from a request's message. */
function messageText(request) {
  const msg = request.message;
  if (!msg) return null;
  if (typeof msg.text === 'string' && msg.text.trim()) return msg.text;
  if (Array.isArray(msg.parts)) {
    const text = msg.parts
      .map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('');
    if (text.trim()) return text;
  }
  return null;
}

/**
 * Parse a chatSessions JSONL file into the same shape as
 * `parseSessionDirectory`, flagged implicitly as an estimated source (no cache,
 * no AIC). Pure function — does not touch the DB.
 *
 * @param {string} filePath - absolute path to chatSessions/<id>.jsonl
 * @param {string} sessionId - session UUID
 * @returns {{
 *   llmCalls: object[], toolCalls: object[], modelSwitches: object[],
 *   userMessages: object[], agentResponses: object[], discoveryEvents: object[],
 *   sessionMeta: {copilotVersion: null, vscodeVersion: null},
 *   firstTs: number|null, lastTs: number|null, totalLines: number,
 *   hasSubagent: boolean, subagentCounts: object, title: string|null,
 *   mode: string|null, initialLocation: string|null, firstPrompt: string|null
 * }}
 */
function parseChatSessionFile(filePath, sessionId) {
  const empty = {
    llmCalls: [], toolCalls: [], modelSwitches: [], userMessages: [],
    agentResponses: [], discoveryEvents: [],
    sessionMeta: { copilotVersion: null, vscodeVersion: null },
    firstTs: null, lastTs: null, totalLines: 0, hasSubagent: false,
    subagentCounts: {}, title: null, mode: null, initialLocation: null, firstPrompt: null,
  };

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return empty;
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  empty.totalLines = lines.length;

  const session = reconstructSession(lines);
  if (!session || !Array.isArray(session.requests)) return empty;

  const llmCalls = [];
  const toolCalls = [];
  const modelSwitches = [];
  const userMessages = [];
  const agentResponses = [];

  let firstTs = null;
  let lastTs = null;
  let prevModel = null;
  let prevInputTokens = null;
  let callNumber = 0;

  session.requests.forEach((request, turnIndex) => {
    if (!request || typeof request !== 'object') return;

    const modelId = typeof request.modelId === 'string'
      ? request.modelId.replace(/^copilot\//, '')
      : (request.result?.metadata?.resolvedModel || null);
    if (!modelId) return; // a request that never ran has no model — skip the LLM call

    const turnNumber = turnIndex;
    const tsMs = typeof request.timestamp === 'number' ? request.timestamp : null;
    const tsSec = tsMs !== null ? Math.floor(tsMs / 1000) : null;
    if (tsSec !== null) {
      if (firstTs === null || tsSec < firstTs) firstTs = tsSec;
      if (lastTs === null || tsSec > lastTs) lastTs = tsSec;
    }

    const metadata = request.result?.metadata || {};
    const inputTokens = parseInt(metadata.promptTokens, 10) || 0;
    // completionTokens (turn-cumulative) is the most accurate output figure.
    const outputTokens = parseInt(request.completionTokens, 10)
      || parseInt(metadata.outputTokens, 10) || 0;

    callNumber++;
    const deltaInput = prevInputTokens !== null ? inputTokens - prevInputTokens : 0;

    llmCalls.push({
      sessionId,
      turnNumber,
      callNumber,
      model: modelId,
      inputTokens,
      cachedTokens: null,   // not present in chatSessions
      cacheWriteTokens: null,
      outputTokens,
      cost: 0,
      aic: null,            // not present in chatSessions → estimated downstream
      timestamp: tsSec,
      debugName: '',
      status: 'ok',
      spanId: null,
      parentSpanId: null,
      ttft: null,
      deltaInput,
      deltaCached: null,
      isSubagent: false,
      systemPromptFile: null,
      toolsFile: null,
      requestOptions: null,
      cacheBreakType: null,
      timeSincePrev: null,
    });

    // User message for this turn.
    const text = messageText(request);
    if (text) {
      userMessages.push({ content: text, ts: tsMs, turnNumber });
    }

    // Assistant response + reasoning.
    const { responseText, reasoningText } = extractResponse(request);
    if (responseText || reasoningText) {
      agentResponses.push({
        sessionId,
        turnNumber,
        responseText,
        reasoningText,
        timestamp: tsSec,
        spanId: null,
        parentSpanId: null,
      });
    }

    // Tool calls from this turn's rounds.
    const rounds = Array.isArray(metadata.toolCallRounds) ? metadata.toolCallRounds : [];
    const results = metadata.toolCallResults || {};
    for (const round of rounds) {
      const calls = round && Array.isArray(round.toolCalls) ? round.toolCalls : [];
      for (const tc of calls) {
        if (!tc || !tc.name) continue;
        const args = typeof tc.arguments === 'string' ? tc.arguments
          : tc.arguments != null ? JSON.stringify(tc.arguments) : '';
        const resultText = toolResultText(results[tc.id]);
        toolCalls.push({
          sessionId,
          turnNumber,
          toolName: tc.name,
          argsPreview: String(args).slice(0, 200),
          argsFull: args || null,
          resultText: resultText || null,
          resultSize: resultText.length,
          status: 'ok',
          linkedLlmCallId: callNumber,
          timestamp: tsSec,
          dur: null,
          parentSpanId: null,
          compressionMethod: detectCompression(resultText),
        });
      }
    }

    // Model switch when the model changes between consecutive turns.
    if (prevModel && prevModel !== modelId) {
      modelSwitches.push({
        sessionId,
        fromModel: prevModel,
        toModel: modelId,
        atCallNumber: callNumber,
        cacheBefore: null,
        cacheAfter: null,
        inputDelta: deltaInput,
        timestamp: tsSec,
      });
    }

    prevModel = modelId;
    prevInputTokens = inputTokens;
  });

  // creationDate is a reasonable session start when requests carry no timestamp.
  if (firstTs === null && typeof session.creationDate === 'number') {
    firstTs = Math.floor(session.creationDate / 1000);
  }

  const mode = session.requests[0]?.modeInfo?.modeId
    || session.requests[0]?.modeInfo?.kind || null;

  return {
    llmCalls,
    toolCalls,
    modelSwitches,
    userMessages,
    agentResponses,
    discoveryEvents: [],
    sessionMeta: { copilotVersion: null, vscodeVersion: null },
    firstTs,
    lastTs,
    totalLines: lines.length,
    hasSubagent: false,
    subagentCounts: {},
    title: typeof session.customTitle === 'string' && session.customTitle ? session.customTitle : null,
    mode,
    initialLocation: session.initialLocation || null,
    firstPrompt: userMessages[0]?.content || null,
  };
}

module.exports = { parseChatSessionFile, reconstructSession, applyPatch };
