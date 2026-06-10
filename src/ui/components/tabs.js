/**
 * @fileoverview Tab content renderers: Tools, Model Switches, Retries, Cache Sparkline.
 */

import { store } from '../store.js';
import { escapeHtml } from '../helpers.js';
import { formatNumber, formatLatency, latencyClass, formatCompact } from '../formatters.js';
import { renderTableBody, renderTable } from './table.js';

/**
 * Render the session tools tab table.
 */
export function renderSessionTools() {
  const tbody = document.getElementById('tools-table-body');
  if (!tbody) return;
  const tools = (store.toolLeaderboard || []).map(t => ({
    ...t,
    avg_result_size: t.avg_result_size ? Math.round(t.avg_result_size) : 0,
    compression_count: t.compression_count || 0
  }));
  tbody.innerHTML = renderTableBody({
    columns: [
      { label: 'Tool', key: 'tool_name', format: v => escapeHtml(v) },
      { label: 'Calls', key: 'calls', numeric: true, format: v => formatNumber(v) },
      { label: 'Total Size', key: 'total_result_size', numeric: true, format: v => formatNumber(v) },
      { label: 'Avg Size', key: 'avg_result_size', numeric: true, format: v => formatNumber(v) },
      { label: 'Max Size', key: 'max_result_size', numeric: true, format: v => formatNumber(v) },
      { label: 'Compressed', key: 'compression_count', numeric: true, format: v => formatNumber(v) }
    ],
    data: tools,
    emptyMessage: 'No tool calls'
  });
}

/**
 * Render the model switches tab table.
 */
export function renderSessionModelSwitches() {
  const tbody = document.getElementById('models-table-body');
  if (!tbody) return;
  const switches = (store.modelSwitches || []).map((sw, i) => ({
    ...sw,
    _index: i + 1,
    _preserved: (sw.cache_before != null && sw.cache_before > 0)
      ? ((sw.cache_after != null ? sw.cache_after : 0) / sw.cache_before * 100).toFixed(1) + '%'
      : '\u2014',
    _inputDelta: sw.input_delta != null ? (sw.input_delta > 0 ? '+' : '') + formatNumber(sw.input_delta) : '\u2014'
  }));
  tbody.innerHTML = renderTableBody({
    columns: [
      { label: '#', key: '_index' },
      { label: 'From', key: 'from_model', format: v => escapeHtml(v || '\u2014') },
      { label: 'To', key: 'to_model', format: v => escapeHtml(v || '\u2014') },
      { label: 'At Call', key: 'at_call_number', numeric: true, format: v => v || '\u2014' },
      { label: 'Cache Before', key: 'cache_before', numeric: true, format: v => v != null ? formatNumber(v) : '\u2014' },
      { label: 'Cache After', key: 'cache_after', numeric: true, format: v => v != null ? formatNumber(v) : '\u2014' },
      { label: 'Preserved', key: '_preserved', numeric: true },
      { label: 'Input \u0394', key: '_inputDelta', numeric: true }
    ],
    data: switches,
    emptyMessage: 'No model switches'
  });
}

/**
 * Render the retry/failover report tab.
 */
