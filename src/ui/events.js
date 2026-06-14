/**
 * @fileoverview DOM event listener setup for the webview.
 */

import { store } from './store.js';
import { clampTimeOffset, updateTimeLabel, updateFilterCounts, applyFilters } from './filters.js';
import { renderCacheSparkline, renderSessionTools, renderSessionModelSwitches, renderRetryReport, renderCacheTable } from './components/tabs.js';
import { renderSessionModelBreakdown } from './components/sessionDetail.js';
import { copyText } from './helpers.js';

/**
 * Set up all DOM event listeners.
 * @param {Object} opts
 * @param {Object} opts.rpc - RPC client instance
 */
export function setupEventListeners(opts = {}) {
  const { rpc } = opts;

  // Trigger a sync (shared by the header Sync button and setup-notice Re-check).
  const triggerSync = () => {
    const syncBtn = document.getElementById('btn-sync');
    if (syncBtn) {
      syncBtn.disabled = true;
      syncBtn.textContent = '\u21BB Syncing\u2026';
      syncBtn.classList.add('syncing');
    }
    rpc.call('triggerSync').catch(err => {
      if (window.__DEBUG__) console.error('[ui] triggerSync error:', err);
      if (syncBtn) {
        syncBtn.disabled = false;
        syncBtn.textContent = '\u21BB Sync';
        syncBtn.classList.remove('syncing');
      }
    });
  };

  // Sync button
  document.getElementById('btn-sync')?.addEventListener('click', triggerSync);

  // --- Setup notice (Copilot debug logs disabled / no data yet) ---

  // Open the exact Copilot setting in VS Code's Settings UI
  document.getElementById('btn-open-copilot-setting')?.addEventListener('click', () => {
    rpc.call('openCopilotDebugSetting').catch(err => {
      if (window.__DEBUG__) console.error('[ui] openCopilotDebugSetting error:', err);
    });
  });

  // Re-check buttons just re-run a sync; syncComplete re-evaluates the notice
  document.getElementById('btn-setup-recheck')?.addEventListener('click', triggerSync);
  document.getElementById('btn-setup-recheck-2')?.addEventListener('click', triggerSync);

  // Click the setting id to copy it
  const settingId = document.getElementById('setup-setting-id');
  if (settingId) {
    const copySetting = () => copyText(settingId.textContent.trim(), 'Setting');
    settingId.addEventListener('click', copySetting);
    settingId.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copySetting(); }
    });
  }

  // Breadcrumb: click Dashboard to go back
  const bcDashboard = document.getElementById('bc-dashboard');
  if (bcDashboard) {
    const goBack = () => {
      store.selectedSessionId = null;
      document.getElementById('session-detail')?.classList.add('hidden');
      document.getElementById('dashboard-view')?.classList.remove('hidden');
      document.getElementById('bc-separator')?.classList.add('hidden');
      document.getElementById('bc-session')?.classList.add('hidden');
    };
    bcDashboard.addEventListener('click', goBack);
    bcDashboard.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goBack(); }
    });
  }

  // Sidebar collapse
  document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
    document.querySelector('.sidebar')?.classList.toggle('collapsed');
  });

  // Time preset buttons
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      store.timePreset = btn.dataset.preset;
      store.timeOffset = 0;
      document.getElementById('custom-date-range')?.classList.toggle('hidden', store.timePreset !== 'custom');
      updateTimeLabel();
    });
  });

  // Time navigation
  document.getElementById('nav-prev')?.addEventListener('click', () => {
    if (store.timePreset === 'all') return;
    store.timeOffset--;
    clampTimeOffset();
    updateTimeLabel();
  });
  document.getElementById('nav-next')?.addEventListener('click', () => {
    if (store.timePreset === 'all') return;
    store.timeOffset++;
    clampTimeOffset();
    updateTimeLabel();
  });
  document.getElementById('nav-custom')?.addEventListener('click', () => {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    store.timePreset = 'custom';
    document.getElementById('custom-date-range')?.classList.remove('hidden');
    updateTimeLabel();
  });

  // Tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
    store.activeTab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
    });
    document.querySelectorAll('.tab-content').forEach(c => {
      c.classList.toggle('active', c.id === 'tab-' + store.activeTab);
    });
    if (store.activeTab === 'models') renderSessionModelBreakdown();
    if (store.activeTab === 'cache') { renderCacheSparkline(); renderCacheTable(); }
    if (store.activeTab === 'tools') renderSessionTools();
    if (store.activeTab === 'switches') renderSessionModelSwitches();
    if (store.activeTab === 'retries') renderRetryReport();
  }));

  // Expand / Collapse All
  document.getElementById('expand-all')?.addEventListener('click', () => {
    const btn = document.getElementById('expand-all');
    const isExpand = btn.textContent.includes('Expand');
    store.timelineExpanded = isExpand;
    document.querySelectorAll('.timeline-turn').forEach(t => {
      t.classList.toggle('collapsed', !isExpand);
      const header = t.querySelector('.timeline-turn-header');
      if (header) header.setAttribute('aria-expanded', isExpand ? 'true' : 'false');
    });
    btn.textContent = isExpand ? '\u229F Collapse' : '\u229E Expand';
  });

  // Filter dropdown toggles
  document.querySelectorAll('.filter-dropdown').forEach(dd => {
    const toggle = dd.querySelector('.filter-toggle');
    if (toggle) {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = dd.classList.contains('open');
        document.querySelectorAll('.filter-dropdown').forEach(d => d.classList.remove('open'));
        if (!isOpen) dd.classList.add('open');
      });
    }
  });

  // Close dropdowns on outside click
  document.addEventListener('click', (e) => {
    if (e.target.closest('.filter-dropdown')) return;
    document.querySelectorAll('.filter-dropdown').forEach(d => d.classList.remove('open'));
  });

  // Reset filters
  document.getElementById('filter-reset')?.addEventListener('click', () => {
    document.querySelectorAll('#filter-aic input[type="checkbox"], #filter-activity input[type="checkbox"]').forEach(cb => cb.checked = true);
    document.querySelectorAll('#filter-tools input[type="checkbox"]').forEach(cb => cb.checked = false);
    updateFilterCounts();
    applyFilters();
  });

  // Sidebar resize handle
  const handle = document.getElementById('resize-handle');
  const sidebar = document.querySelector('.sidebar');
  if (handle && sidebar) {
    let isResizing = false;
    handle.addEventListener('mousedown', () => {
      isResizing = true;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const newWidth = e.clientX;
      if (newWidth >= 200 && newWidth <= 500) sidebar.style.width = newWidth + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    });
  }
}
