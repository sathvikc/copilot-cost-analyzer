/**
 * @fileoverview Session list sidebar component.
 */

import { store } from '../store.js';
import { escapeHtml, relativeTime, shortTitle, copyText } from '../helpers.js';
import { formatNumberWithCommas, getSessionAicClass } from '../formatters.js';

/** Display labels for session channels (see sessionApi.deriveChannel). */
const CHANNEL_LABELS = {
  'vscode':          '🖥 VS Code',
  'vscode-insiders': '🟢 VS Code Insiders',
  'cli':             '⌘ Copilot CLI',
  'remote':          '📦 Remote / Dev Container'
};

/**
 * Rebuild the Sources multi-select from the channels actually present. Hidden
 * entirely when only one channel exists (nothing to filter). Checked state
 * follows store.filterSources ('' = all checked); checkbox changes are handled
 * in events.js.
 */
function rebuildSourceFilter() {
  const dropdown = document.getElementById('filter-source');
  const panel = document.getElementById('filter-source-panel');
  if (!dropdown || !panel) return;

  const channels = [...new Set(store.sessions.map(s => s.channel || 'vscode'))]
    .sort((a, b) => Object.keys(CHANNEL_LABELS).indexOf(a) - Object.keys(CHANNEL_LABELS).indexOf(b));
  dropdown.classList.toggle('hidden', channels.length <= 1);
  if (channels.length <= 1) return;

  const selected = store.filterSources ? store.filterSources.split(',') : channels;
  panel.innerHTML = '';

  const selectAll = document.createElement('label');
  selectAll.className = 'filter-select-all';
  selectAll.innerHTML = `<input type="checkbox" class="select-all" ${selected.length === channels.length ? 'checked' : ''} aria-label="Select all sources"> <strong>Select All</strong>`;
  panel.appendChild(selectAll);
  const divider = document.createElement('div');
  divider.className = 'filter-divider';
  panel.appendChild(divider);

  for (const ch of channels) {
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" value="${ch}" ${selected.includes(ch) ? 'checked' : ''} aria-label="Show ${escapeHtml(CHANNEL_LABELS[ch] || ch)} sessions"> ${CHANNEL_LABELS[ch] || escapeHtml(ch)}`;
    panel.appendChild(label);
  }

  const countEl = dropdown.querySelector('.filter-count');
  if (countEl) countEl.textContent = selected.length === channels.length ? 'All' : `${selected.length}/${channels.length}`;
}

/**
 * Render the session list in the sidebar.
 * @param {Array} filteredSessions
 * @param {Object} opts
 * @param {Function} opts.onSelectSession
 */
export function renderSessionList(filteredSessions, opts = {}) {
  const sessionList = document.getElementById('session-list');
  if (!sessionList) return;
  sessionList.innerHTML = '';

  // Populate workspace dropdown
  const wsSelect = document.getElementById('filter-workspace');
  if (wsSelect) {
    const currentValue = wsSelect.value;
    while (wsSelect.options.length > 1) wsSelect.remove(1);
    const paths = [...new Set(store.sessions.map(s => s.workspace_path).filter(Boolean))].sort();
    for (const p of paths) {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p.split('/').pop() || p;
      wsSelect.appendChild(opt);
    }
    if ([...wsSelect.options].some(o => o.value === currentValue)) wsSelect.value = currentValue;
  }

  rebuildSourceFilter();

  for (const s of filteredSessions) {
    const li = document.createElement('li');
    li.className = 'session-item' + (s.session_id === store.selectedSessionId ? ' active' : '');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', s.session_id === store.selectedSessionId ? 'true' : 'false');
    li.setAttribute('tabindex', '0');

    const title = s.title || 'Untitled Session';
    const relTime = s.start_time ? relativeTime(s.start_time) : '';
    const wsName = s.workspace_path ? (s.workspace_path.split('/').pop() || s.workspace_path) : 'unknown';

    // Status badge based on session attributes
    // (Estimated `~ est` badge intentionally omitted here \u2014 the detail header
    // already labels an open estimated session; the sidebar pill was noise.)
    const badges = [];
    if (s.retry_count > 0) badges.push('<span class="badge badge-warning" role="status" aria-label="' + s.retry_count + ' retries" title="' + s.retry_count + ' retries">\u21BB ' + s.retry_count + '</span>');
    if (s.has_model_switch) badges.push('<span class="badge badge-warning" role="status" aria-label="Model switch" title="Model switch">\u21C4</span>');
    if (s.has_subagent) badges.push('<span class="badge badge-info" role="status" aria-label="Sub-agent" title="Sub-agent">\u2139 sub</span>');
    if (s.source_type === 'copilot-cli') badges.push('<span class="badge badge-info" role="status" aria-label="Copilot CLI session" title="Copilot CLI session">\u2318 CLI</span>');

    const aicNum = s.computed_aic > 0 ? formatNumberWithCommas((s.computed_aic / 1e9).toFixed(2)) : '';
    const approxPrefix = s.is_aic_approx ? '~' : '';
    const aicClass = getSessionAicClass(s.computed_aic);

    li.innerHTML = `
      <div class="session-row session-row-1">
        <div class="session-title" title="${escapeHtml(title)}">${escapeHtml(shortTitle(title, 8))}</div>
        <span class="session-time" title="${s.start_time ? new Date(s.start_time * 1000).toLocaleString() : ''}">${relTime}</span>
      </div>
      <div class="session-row session-row-2">
        <span class="session-ws" title="${escapeHtml(s.workspace_path || '')}">${escapeHtml(wsName)}</span>
        <span class="session-stats">${s.total_llm_calls} calls${aicNum ? ' \u00B7 <span class="session-aic ' + aicClass + '">' + approxPrefix + aicNum + ' AIC</span>' : ''}</span>
      </div>
      ${badges.length ? '<div class="session-row session-pills">' + badges.join('') + '</div>' : ''}
      <div class="session-meta-extra hidden">
        <div class="meta-row"><label>ID</label> <span class="copyable" data-copy="${s.session_id}">${s.session_id.slice(0, 24)}\u2026</span></div>
        <div class="meta-row"><label>Path</label> <span>${escapeHtml(s.workspace_path || '\u2014')}</span></div>
        <div class="meta-row"><label>Hash</label> <span class="copyable" data-copy="${s.workspace_hash}">${s.workspace_hash.slice(0, 16)}\u2026</span></div>
      </div>`;

    // Copy handlers
    li.querySelectorAll('.copyable').forEach(el => {
      el.style.cursor = 'pointer';
      el.title = 'Click to copy';
      const lbl = el.closest('.meta-row')?.querySelector('label')?.textContent || '';
      el.addEventListener('click', (e) => { e.stopPropagation(); copyText(el.dataset.copy, lbl); });
    });

    // Double-click to expand metadata
    li.querySelector('.session-title')?.addEventListener('dblclick', () => {
      const extra = li.querySelector('.session-meta-extra');
      if (extra) extra.classList.toggle('hidden');
    });

    // Click to select session
    li.addEventListener('click', () => {
      if (opts.onSelectSession) opts.onSelectSession(s, filteredSessions);
    });

    // Keyboard support
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (opts.onSelectSession) opts.onSelectSession(s, filteredSessions);
      }
    });

    sessionList.appendChild(li);
  }
}
