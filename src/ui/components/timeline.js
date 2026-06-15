/**
 * @fileoverview Timeline rendering component.
 */

import { store } from '../store.js';
import { escapeHtml, getToolIcon } from '../helpers.js';
import { formatNumber, formatLatency, latencyClass, formatCompact } from '../formatters.js';

/**
 * Build a unified chronological event list from separate arrays.
 * @param {Object} turn
 * @returns {Array}
 */
export function buildLegacyEvents(turn) {
  const events = [];
  for (const msg of turn.userMessages || []) {
    // Floor to whole seconds so a user message ties with its turn's (floored)
    // LLM call rather than sorting just after it on sub-second noise.
    const ts = msg.ts != null ? Math.floor(msg.ts) : msg.ts;
    events.push({ type: 'userMessage', content: msg.content || '', ts, _order: 0 });
  }
  for (const tool of turn.toolCalls || []) {
    events.push({
      type: 'toolCall', toolName: tool.tool_name, argsPreview: tool.args_preview,
      resultSize: tool.result_size, status: tool.status, compressionMethod: tool.compression_method,
      linkedLlmCallId: tool.linked_llm_call_id, ts: tool.timestamp, dur: tool.dur, _order: 1
    });
  }
  for (const call of turn.llmCalls || []) {
    events.push({ type: 'llmCall', ...call, ts: call.timestamp, _order: 2 });
  }
  events.sort((a, b) => {
    if (a.ts != null && b.ts != null) {
      if (a.ts !== b.ts) return a.ts - b.ts;
      return a._order - b._order; // same instant -> user -> tool -> llm
    }
    if (a.ts == null && b.ts != null) return 1;
    if (a.ts != null && b.ts == null) return -1;
    return a._order - b._order;
  });
  return events;
}

function buildDetailHTML(e) {
  if (e.type === 'userMessage') {
    return `<div class="detail-block"><div class="detail-label">Prompt</div><pre class="detail-pre">${escapeHtml(e.content)}</pre></div>`;
  }
  if (e.type === 'toolCall') {
    const llmNote = e.linkedLlmCallId
      ? `<span class="detail-note">This tool\u2019s output was sent as context to LLM call #${e.linkedLlmCallId}</span>` : '';
    return `<div class="detail-grid">
      <div><span class="detail-label">Tool:</span> ${escapeHtml(e.toolName)}</div>
      <div><span class="detail-label">Args:</span> <code>${escapeHtml(e.argsPreview || '\u2014')}</code></div>
      <div><span class="detail-label">Result size:</span> ${formatNumber(e.resultSize)} chars</div>
      <div><span class="detail-label">Status:</span> ${escapeHtml(e.status || 'ok')}</div>
      ${e.compressionMethod ? `<div><span class="detail-label">Compression:</span> ${e.compressionMethod}</div>` : ''}
    </div>${llmNote}`;
  }
  if (e.type === 'llmCall') {
    // Find agent responses for this turn, ordered by timestamp
    const responses = (store.agentResponses || []).filter(r => r.turn_number === e.turn_number);
    if (responses.length === 0) {
      return `<div class="detail-note">No agent response text available for this call.</div>`;
    }

    let html = '';
    for (const resp of responses) {
      const reasoning = resp.reasoning_text || '';
      const response = resp.response_text || '';
      const isEncrypted = reasoning === '[encrypted]';

      // Thinking section (shown BEFORE response — chronological order)
      if (isEncrypted) {
        html += `<div class="detail-block detail-thinking-encrypted"><span class="detail-label">\uD83D\uDD12 Thinking</span> <span class="detail-note-inline">encrypted by provider</span></div>`;
      } else if (reasoning) {
        html += `<div class="detail-block detail-thinking-block">
          <div class="detail-label detail-thinking-toggle" role="button" tabindex="0" aria-expanded="false">\u25B6 Thinking</div>
          <pre class="detail-pre detail-thinking collapsed">${escapeHtml(reasoning)}</pre>
        </div>`;
      }

      // Response section
      if (response) {
        html += `<div class="detail-block"><div class="detail-label">Response</div><pre class="detail-pre">${escapeHtml(response)}</pre></div>`;
      }
    }
    return html;
  }
  return '';
}

