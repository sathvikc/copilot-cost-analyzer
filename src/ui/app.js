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
    // Opening a session means we're past the setup gate — dismiss the Option A
    // notice and latch the opt-in so it doesn't sit above the detail view (which
    // forced the user to scroll past an empty panel to reach the session).
    setEstimatedOptIn(true);
    renderSessionList(filteredSessions, { onSelectSession });

    document.getElementById('setup-notice')?.classList.add('hidden');
    document.getElementById('dashboard-view')?.classList.add('hidden');
    document.getElementById('session-detail')?.classList.remove('hidden');
    // We just latched the opt-in by opening a session — re-evaluate so the header
    // "Setup" button appears (it's our only route back to the instructions now).
    updateSetupNotice();

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

function setSyncingState(syncing) {
  const btn = document.getElementById('btn-sync');
  if (!btn) return;
  btn.disabled = syncing;
  btn.textContent = syncing ? '\u21BB Syncing\u2026' : '\u21BB Sync';
  btn.classList.toggle('syncing', syncing);
}

rpc.on('syncStart', () => setSyncingState(true));

let syncEverCompleted = false;
// Set once we've read the persisted opt-in from the host, so later notice
// re-evaluations don't clobber the user's in-session choice.
let optInHydrated = false;
rpc.on('syncComplete', () => {
  syncEverCompleted = true;
  setSyncingState(false);
  loadSessions();
  loadDashboard();
});

rpc.on('loading', () => {
  setSyncingState(true);
  if (!store.selectedSessionId && !isSetupNoticeVisible()) {
    document.getElementById('dashboard-view')?.classList.remove('hidden');
    document.getElementById('session-detail')?.classList.add('hidden');
  }
});

// --- Setup notice (Copilot debug logs disabled / no data yet) ---

function isSetupNoticeVisible() {
  return !document.getElementById('setup-notice')?.classList.contains('hidden');
}

// Set the estimated opt-in both in the reactive store and in the extension's
// globalState, so the choice is remembered the next time the panel opens.
function setEstimatedOptIn(value) {
  store.estimatedOptIn = value;
  rpc.call('setEstimatedOptIn', { value }).catch(() => {});
}

// Show/hide the header "⚙ Setup" button — the in-app route back to the Option A
// notice. Only meaningful while we're showing estimated sessions.
function setSetupButtonVisible(visible) {
  document.getElementById('btn-setup-show')?.classList.toggle('hidden', !visible);
}

// "⚙ Setup": return to the setup instructions without closing the panel. Clears
// the opt-in (so the notice can render and the choice is forgotten until the
// user opts in again) and re-evaluates which view to show.
window.__showSetup = () => {
  setEstimatedOptIn(false);
  store.selectedSessionId = null;
  document.getElementById('session-detail')?.classList.add('hidden');
  updateSetupNotice();
};

function showSetupNotice(mode, estimatedCount = 0) {
  const notice = document.getElementById('setup-notice');
  if (!notice) return;
  document.getElementById('setup-disabled')?.classList.toggle('hidden', mode !== 'disabled');
  document.getElementById('setup-empty')?.classList.toggle('hidden', mode !== 'empty');
  if (mode === 'disabled') updateEstimatedCta(estimatedCount);
  notice.classList.remove('hidden');
  document.getElementById('dashboard-view')?.classList.add('hidden');
  document.getElementById('session-detail')?.classList.add('hidden');
}

/**
 * Show/hide the Option B opt-in ("View N sessions anyway") inside the disabled
 * setup notice and fill in the count. Hidden entirely when no estimated
 * sessions were found, so the CTA only appears when it can deliver something.
 */
function updateEstimatedCta(count) {
  const cta = document.getElementById('setup-estimated');
  if (!cta) return;
  cta.classList.toggle('hidden', count <= 0);
  if (count <= 0) return;
  const noun = count === 1 ? 'session' : 'sessions';
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  set('setup-estimated-count', String(count));
  set('setup-estimated-noun', `past ${noun}`);
  set('btn-view-estimated-label', `View ${count} estimated ${noun}`);
}

function hideSetupNotice() {
  const notice = document.getElementById('setup-notice');
  if (!notice || notice.classList.contains('hidden')) return;
  notice.classList.add('hidden');
  if (!store.selectedSessionId) {
    document.getElementById('dashboard-view')?.classList.remove('hidden');
  }
}

/**
 * Decide whether to show the setup notice.
 *
 * Sessions split into two kinds: "full" (debug-logs, source_type !== 'chatSessions')
 * and "estimated" (chatSessions fallback). The matrix:
 *   - logging ON  → show whatever we have; estimated old sessions render normally.
 *   - logging OFF + full sessions exist → still show them (old real data is valuable).
 *   - logging OFF + only estimated      → show Option A first, with an opt-in CTA
 *                                          ("View N anyway"); reveal them once opted in.
 *   - logging OFF + nothing             → plain disabled notice.
 *
 * The "enabled but empty" state waits for the first sync to finish so it doesn't
 * flash while the DB is still initializing.
 */
async function updateSetupNotice() {
  const fullCount = store.sessions.filter(s => s.source_type !== 'chatSessions').length;
  const estimatedCount = store.sessions.length - fullCount;

  let status;
  try {
    status = await rpc.call('getSetupStatus');
  } catch {
    hideSetupNotice();
    setSetupButtonVisible(false);
    return;
  }

  // Hydrate the persisted opt-in once, so reopening the panel honors the user's
  // previous "view estimated sessions" choice instead of re-prompting.
  if (!optInHydrated) {
    store.estimatedOptIn = !!status.estimatedOptIn;
    optInHydrated = true;
  }

  if (status.debugLoggingEnabled) {
    if (store.sessions.length > 0) hideSetupNotice();
    else if (syncEverCompleted) showSetupNotice('empty');
    else hideSetupNotice();
    setSetupButtonVisible(false);
    return;
  }

  // Logging is off. Old "full" data is still worth showing as-is (no opt-in / no
  // Setup button — this isn't the estimated flow).
  if (fullCount > 0) {
    hideSetupNotice();
    setSetupButtonVisible(false);
    return;
  }
  // Only estimated sessions exist. Once opted in, show them and offer the header
  // Setup button as the way back to these instructions.
  if (store.estimatedOptIn && estimatedCount > 0) {
    hideSetupNotice();
    setSetupButtonVisible(true);
    return;
  }
  showSetupNotice('disabled', estimatedCount);
  setSetupButtonVisible(false);
}

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
    updateSetupNotice();
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

// Lightweight refresh used by "Re-check" when debug logging is still off:
// re-read the DB and re-evaluate the setup notice WITHOUT a filesystem sync, so
// re-checking never silently imports debug-logs the user hasn't opted into.
window.__refreshSetup = () => { loadSessions(); loadDashboard(); };

// Re-evaluate the setup notice / header "Setup" button after a view change (e.g.
// breadcrumb back to the dashboard) without a full data reload.
window.__updateSetupNotice = () => updateSetupNotice();

// --- Init ---
updateTimeLabel();
loadSessions();
loadDashboard();
