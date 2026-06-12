/**
 * @fileoverview Dashboard rendering component.
 */

import { store } from '../store.js';
import { escapeHtml } from '../helpers.js';
import { formatNumber, formatCost, formatCompact, formatNumberWithCommas } from '../formatters.js';
import { computeFilteredSessions, computeFilteredDaily } from '../filters.js';
import { renderModelCard } from './modelCard.js';
import { renderTableBody } from './table.js';

/**
 * Render the aggregate dashboard view.
 */
export function renderDashboard() {
  const filtered = computeFilteredSessions();
  const d = store.dashboardData;

  const totalSessions = filtered.length;
  const totalCalls = filtered.reduce((s, x) => s + (x.total_llm_calls || 0), 0);
  const totalInput = filtered.reduce((s, x) => s + (x.total_input_tokens || 0), 0);
  const totalOutput = filtered.reduce((s, x) => s + (x.total_output_tokens || 0), 0);
  const totalCached = filtered.reduce((s, x) => s + (x.total_cached_tokens || 0), 0);
  const totalAic = filtered.reduce((s, x) => s + (x.computed_aic || 0), 0);
  const totalCost = filtered.reduce((s, x) => s + (x.computed_cost || 0), 0);
  const approxCount = filtered.filter(x => x.is_aic_approx).length;
  const aicApprox = approxCount > 0;
  const aicPrefix = aicApprox ? '~' : '';
  const hasLimited = filtered.some(x => x.data_quality === 'limited');
  const costPrefix = hasLimited ? '~' : '';

  // Header stats
  setText('dash-session-count', totalSessions);
  const aicHeader = totalAic > 0 ? aicPrefix + formatNumberWithCommas((totalAic / 1e9).toFixed(2)) + ' AIC' : '\u2014 AIC';
  const costHeader = totalCost > 0 ? costPrefix + '$' + totalCost.toFixed(4) : '\u2014';
  const headerAicEl = document.getElementById('dash-total-aic');
  if (headerAicEl) {
    headerAicEl.textContent = aicHeader;
    if (aicApprox) headerAicEl.title = `${approxCount} session(s) estimated from token ratio; actual AIC may differ`;
    else headerAicEl.removeAttribute('title');
  }
  setText('dash-total-cost', costHeader);

  // Summary cards
  setCardValue('dash-calls', formatNumber(totalCalls), 'card-value');
  setCardValue('dash-input', formatCompact(totalInput), 'card-value');
  setCardValue('dash-output', formatCompact(totalOutput), 'card-value');
  setCardValue('dash-cached', formatCompact(totalCached), 'card-value value-success');
  setCardValue('dash-cost', costPrefix + formatCost(totalCost), 'card-value value-accent');

  const aicEl = document.getElementById('dash-aic');
  if (aicEl) {
    const aicCardText = totalAic > 0 ? (aicApprox ? '~' : '') + formatNumberWithCommas((totalAic / 1e9).toFixed(2)) : '\u2014';
    aicEl.textContent = aicCardText;
    aicEl.className = 'card-value value-aic';
    if (aicApprox) aicEl.title = `${approxCount} session(s) estimated from token ratio`;
    else aicEl.removeAttribute('title');
  }

  // Model breakdown
  renderModelBreakdown(filtered, d);

  // Workspace table
  renderWorkspaceTable(filtered);

  // Tool table
  renderToolTable(filtered, d);

  // Activity chart
  renderDailyChart(computeFilteredDaily(filtered));
}

// --- Sub-renderers ---

function renderModelBreakdown(filtered, d) {
  const container = document.getElementById('dash-model-breakdown');
  if (!container) return;
  if (!d?.modelsBySession) {
    container.innerHTML = emptyMsg('No model data');
    return;
  }
  const filteredIds = new Set(filtered.map(s => s.session_id));
  const modelAgg = {};
  for (const m of d.modelsBySession) {
    if (!filteredIds.has(m.session_id)) continue;
    const key = m.model || 'unknown';
    if (!modelAgg[key]) modelAgg[key] = { model: key, calls: 0, cost: 0, aic: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, vendor: m.vendor || '' };
    modelAgg[key].calls += m.calls || 0;
    modelAgg[key].cost += m.cost || 0;
    modelAgg[key].aic += m.aic || 0;
    modelAgg[key].input_tokens += m.input_tokens || 0;
    modelAgg[key].output_tokens += m.output_tokens || 0;
    modelAgg[key].cached_tokens += m.cached_tokens || 0;
  }
  const modelList = Object.values(modelAgg).sort((a, b) => (b.aic || b.cost) - (a.aic || a.cost));
  if (modelList.length === 0) {
    container.innerHTML = emptyMsg('No model data');
    return;
  }
  const subCounts = {};
  for (const s of filtered) {
    if (s.subagent_counts_json) {
      try {
        const counts = JSON.parse(s.subagent_counts_json);
        for (const [model, count] of Object.entries(counts)) {
          subCounts[model] = (subCounts[model] || 0) + count;
        }
      } catch { /* ignore */ }
    }
  }
  container.innerHTML = modelList.map(m => renderModelCard(m, { subagentCounts: subCounts, showAic: true, showCacheWrite: false, applyAicColor: false })).join('');
}