/**
 * Render the timeline of turns and events.
 */
export function renderTimeline() {
  const container = document.getElementById('timeline-container');
  if (!container) return;
  container.innerHTML = '';

  const turns = store.turns || [];
  if (turns.length === 0) {
    container.innerHTML = '<div class="empty-message">No turns</div>';
    return;
  }

  for (const turn of turns) {
    const turnNum = turn.turnNumber;
    const calls = turn.llmCalls || [];
    const turnTools = turn.toolCalls || [];
    const turnMsgs = turn.userMessages || [];
    const aicClass = turn.aicClass || '';
    const hasUserMsg = turnMsgs.some(m => m.content);
    const hasSubAgent = calls.some(c => c.debug_name && c.debug_name.toLowerCase().includes('subagent'));
    const totalTokens = calls.reduce((s, c) => s + (c.input_tokens || 0) + (c.output_tokens || 0), 0);
    const aicNum = turn.aicBadge || '';
    // Limited-source (chatSessions): input/cache/cost/AIC are unrecoverable, output
    // is estimated from the response text — render "—"/"~" instead of bare numbers.
    const isLimitedTurn = calls.some(c => c.is_limited_source);
    const turnOutEstimated = calls.some(c => c.output_estimated);

    let promptPreview = '';
    const firstMsg = turnMsgs.find(m => m.content);
    if (firstMsg) promptPreview = firstMsg.content;
    else if (turnNum === 1 && store.sessionDetail?.first_prompt) promptPreview = store.sessionDetail.first_prompt;

    const turnDiv = document.createElement('div');
    turnDiv.className = 'timeline-turn' + (store.timelineExpanded ? '' : ' collapsed') + (aicClass ? ' ' + aicClass : '') + (turn.isCanceled ? ' canceled' : '');
    turnDiv.dataset.tools = turn.toolNames || '';
    turnDiv.dataset.llmCalls = String(calls.length);
    turnDiv.dataset.hasUserMsg = String(hasUserMsg);
    turnDiv.dataset.hasTools = String(turnTools.length > 0);
    turnDiv.dataset.hasModelSwitch = String([...new Set(calls.map(c => c.model))].length > 1);
    turnDiv.dataset.hasSubAgent = String(hasSubAgent);
    turnDiv.setAttribute('role', 'region');
    turnDiv.setAttribute('aria-label', `Turn ${turnNum}`);

    const retryCount = calls.filter(c => c.debug_name && c.debug_name.includes('retry')).length;
    const retryPill = retryCount > 0 ? `<span class="turn-pill retry-pill" title="${retryCount} retry call${retryCount !== 1 ? 's' : ''}">\u21BB ${retryCount}</span>` : '';
    const coldBadge = turn.isColdStart ? '<span class="badge badge-info" title="First turn \u2014 no cache yet">\uD83E\uDDCA cold start</span>' : '';

    const header = document.createElement('div');
    header.className = 'timeline-turn-header';
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.setAttribute('aria-expanded', store.timelineExpanded ? 'true' : 'false');
    header.setAttribute('aria-label', `Turn ${turnNum} - ${calls.length} LLM calls, ${turnTools.length} tools`);
    header.innerHTML = `
      <div class="turn-header-row">
        <span class="turn-chevron" aria-hidden="true">\u25BC</span>
        <span class="turn-title">${turn.isCanceled ? `<span class="canceled-turn">Turn ${turnNum}</span> <span class="canceled-label">canceled</span>` : `Turn ${turnNum}`}</span>
        <span class="turn-summary-pills">
          ${retryPill}
          ${turnTools.length > 0 ? `<span class="turn-pill tool-pill" title="${turnTools.length} tool call${turnTools.length !== 1 ? 's' : ''}">\uD83D\uDD27 ${turnTools.length}</span>` : ''}
          ${calls.length > 0 ? `<span class="turn-pill llm-pill" title="${calls.length} LLM call${calls.length !== 1 ? 's' : ''}">${hasSubAgent ? '\uD83D\uDD17' : '\uD83E\uDD16'} ${calls.length}</span>` : ''}
          ${totalTokens > 0 ? `<span class="turn-pill token-pill" title="${isLimitedTurn ? 'Estimated output tokens' : 'Input + Output tokens'}">${turnOutEstimated ? '~' : ''}${formatCompact(totalTokens)} tok</span>` : ''}
          ${aicNum ? `<span class="turn-pill aic-pill ${aicClass}" title="Total AI Credits this turn">${aicNum} AIC</span>` : ''}
          ${coldBadge}
        </span>
      </div>
      ${promptPreview ? `<div class="turn-prompt-line" title="${escapeHtml(firstMsg?.content || store.sessionDetail?.first_prompt || '')}">${escapeHtml(promptPreview)}</div>` : ''}`;

    header.addEventListener('click', () => {
      const expanded = !turnDiv.classList.contains('collapsed');
      turnDiv.classList.toggle('collapsed');
      header.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    });
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        header.click();
      }
    });
    turnDiv.appendChild(header);

    const body = document.createElement('div');
    body.className = 'timeline-turn-body';

    // Table header
    const thead = document.createElement('div');
    thead.className = 'timeline-thead';
    thead.setAttribute('role', 'row');
    thead.innerHTML = `
      <span role="columnheader"></span>
      <span class="th-step" role="columnheader">#</span>
      <span class="th-icon" role="columnheader"></span>
      <span class="th-name" role="columnheader">Event</span>
      <span class="th-col" role="columnheader" title="Input tokens (LLM) or result size (tool)">Input</span>
      <span class="th-col" role="columnheader" title="Output tokens (LLM) or consuming LLM (tool)">Output</span>
      <span class="th-col" role="columnheader" title="Cached tokens (LLM)">Cache</span>
      <span class="th-col" role="columnheader" title="Input delta from previous LLM call">Delta</span>
      <span class="th-col" role="columnheader" title="TTFT (LLM) or duration (tool)">Latency</span>
      <span class="th-col" role="columnheader" title="AI Credits (actual or ~estimated)">AIC</span>`;
    body.appendChild(thead);

    const events = turn.events || [];
    let step = 1;
    const legacyEvents = events.length > 0 ? events : buildLegacyEvents(turn);

    for (const evt of legacyEvents) {
      const { row, detail } = renderEvent(evt, step);
      if (row) {
        body.appendChild(row);
        if (detail) body.appendChild(detail);
        step++;
      }
    }

    // Fallback for Turn 1 prompt
    if (!legacyEvents.some(e => e.type === 'userMessage') && turnNum === 1 && store.sessionDetail?.first_prompt) {
      const { row, detail } = renderUserMessage({ type: 'userMessage', content: store.sessionDetail.first_prompt }, 1);
      if (row) {
        body.insertBefore(row, body.children[1]); // after thead
        if (detail) body.insertBefore(detail, row.nextSibling);
      }
    }

    // Turn summary row
    if (calls.length > 0 || turnTools.length > 0) {
      const totalInput = calls.reduce((s, c) => s + (c.input_tokens || 0), 0);
      const totalOutput = calls.reduce((s, c) => s + (c.output_tokens || 0), 0);
      const inputCell = (isLimitedTurn && totalInput === 0) ? '—' : formatCompact(totalInput);
      const outputCell = turnOutEstimated
        ? '~' + formatCompact(totalOutput)
        : ((isLimitedTurn && totalOutput === 0) ? '—' : formatCompact(totalOutput));
      const summaryRow = document.createElement('div');
      summaryRow.className = 'timeline-row turn-summary';
      summaryRow.innerHTML = `
        <span></span>
        <span class="step-num"></span>
        <span class="row-icon"></span>
        <span class="row-name turn-summary-label">Turn ${turnNum} total</span>
        <span class="row-col">${inputCell}</span>
        <span class="row-col">${outputCell}</span>
        <span class="row-col">${turnTools.length > 0 ? turnTools.length + ' tools' : '\u2014'}</span>
        <span class="row-col">${calls.length} LLM</span>
        <span class="row-col">\u2014</span>
        <span class="row-col llm-aic ${aicClass}">${turn.aicBadge || '\u2014'}</span>`;
      body.appendChild(summaryRow);
    }

    turnDiv.appendChild(body);
    container.appendChild(turnDiv);
  }
}

