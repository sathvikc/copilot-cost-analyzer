/**
 * @fileoverview Reactive state store for the webview.
 *
 * Single source of truth for all UI state, created via lume-js `state()`.
 *
 * Architecture decision — single vs. multiple stores:
 *   We intentionally use ONE store because lume-js `effect()` already tracks
 *   dependencies at the **property level**. An effect reading `store.filterSearch`
 *   will NOT re-run when `store.llmCalls` changes. Splitting into multiple stores
 *   would add complexity (multiple `bindDom()` calls, cross-store imports) with
 *   zero reactivity benefit. The `data-bind` attributes in index.html also require
 *   a single store reference passed to `bindDom(document.body, store)`.
 *
 * State is organized into logical sections:
 *   1. Data       — raw data from RPC (sessions, turns, llmCalls, etc.)
 *   2. Filters    — user-controlled filter criteria (bound to inputs via data-bind)
 *   3. UI         — view state (selected ID, active tab, expanded state)
 *   4. View-model — formatted display strings (bound to DOM via data-bind)
 */

/** @type {import('lume-js').State|null} */
export let store = null;

/**
 * Initialize the reactive store with default values.
 * @param {Function} stateFn - lume-js `state()` function
 * @returns {Object} The created reactive store
 */
export function initStore(stateFn) {
  store = stateFn({
    // ── Data (from RPC) ─────────────────────────────────────────────
    sessions: [],              // Array of session summary objects
    sessionDetail: null,       // Full session object for selected session
    turns: [],                 // Turns array for selected session
    llmCalls: [],              // LLM calls for selected session
    toolCalls: [],             // Tool calls for selected session
    userMessages: [],          // User messages for selected session
    toolLeaderboard: [],       // Tool leaderboard for selected session
    modelSwitches: [],         // Model switches for selected session
    agentResponses: [],        // Agent responses for selected session
    conversation: [],          // Conversation messages from transcripts (user + assistant)
    dashboardData: null,       // Aggregate dashboard data (models, tools, daily)

    // ── Filters (two-way bound to inputs via data-bind) ─────────────
    filterSearch: '',          // Free-text search
    filterWorkspace: '',       // Workspace path filter
    filterDateFrom: '',        // Custom date range start
    filterDateTo: '',          // Custom date range end
    timePreset: 'all',         // 'today' | 'week' | 'month' | 'all' | 'custom'
    timeOffset: 0,             // Navigation offset for preset ranges

    // ── UI state ────────────────────────────────────────────────────
    selectedSessionId: null,   // Currently selected session ID
    sessionCount: 0,           // Derived: filtered session count (bound to DOM)
    activeTab: 'timeline',     // Active tab in session detail view
    timelineExpanded: false,   // Whether timeline turns are expanded

    // ── View-model (formatted strings, bound to DOM via data-bind) ──
    // These bridge raw session data → display text. Set by renderSessionDetail().
    cardCalls: '\u2014',
    cardInput: '\u2014',
    cardOutput: '\u2014',
    cardCached: '\u2014',
    cardCacheHit: '\u2014',
    cardCost: '\u2014',
    cardAic: '\u2014'
  });
  return store;
}
