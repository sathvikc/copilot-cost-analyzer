/**
 * @fileoverview Webview entry point — wires reactivity, RPC, and event listeners.
 *
 * Loaded as <script type="module" src="app.js"> from index.html.
 * lume-js URI is injected by extension.js via window.__LUME_URI__.
 */

// Dynamic import of lume-js (URI injected by extension host)
const { state, bindDom, effect } = await import(window.__LUME_URI__);

import { initStore, store } from './store.js';
import { computeFilteredSessions, updateTimeLabel } from './filters.js';
import { renderSessionList } from './components/sessionList.js';
import { renderDashboard } from './components/dashboard.js';
import { renderSessionDetail } from './components/sessionDetail.js';
import { renderSessionTools, renderSessionModelSwitches, renderRetryReport, renderConversation } from './components/tabs.js';
import { setupEventListeners } from './events.js';
import { createWebviewRpc } from './rpc-client.js';

// --- Initialize store ---
initStore(state);

// --- VS Code API + RPC ---
const vscode = acquireVsCodeApi();
const rpc = createWebviewRpc(vscode);
window.__rpc = rpc;

// --- Wire lume-js DOM binding ---
bindDom(document.body, store);

// --- Setup event listeners ---
setupEventListeners({ rpc });

// --- Session selection handler ---
function onSelectSession(s, filteredSessions) {
  try {
    if (window.__DEBUG__) console.log('[ui] select session:', s.session_id);
    store.selectedSessionId = s.session_id;
    renderSessionList(filteredSessions, { onSelectSession });

    document.getElementById('dashboard-view')?.classList.add('hidden');
    document.getElementById('session-detail')?.classList.remove('hidden');

    rpc.call('getSessionDetail', { sessionId: s.session_id }).then(detail => {
      if (window.__DEBUG__) console.log('[ui] detail received:', detail.session?.session_id, 'turns:', detail.turns?.length);
      store.turns = detail.turns || [];
      store.llmCalls = detail.llmCalls || [];
      store.toolCalls = detail.toolCalls || [];
      store.userMessages = detail.userMessages || [];
      store.modelSwitches = detail.modelSwitches || [];
      store.toolLeaderboard = detail.toolLeaderboard || [];
      // Load agent responses and conversation in parallel
      rpc.call('getAgentResponses', { sessionId: s.session_id }).then(responses => {
        store.agentResponses = responses || [];
      }).catch(() => { store.agentResponses = []; });
      rpc.call('getConversation', { sessionId: s.session_id }).then(msgs => {
        store.conversation = msgs || [];
      }).catch(() => { store.conversation = []; });
      store.sessionDetail = detail.session; // set last so effects see fresh data
    }).catch(err => {
      if (window.__DEBUG__) console.error('[ui] getSessionDetail error:', err);
    });
  } catch (err) {
    if (window.__DEBUG__) console.error('[ui] select error:', err);
  }
}

// --- Reactive effects ---

// Session list + dashboard re-render on filter/session changes
effect(() => {
  const filtered = computeFilteredSessions();
  store.sessionCount = filtered.length;
  renderSessionList(filtered, { onSelectSession });
  renderDashboard();
});

// Session detail re-render
effect(() => {
  if (!store.sessionDetail) return;
  try {
    renderSessionDetail();
  } catch (err) {
    if (window.__DEBUG__) console.error('[ui] renderSessionDetail error:', err);
  }
});

// Tab-specific re-renders
effect(() => {
  void store.toolLeaderboard;
  if (store.activeTab === 'tools') renderSessionTools();
});

effect(() => {
  void store.modelSwitches;
  if (store.activeTab === 'switches') renderSessionModelSwitches();
});

effect(() => {
  void store.llmCalls;
  if (store.activeTab === 'retries') renderRetryReport();
});

effect(() => {
  void store.conversation;
  if (store.activeTab === 'conversation') renderConversation();
});

// --- RPC notification handlers ---

rpc.on('syncComplete', () => {
  const btn = document.getElementById('btn-sync');
  if (btn) {
    btn.disabled = false;
    btn.textContent = '\u21BB Sync';
    btn.classList.remove('syncing');
  }
  loadSessions();
  loadDashboard();
});

rpc.on('loading', () => {
  if (!store.selectedSessionId) {
    document.getElementById('dashboard-view')?.classList.remove('hidden');
    document.getElementById('session-detail')?.classList.add('hidden');
  }
});

// --- Data loading ---

function updateDateRange(sessions) {
  const times = sessions.map(s => s.start_time).filter(Boolean);
  if (times.length > 0) {
    const minDate = new Date(Math.min(...times) * 1000).toISOString().split('T')[0];
    const maxDate = new Date(Math.max(...times) * 1000).toISOString().split('T')[0];
    const fromEl = document.getElementById('filter-date-from');
    const toEl = document.getElementById('filter-date-to');
    if (fromEl) { fromEl.setAttribute('min', minDate); fromEl.setAttribute('max', maxDate); }
    if (toEl) { toEl.setAttribute('min', minDate); toEl.setAttribute('max', maxDate); }
  }
}

async function loadSessions() {
  try {
    const sessions = await rpc.call('getSessions');
    if (window.__DEBUG__) console.log('[ui] sessions loaded:', sessions.length);
    store.sessions = sessions || [];
    updateDateRange(store.sessions);
  } catch (err) {
    if (window.__DEBUG__) console.error('[ui] getSessions error:', err);
  }
}

async function loadDashboard() {
  try {
    const data = await rpc.call('getDashboard');
    store.dashboardData = data;
  } catch (err) {
    if (window.__DEBUG__) console.error('[ui] getDashboard error:', err);
  }
}

// --- Init ---
updateTimeLabel();
loadSessions();
loadDashboard();