// --- Row renderers ---

function renderEvent(evt, step) {
  if (evt.type === 'userMessage') return renderUserMessage(evt, step);
  if (evt.type === 'toolCall') return renderToolCall(evt, step);
  if (evt.type === 'llmCall') return renderLlmCall(evt, step);
  return { row: null, detail: null };
}

function renderUserMessage(evt, step) {
  if (!evt.content) return { row: null, detail: null };
  const row = document.createElement('div');
  row.className = 'timeline-row user-prompt';
  row.dataset.activity = 'userMessage';
  row.setAttribute('role', 'button');
  row.setAttribute('tabindex', '0');
  row.setAttribute('aria-label', `Step ${step}: User message`);
  const preview = evt.content.length > 120 ? evt.content.slice(0, 120) + '\u2026' : evt.content;
  row.innerHTML = `
    <span class="row-chevron" aria-hidden="true">\u25b6</span>
    <span class="step-num">${step}</span>
    <span class="row-icon" aria-hidden="true">\uD83D\uDC64</span>
    <span class="row-name prompt-text">${escapeHtml(preview)}</span>
    <span class="row-col">\u2014</span><span class="row-col">\u2014</span><span class="row-col">\u2014</span>
    <span class="row-col">\u2014</span><span class="row-col">\u2014</span><span class="row-col">\u2014</span>`;
  const detail = makeDetail(evt);
  bindToggle(row, detail);
  return { row, detail };
}

