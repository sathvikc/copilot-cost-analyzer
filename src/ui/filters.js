/**
 * @fileoverview Session filtering, time presets, and timeline filter logic.
 */

import { store } from './store.js';
import { getToolIcon } from './helpers.js';

// ---------------------------------------------------------------------------
// Time preset helpers
// ---------------------------------------------------------------------------

/**
 * Get the date range for a time preset and offset.
 * @param {string} preset - 'today'|'week'|'month'|'all'|'custom'
 * @param {number} offset
 * @returns {{ from: number|null, to: number|null, label: string }}
 */
export function getPresetRange(preset, offset = 0) {
  const now = new Date();
  const start = new Date(now);

  if (preset === 'today') {
    start.setDate(start.getDate() + offset);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    return { from: start.getTime() / 1000, to: end.getTime() / 1000, label: fmtRange(preset, start, end) };
  }
  if (preset === 'week') {
    const day = start.getDay();
    const diff = start.getDate() - day + (day === 0 ? -6 : 1);
    start.setDate(diff + offset * 7);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);
    return { from: start.getTime() / 1000, to: end.getTime() / 1000, label: fmtRange(preset, start, end) };
  }
  if (preset === 'month') {
    start.setMonth(start.getMonth() + offset, 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setMonth(start.getMonth() + 1, 0);
    end.setHours(23, 59, 59, 999);
    return { from: start.getTime() / 1000, to: end.getTime() / 1000, label: fmtRange(preset, start, end) };
  }
  return { from: null, to: null, label: 'All time' };
}

function fmtRange(preset, start, end) {
  const fmt = { month: 'short', day: 'numeric' };
  if (preset === 'today') return start.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  return start.toLocaleDateString(undefined, fmt) + ' \u2013 ' + end.toLocaleDateString(undefined, fmt);
}

// ---------------------------------------------------------------------------
// Session filtering
// ---------------------------------------------------------------------------

/**
 * Compute filtered sessions based on search, workspace, and time filters.
 * @returns {Array}
 */
export function computeFilteredSessions() {
  const search = store.filterSearch.toLowerCase();
  const workspace = store.filterWorkspace;
  let range;
  if (store.timePreset === 'custom') {
    range = {
      from: store.filterDateFrom ? new Date(store.filterDateFrom).getTime() / 1000 : null,
      to: store.filterDateTo ? new Date(store.filterDateTo).getTime() / 1000 + 86400 : null
    };
  } else {
    range = getPresetRange(store.timePreset, store.timeOffset);
  }
  return store.sessions.filter(s => {
    const matchSearch = !search ||
      (s.session_id || '').toLowerCase().includes(search) ||
      (s.title || '').toLowerCase().includes(search) ||
      (s.workspace_path || '').toLowerCase().includes(search);
    const matchWs = !workspace || s.workspace_path === workspace;
    const matchFrom = !range.from || (s.start_time && s.start_time >= range.from);
    const matchTo = !range.to || (s.start_time && s.start_time <= range.to);
    return matchSearch && matchWs && matchFrom && matchTo;
  });
}

/**
 * Compute daily aggregates from filtered sessions (last 30 days).
 * @param {Array} sessions
 * @returns {Array<{ day: string, sessions: number, calls: number, cost: number, aic: number }>}
 */
export function computeFilteredDaily(sessions) {
  const byDay = {};
  for (const s of sessions) {
    if (!s.start_time) continue;
    const day = new Date(s.start_time * 1000).toISOString().split('T')[0];
    if (!byDay[day]) byDay[day] = { day, sessions: 0, calls: 0, cost: 0, aic: 0 };
    byDay[day].sessions++;
    byDay[day].calls += s.total_llm_calls || 0;
    byDay[day].cost += s.computed_cost || 0;
    byDay[day].aic += s.computed_aic || 0;
  }
  return Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)).slice(-30);
}

/**
 * Clamp the time offset to prevent navigating beyond data boundaries.
 */
export function clampTimeOffset() {
  if (store.timePreset === 'all' || store.sessions.length === 0) return;
  const times = store.sessions.map(s => s.start_time).filter(Boolean);
  if (times.length === 0) return;
  const range = getPresetRange(store.timePreset, store.timeOffset);
  if (!range.from || !range.to) return;
  const now = Date.now() / 1000;
  if (range.from > now) store.timeOffset--;
  if (range.from < Math.min(...times) - 86400 * 30) store.timeOffset++;
}

/**
 * Update the time range label in the UI.
 */
export function updateTimeLabel() {
  const label = document.getElementById('time-range-label');
  if (!label) return;
  if (store.timePreset === 'custom') {
    label.textContent = (store.filterDateFrom || '\u2014') + ' \u2013 ' + (store.filterDateTo || '\u2014');
  } else if (store.timePreset === 'all') {
    label.textContent = 'All time';
  } else {
    label.textContent = getPresetRange(store.timePreset, store.timeOffset).label;
  }
}

// ---------------------------------------------------------------------------
// Timeline filter UI
// ---------------------------------------------------------------------------

/**
 * Rebuild tool filter checkboxes from current tool calls.
 */