function renderWorkspaceTable(filtered) {
  const tbody = document.getElementById('dash-all-workspaces');
  if (!tbody) return;
  const wsMap = {};
  for (const s of filtered) {
    const key = s.workspace_path || 'unknown';
    if (!wsMap[key]) wsMap[key] = { path: key, _name: key.split('/').pop() || key, sessions: 0, calls: 0 };
    wsMap[key].sessions++;
    wsMap[key].calls += s.total_llm_calls || 0;
  }
  tbody.innerHTML = renderTableBody({
    columns: [
      { label: 'Workspace', key: '_name', format: v => escapeHtml(v) },
      { label: 'Sessions', key: 'sessions', numeric: true, format: v => formatNumber(v) },
      { label: 'Calls', key: 'calls', numeric: true, format: v => formatNumber(v) }
    ],
    data: Object.values(wsMap).sort((a, b) => b.sessions - a.sessions),
    emptyMessage: 'No data'
  });
}

function renderToolTable(filtered, d) {
  const tbody = document.getElementById('dash-all-tools');
  if (!tbody || !d?.toolsBySession) return;
  const filteredIds = new Set(filtered.map(s => s.session_id));
  const toolAgg = {};
  for (const t of d.toolsBySession) {
    if (!filteredIds.has(t.session_id)) continue;
    const name = t.tool_name || 'unknown';
    if (!toolAgg[name]) toolAgg[name] = { tool_name: name, calls: 0, total_size: 0 };
    toolAgg[name].calls += t.calls || 0;
    toolAgg[name].total_size += t.total_size || 0;
  }
  tbody.innerHTML = renderTableBody({
    columns: [
      { label: 'Tool', key: 'tool_name', format: v => escapeHtml(v) },
      { label: 'Calls', key: 'calls', numeric: true, format: v => formatNumber(v) },
      { label: 'Total Size', key: 'total_size', numeric: true, format: v => formatNumber(v) }
    ],
    data: Object.values(toolAgg).sort((a, b) => b.calls - a.calls),
    emptyMessage: 'No data'
  });
}

/**
 * Render the daily activity bar chart.
 * @param {Array} dailyData
 */
export function renderDailyChart(dailyData) {
  const container = document.getElementById('dash-daily-chart');
  const labelEl = document.getElementById('dash-activity-label');
  if (!container) return;
  if (!dailyData || dailyData.length === 0) {
    container.innerHTML = emptyMsg('No activity data');
    if (labelEl) labelEl.textContent = 'Activity';
    return;
  }
  if (labelEl && dailyData.length > 0) {
    const days = dailyData.map(d => d.day).sort();
    const from = days[0], to = days[days.length - 1];
    labelEl.textContent = from === to ? `Activity (${from})` : `Activity (${from} \u2014 ${to})`;
  }
  const reversed = [...dailyData].reverse();
  const maxCalls = Math.max(...reversed.map(d => d.calls || 0), 1);
  const barHeight = (call) => Math.max(4, (call / maxCalls) * 120);
  const html = reversed.map(d => {
    const h = barHeight(d.calls || 0);
    return `<div class="daily-bar" style="height:${h}px;" title="${d.day}: ${formatNumber(d.calls || 0)} calls, $${(d.cost || 0).toFixed(4)}" role="img" aria-label="${d.day}: ${d.calls || 0} calls"></div>`;
  }).join('');
  container.innerHTML = `<div class="daily-chart-bars" role="img" aria-label="Daily activity chart">${html}</div>`;
}

// --- Helpers ---

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function setCardValue(id, text, className) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = text;
    el.className = className;
  }
}

function emptyMsg(text) {
  return `<div class="empty-message">${escapeHtml(text)}</div>`;
}