function renderToolCall(evt, step) {
  const row = document.createElement('div');
  row.className = 'timeline-row tool';
  row.dataset.tool = evt.toolName;
  row.setAttribute('role', 'button');
  row.setAttribute('tabindex', '0');
  row.setAttribute('aria-label', `Step ${step}: Tool call ${evt.toolName}`);
  const compression = evt.compressionMethod ? `<span class="tool-compression">[${evt.compressionMethod}]</span>` : '';
  const linkedNum = evt.linkedLlmCallId;
  const linkStr = linkedNum ? `<span class="tool-link" title="Consumed by LLM call #${linkedNum}">\u2192 LLM #${linkedNum}</span>` : '\u2014';
  const durClass = latencyClass(evt.dur);
  row.innerHTML = `
    <span class="row-chevron" aria-hidden="true">\u25b6</span>
    <span class="step-num">${step}</span>
    <span class="row-icon" aria-hidden="true">${getToolIcon(evt.toolName)}</span>
    <span class="row-name"><span class="tool-name">${escapeHtml(evt.toolName)}</span>${compression}</span>
    <span class="row-col tool-result">${formatNumber(evt.resultSize)} chars</span>
    <span class="row-col">${linkStr}</span>
    <span class="row-col">\u2014</span><span class="row-col">\u2014</span>
    <span class="row-col ${durClass}">${formatLatency(evt.dur)}</span>
    <span class="row-col">\u2014</span>`;
  const detail = makeDetail(evt);
  bindToggle(row, detail);
  return { row, detail };
}