export function rebuildToolFilters() {
  const panel = document.getElementById('filter-tools-panel');
  if (!panel) return;
  panel.innerHTML = '';
  const uniqueTools = [...new Set((store.toolCalls || []).map(t => t.tool_name))].sort();

  const selectAllLabel = document.createElement('label');
  selectAllLabel.className = 'filter-select-all';
  selectAllLabel.innerHTML = '<input type="checkbox" class="select-all" aria-label="Select all tools"> <strong>Select All</strong>';
  panel.appendChild(selectAllLabel);

  const divider = document.createElement('div');
  divider.className = 'filter-divider';
  panel.appendChild(divider);

  for (const tool of uniqueTools) {
    const label = document.createElement('label');
    const escaped = String(tool).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    label.innerHTML = `<input type="checkbox" value="${escaped}" aria-label="Filter ${escaped}"> ${getToolIcon(tool)} ${escaped}`;
    panel.appendChild(label);
  }
  attachFilterListeners();
  updateFilterCounts();
  applyFilters();
}

/**
 * Attach change listeners to all filter checkboxes.
 */
export function attachFilterListeners() {
  document.querySelectorAll('.filter-panel input[type="checkbox"]:not(.select-all)').forEach(cb => {
    cb.removeEventListener('change', onFilterChange);
    cb.addEventListener('change', onFilterChange);
  });
  document.querySelectorAll('.filter-panel .select-all').forEach(sa => {
    sa.removeEventListener('change', onSelectAllChange);
    sa.addEventListener('change', onSelectAllChange);
  });
}

function onSelectAllChange(e) {
  const panel = e.target.closest('.filter-panel');
  if (!panel) return;
  panel.querySelectorAll('input[type="checkbox"]:not(.select-all)').forEach(cb => {
    cb.checked = e.target.checked;
  });
  updateFilterCounts();
  applyFilters();
}

function onFilterChange(e) {
  const panel = e.target.closest('.filter-panel');
  if (panel) {
    const all = panel.querySelectorAll('input[type="checkbox"]:not(.select-all)');
    const checked = panel.querySelectorAll('input[type="checkbox"]:not(.select-all):checked');
    const sa = panel.querySelector('.select-all');
    if (sa) sa.checked = all.length > 0 && all.length === checked.length;
  }
  updateFilterCounts();
  applyFilters();
}

/**
 * Update filter count badges on each dropdown.
 */
export function updateFilterCounts() {
  document.querySelectorAll('.filter-dropdown').forEach(dd => {
    const checked = dd.querySelectorAll('input[type="checkbox"]:not(.select-all):checked');
    const total = dd.querySelectorAll('input[type="checkbox"]:not(.select-all)');
    const countEl = dd.querySelector('.filter-count');
    if (countEl) {
      countEl.textContent = checked.length === total.length ? 'All' : `${checked.length}/${total.length}`;
    }
  });
}

/**
 * Apply timeline filters to show/hide rows within turns.
 */
export function applyFilters() {
  const container = document.getElementById('timeline-container');
  const turns = container?.querySelectorAll('.timeline-turn');
  if (!turns) return;

  const aicChecked = getCheckedValues('#filter-aic');
  const aicAllChecked = isAllChecked('#filter-aic');
  const toolChecked = getCheckedValues('#filter-tools');
  const toolAllChecked = isAllChecked('#filter-tools');
  const toolNoneChecked = toolChecked.length === 0;
  const activityChecked = getCheckedValues('#filter-activity');
  const activityAllChecked = isAllChecked('#filter-activity');

  turns.forEach(turn => {
    turn.querySelectorAll('.timeline-row.llm').forEach(row => {
      const rowAic = row.dataset.aic || 'none';
      const isSub = row.classList.contains('subagent');
      const aicMatch = aicAllChecked || aicChecked.includes(rowAic);
      const activityMatch = activityAllChecked
        || (isSub && activityChecked.includes('hasSubAgent'))
        || (!isSub && activityChecked.includes('hasModels'));
      row.style.display = (aicMatch && activityMatch) ? '' : 'none';
    });

    turn.querySelectorAll('.timeline-row.tool').forEach(row => {
      const name = row.dataset.tool;
      if (toolAllChecked) row.style.display = '';
      else if (toolNoneChecked) row.style.display = 'none';
      else row.style.display = toolChecked.includes(name) ? '' : 'none';
    });

    const showUserMsg = activityAllChecked || activityChecked.includes('hasUserMessage');
    turn.querySelectorAll('.timeline-row.user-prompt').forEach(r => { r.style.display = showUserMsg ? '' : 'none'; });

    const anyVisible = [...turn.querySelectorAll('.timeline-row')].some(r => r.style.display !== 'none');
    turn.style.display = anyVisible ? '' : 'none';
  });

  // Toggle thinking visibility via CSS class on container
  const showThinking = activityChecked.includes('showThinking');
  container.classList.toggle('hide-thinking', !showThinking);
}

// --- Filter helpers ---

function getCheckedValues(selector) {
  return [...document.querySelectorAll(`${selector} input[type="checkbox"]:checked`)]
    .filter(cb => !cb.classList.contains('select-all'))
    .map(cb => cb.value);
}

function isAllChecked(selector) {
  const total = document.querySelectorAll(`${selector} input[type="checkbox"]:not(.select-all)`).length;
  const checked = document.querySelectorAll(`${selector} input[type="checkbox"]:not(.select-all):checked`).length;
  return checked === total && total > 0;
}