export function renderRetryReport() {
  const container = document.getElementById('retry-report');
  if (!container) return;
  const calls = store.llmCalls || [];
  const retries = calls.filter(c => c.debug_name && c.debug_name.includes('retry'));
  if (retries.length === 0) {
    container.innerHTML = '<div class="empty-message">No retry or failover calls in this session</div>';
    return;
  }
  const totalRetryAic = retries.reduce((s, c) => s + (c.aic || 0), 0);
  const totalRetryTokens = retries.reduce((s, c) => s + (c.input_tokens || 0) + (c.output_tokens || 0), 0);

  const tableHtml = renderTable({
    columns: [
      { label: '#', key: 'call_number', numeric: true },
      { label: 'Turn', key: 'turn_number', numeric: true, format: v => v || '\u2014' },
      { label: 'Model', key: 'model', format: v => escapeHtml(v) },
      { label: 'Input', key: 'input_tokens', numeric: true, format: v => formatNumber(v) },
      { label: 'Output', key: 'output_tokens', numeric: true, format: v => formatNumber(v) },
      { label: 'TTFT', key: 'ttft', numeric: true, format: (v) => `<span class="${latencyClass(v)}">${formatLatency(v)}</span>` },
      { label: 'AIC', key: 'aic', numeric: true, format: (v, row) => {
        const aicVal = v > 0 ? (v / 1e9).toFixed(2) : '\u2014';
        const aicClass = row.aicClass || 'none';
        return `<span class="llm-aic ${aicClass}">${aicVal}</span>`;
      }}
    ],
    data: retries,
    emptyMessage: 'No retry or failover calls'
  });

  container.innerHTML = `
    <div class="retry-summary" role="region" aria-label="Retry summary">
      <div class="retry-stat">
        <span class="retry-stat-label">Retry calls</span>
        <span class="retry-stat-value">${retries.length}</span>
      </div>
      <div class="retry-stat">
        <span class="retry-stat-label">Retry tokens</span>
        <span class="retry-stat-value">${formatCompact(totalRetryTokens)}</span>
      </div>
      <div class="retry-stat">
        <span class="retry-stat-label">Retry AIC</span>
        <span class="retry-stat-value">${(totalRetryAic / 1e9).toFixed(2)}</span>
      </div>
    </div>
    ${tableHtml}`;
}

/**
 * Render the cache sparkline chart.
 */