function renderLlmCall(call, step) {
  const isSub = call.is_subagent || (call.debug_name && call.debug_name.toLowerCase().includes('subagent')) || false;
  const aicCls = call.aicClass || 'none';
  const row = document.createElement('div');
  row.className = 'timeline-row llm' + (isSub ? ' subagent' : '') + ' ' + aicCls;
  row.dataset.aic = aicCls;
  row.dataset.activity = isSub ? 'subAgent' : 'model';
  row.setAttribute('role', 'button');
  row.setAttribute('tabindex', '0');
  row.setAttribute('aria-label', `Step ${step}: LLM call ${call.model || 'unknown'}`);
  const cached = call.cached_tokens != null ? formatNumber(call.cached_tokens) : '\u2014';
  // Limited-source (chatSessions) calls have no recoverable input \u2014 show "\u2014", not "0".
  // Output is shown with "~" when estimated from the response text.
  const inputStr = (call.is_limited_source && !call.input_tokens) ? '\u2014' : formatNumber(call.input_tokens);
  const outputStr = call.output_estimated
    ? '~' + formatNumber(call.output_tokens)
    : ((call.is_limited_source && !call.output_tokens) ? '\u2014' : formatNumber(call.output_tokens));
  const deltaVal = call.delta_input || 0;
  const deltaSign = deltaVal > 0 ? '+' : '';
  const callAicVal = call.aic > 0 ? (call.aic / 1e9).toFixed(2) : '';
  const callAic = callAicVal ? (call.is_aic_approx ? '~' + callAicVal : callAicVal) : '';
  const subLabel = isSub ? '<span class="badge badge-info">sub</span>' : '';
  const isRetry = call.debug_name && call.debug_name.includes('retry');
  const retryBadge = isRetry ? '<span class="badge badge-warning" title="Retry after error">\u21BB</span> ' : '';
  const coldBadgeRow = (call.cached_tokens == null || call.cached_tokens === 0)
    ? '<span class="badge badge-info" title="No cache \u2014 cold start">\uD83E\uDDCA</span>' : '';
  const ttftClass = latencyClass(call.ttft);
  row.innerHTML = `
    <span class="row-chevron" aria-hidden="true">\u25b6</span>
    <span class="step-num">${step}</span>
    <span class="row-icon" aria-hidden="true">\uD83E\uDD16</span>
    <span class="row-name">${subLabel}${escapeHtml(call.model)} ${retryBadge}</span>
    <span class="row-col">${inputStr}</span>
    <span class="row-col">${outputStr}</span>
    <span class="row-col">${cached}</span>
    <span class="row-col delta-${deltaVal > 0 ? 'up' : 'same'}">${deltaSign}${formatNumber(deltaVal)}</span>
    <span class="row-col ${ttftClass}">${call.ttft > 10000 ? '<span class="ttft-warn" title="Slow response \u2014 TTFT >10s">\u26A0\uFE0F</span>' : ''}${formatLatency(call.ttft)}</span>
    <span class="row-col llm-aic ${aicCls}">${coldBadgeRow}${callAic || '\u2014'}</span>`;
  const detail = makeDetail(call);
  bindToggle(row, detail);
  return { row, detail };
}

// --- Helpers ---

function makeDetail(evt) {
  const detail = document.createElement('div');
  detail.className = 'timeline-detail collapsed';
  detail.setAttribute('role', 'region');
  detail.innerHTML = buildDetailHTML(evt);

  // Bind thinking toggle(s) via event delegation
  detail.querySelectorAll('.detail-thinking-toggle').forEach(toggle => {
    const pre = toggle.nextElementSibling;
    if (!pre) return;
    const handler = () => {
      const isCollapsed = pre.classList.toggle('collapsed');
      toggle.textContent = (isCollapsed ? '\u25B6' : '\u25BC') + ' Thinking';
      toggle.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    };
    toggle.addEventListener('click', handler);
    toggle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); }
    });
  });

  return detail;
}

function bindToggle(row, detail) {
  const chevron = row.querySelector('.row-chevron');
  const toggle = () => {
    const isCollapsed = detail.classList.toggle('collapsed');
    if (chevron) chevron.style.transform = isCollapsed ? '' : 'rotate(90deg)';
  };
  row.addEventListener('click', toggle);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
}