export function renderCacheSparkline() {
  const canvas = document.getElementById('cache-sparkline');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const calls = store.llmCalls.filter(c => c.cached_tokens != null);

  const callsWithDataEl = document.getElementById('cache-calls-with-data');
  if (callsWithDataEl) callsWithDataEl.textContent = calls.length + ' / ' + store.llmCalls.length;

  let breaks = 0;
  const breakDetails = [];
  for (let i = 1; i < calls.length; i++) {
    if (calls[i].cached_tokens < calls[i - 1].cached_tokens) {
      breaks++;
      breakDetails.push({
        call: i + 1,
        before: calls[i - 1].cached_tokens,
        after: calls[i].cached_tokens,
        drop: calls[i - 1].cached_tokens - calls[i].cached_tokens,
        model: calls[i].model
      });
    }
  }

  const breaksEl = document.getElementById('cache-breaks');
  if (breaksEl) {
    // Show total + type breakdown if classified data is available
    const classified = calls.filter(c => c.cache_break_type);
    if (classified.length > 0) {
      const byType = {};
      for (const c of classified) {
        byType[c.cache_break_type] = (byType[c.cache_break_type] || 0) + 1;
      }
      const parts = Object.entries(byType)
        .sort((a, b) => b[1] - a[1])
        .map(([type, cnt]) => {
          const badge = CACHE_BREAK_BADGES[type];
          return badge ? `${badge.icon} ${cnt} ${badge.label}` : `${cnt} ${type}`;
        });
      breaksEl.textContent = classified.length + ' (' + parts.join(', ') + ')';
    } else {
      breaksEl.textContent = breaks;
    }
  }

  renderCacheTable();

  if (calls.length < 2) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--muted');
    ctx.font = '14px sans-serif';
    ctx.fillText('Not enough cache data', 10, 60);
    return;
  }

  const w = canvas.width, h = canvas.height, padding = 20;
  const maxCached = Math.max(...calls.map(c => c.cached_tokens));
  const minCached = Math.min(...calls.map(c => c.cached_tokens));
  const range = maxCached - minCached || 1;

  const breakIndices = [];
  for (let i = 1; i < calls.length; i++) {
    if (calls[i].cached_tokens < calls[i - 1].cached_tokens) breakIndices.push(i);
  }

  ctx.clearRect(0, 0, w, h);

  // Grid lines
  ctx.strokeStyle = getComputedStyle(canvas).getPropertyValue('--border');
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = padding + (h - 2 * padding) * (i / 4);
    ctx.beginPath(); ctx.moveTo(padding, y); ctx.lineTo(w - padding, y); ctx.stroke();
  }

  // Line
  ctx.strokeStyle = getComputedStyle(canvas).getPropertyValue('--accent');
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < calls.length; i++) {
    const x = padding + (w - 2 * padding) * (i / (calls.length - 1));
    const y = padding + (h - 2 * padding) * (1 - (calls[i].cached_tokens - minCached) / range);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Points
  ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--accent');
  for (let i = 0; i < calls.length; i++) {
    const x = padding + (w - 2 * padding) * (i / (calls.length - 1));
    const y = padding + (h - 2 * padding) * (1 - (calls[i].cached_tokens - minCached) / range);
    ctx.beginPath(); ctx.arc(x, y, breakIndices.includes(i) ? 5 : 3, 0, Math.PI * 2); ctx.fill();
  }

  // Break markers
  if (breakIndices.length > 0) {
    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--error');
    for (const idx of breakIndices) {
      const x = padding + (w - 2 * padding) * (idx / (calls.length - 1));
      const y = padding + (h - 2 * padding) * (1 - (calls[idx].cached_tokens - minCached) / range);
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = getComputedStyle(canvas).getPropertyValue('--error');
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, y);
      const prevY = padding + (h - 2 * padding) * (1 - (calls[idx - 1].cached_tokens - minCached) / range);
      ctx.lineTo(x, prevY);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

/**
 * Cache break type → badge config.
 */
const CACHE_BREAK_BADGES = {
  compaction:            { cls: 'badge-warning', icon: '\uD83D\uDD04', label: 'Compaction',        tip: 'Conversation trimmed to fit context window' },
  model_switch:          { cls: 'badge-info',    icon: '\uD83D\uDD00', label: 'Model Switch',      tip: 'Cache invalidated by model change' },
  subagent_boundary:     { cls: 'badge-info',    icon: '\uD83D\uDD17', label: 'Subagent',          tip: 'Switched to/from subagent' },
  system_prompt_change:  { cls: 'badge-warning', icon: '\u2699\uFE0F', label: 'Sys Prompt',        tip: 'System prompt was rebuilt' },
  tools_changed:         { cls: 'badge-warning', icon: '\uD83D\uDEE0', label: 'Tools Changed',     tip: 'Tool definitions changed between requests' },
  options_changed:       { cls: 'badge-info',    icon: '\u2699',       label: 'Options Changed',   tip: 'Request options changed (e.g. reasoning.effort, include)' },
  retry:                 { cls: 'badge-error',   icon: '\u21BB',       label: 'Retry',             tip: 'Cache lost after failed call was retried' },
  provider_eviction:     { cls: 'badge-muted',   icon: '\u26A0',       label: 'Possible Eviction', tip: 'No clear cause found — likely provider cache expiration (e.g. TTL)' }
};

/**
 * Render the per-call cache table in the Cache tab.
 */
export function renderCacheTable() {
  const tbody = document.getElementById('cache-table-body');
  if (!tbody) return;

  const calls = (store.llmCalls || []).filter(c => c.cached_tokens != null);
  if (calls.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-message">No cache data</td></tr>';
    return;
  }

  // Use DB-computed cache_break_type when available, fall back to client-side detection
  const breakRows = [];
  let prevCached = null;
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    const cached = c.cached_tokens || 0;
    const input = c.input_tokens || 0;
    const isColdStart = i === 0;

    if (c.cache_break_type) {
      const delta = c.delta_cached || (prevCached != null ? cached - prevCached : 0);
      const hitPct = input > 0 ? ((cached / input) * 100).toFixed(1) : '0.0';
      breakRows.push({ c, delta, hitPct });
    } else if (!isColdStart && prevCached != null && cached < prevCached * 0.8) {
      const delta = cached - prevCached;
      const hitPct = input > 0 ? ((cached / input) * 100).toFixed(1) : '0.0';
      breakRows.push({ c, delta, hitPct });
    }
    prevCached = cached;
  }

  if (breakRows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-message">No cache breaks detected</td></tr>';
    return;
  }

  tbody.innerHTML = breakRows.map(({ c, delta, hitPct }) => {
    const deltaStr = (delta >= 0 ? '+' : '') + formatCompact(delta);
    const badge = CACHE_BREAK_BADGES[c.cache_break_type];
    const gap = c.time_since_prev;
    const gapStr = gap != null ? (gap >= 60 ? Math.round(gap / 60) + 'm' : gap + 's') : '';
    const tipExtra = gap != null ? ` (${gapStr} since prev call)` : '';
    const gapSuffix = gap != null && c.cache_break_type === 'provider_eviction' ? ` <span class="cache-gap">${gapStr}</span>` : '';
    const badgeHtml = badge
      ? `<span class="badge ${badge.cls}" title="${badge.tip}${tipExtra}">${badge.icon} ${badge.label}${gapSuffix}</span>`
      : `<span class="badge badge-error" title="Significant cache drop">\u26A0 break</span>`;
    return `<tr>
      <td class="numeric">${c.turn_number || '—'}</td>
      <td class="numeric">${c.call_number}</td>
      <td>${escapeHtml(c.model || 'unknown')}</td>
      <td class="numeric">${formatCompact(c.input_tokens || 0)}</td>
      <td class="numeric value-success">${formatCompact(c.cached_tokens || 0)}</td>
      <td class="numeric">${deltaStr}</td>
      <td class="numeric">${hitPct}%</td>
      <td>${badgeHtml}</td>
    </tr>`;
  }).join('');
}

/**
 * Render the Conversation tab — Slack-style full-width message list.
 */
export function renderConversation() {
  const container = document.getElementById('conversation-container');
  if (!container) return;
  const allMsgs = store.conversation || [];

  // Filter out empty messages
  const msgs = allMsgs.filter(m => m.content && m.content.trim());

  if (msgs.length === 0) {
    container.innerHTML = '<p class="empty-state">No transcript data available for this session.</p>';
    return;
  }

  const userCount = msgs.filter(m => m.role === 'user').length;
  const assistantCount = msgs.filter(m => m.role === 'assistant').length;

  container.innerHTML = `<div class="convo-header">${userCount} user message${userCount !== 1 ? 's' : ''}, ${assistantCount} assistant response${assistantCount !== 1 ? 's' : ''}</div>`;

  for (const msg of msgs) {
    const row = document.createElement('div');
    row.className = `convo-msg convo-${msg.role}`;
    const content = msg.content.trim();
    const isLong = content.length > 500;
    const preview = isLong ? content.slice(0, 500) + '\u2026' : content;
    const icon = msg.role === 'user' ? '\uD83D\uDC64' : '\uD83E\uDD16';
    const label = msg.role === 'user' ? 'You' : 'Copilot';
    row.innerHTML = `
      <div class="convo-meta">
        <span class="convo-icon">${icon}</span>
        <span class="convo-name">${label}</span>
      </div>
      <div class="convo-text">${escapeHtml(preview)}</div>`;
    if (isLong) {
      const expandBtn = document.createElement('button');
      expandBtn.className = 'convo-expand btn btn-secondary btn-sm';
      expandBtn.textContent = `Show full (${Math.round(content.length / 1000)}K chars)`;
      expandBtn.addEventListener('click', () => {
        const textEl = row.querySelector('.convo-text');
        const expanded = expandBtn.dataset.expanded === '1';
        textEl.textContent = expanded ? preview : content;
        expandBtn.textContent = expanded ? `Show full (${Math.round(content.length / 1000)}K chars)` : 'Collapse';
        expandBtn.dataset.expanded = expanded ? '0' : '1';
      });
      row.appendChild(expandBtn);
    }
    container.appendChild(row);
  }
}
