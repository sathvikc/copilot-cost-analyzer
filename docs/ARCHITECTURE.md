# Architecture — Copilot Cost Analyzer

Developer documentation. Goal: a new developer productive within an hour.
Companion docs: [`log-format-research.md`](log-format-research.md) (verified input formats),
[`ROADMAP.md`](ROADMAP.md) (product direction), root `CLAUDE.md` (agent onboarding + invariants).

---

## 1. The problem it solves

GitHub Copilot moved to usage-based billing (June 2026): every plan has a monthly AI-Credit
allowance and credits burn with token usage — including cached tokens — at per-model rates.
Existing trackers show *totals* ("you used N tokens"); none explain *causes*. This extension
answers **"why did this session cost what it cost, and what should I do differently?"** by
mining the session logs Copilot already writes to disk:

- Which tool calls flooded the context, and when the prompt cache broke (and *why* — 9
  classified causes, from model switches to user interruptions to provider TTL evictions).
- What model switches cost in lost cache.
- How each turn ended (completed / edited / steered / stopped / interrupted) and what the
  interruption did to the next request's cache.
- Ground-truth billing where available (per-call `copilotUsageNanoAiu` in VS Code debug
  logs; `session.shutdown` totals incl. billed premium requests in the Copilot CLI).

Everything is local — no network calls, no telemetry. The extension reads log files,
persists derived analytics into a local SQLite DB, and renders a webview dashboard.

## 2. System architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ DISK (inputs — written by Copilot, read-only to us)                          │
│                                                                              │
│  workspaceStorage/<hash>/GitHub.copilot-chat/debug-logs/<id>/                │
│      main.jsonl  models.json  system_prompt_N.json  tools_N.json             │
│      runSubagent-*.jsonl                    (full data; gated by a setting)  │
│  workspaceStorage/<hash>/GitHub.copilot-chat/transcripts/<id>.jsonl          │
│  workspaceStorage/<hash>/chatSessions/<id>.jsonl   (always written; patch    │
│                                                     stream; fallback source) │
│  ~/.copilot/session-state/<id>/events.jsonl        (Copilot CLI sessions)    │
└──────────────┬───────────────────────────────────────────────────────────────┘
               │ discovery: utils/paths.js (macOS/Win/Linux, Stable+Insiders,
               │            dev-container fallback, $COPILOT_HOME)
               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ EXTENSION HOST (Node.js, CommonJS)                                           │
│                                                                              │
│  db/sync.js ── discoverSessions() → per-session syncXxx() in a transaction   │
│     │   incremental gate: sync_log (mtime + file_size + parser_version)      │
│     │                                                                        │
│     ├─► api/parser/mainJsonlParser.js   (streaming readline; llm/tool calls, │
│     │        turns, switches, cache-break ladder + content-diff)             │
│     ├─► api/parser/chatSessionParser.js (patch-stream replay → estimated)    │
│     ├─► api/parser/cliEventsParser.js   (CLI events + shutdown totals)       │
│     ├─► api/parser/modelsJsonParser.js  (pricing map, per-call token cost)   │
│     └─► api/compute/sessionMetrics.js   (AIC↔$ math, global learned ratio)   │
│         api/compute/aicClassifier.js    (expensive/moderate/low/none tiers)  │
│                        │                                                     │
│                        ▼                                                     │
│  db/db.js — sql.js (pure-JS SQLite), whole DB in memory, persisted to        │
│     <globalStorage>/copilot-analytics.db ; schema.sql + migrations.js        │
│                        │                                                     │
│                        ▼                                                     │
│  api/sessionApi.js — read-side queries, turn grouping, AIC distribution,     │
│     conversation reconstruction, exports (json/csv/markdown/ai-review)       │
│                        │                                                     │
│  extension.js — activation, panel lifecycle, 15 RPC handlers, commands,      │
│     setup-notice logic (Copilot debug-logging detection, estimated opt-in)   │
└──────────────┬───────────────────────────────────────────────────────────────┘
               │ shared/rpc.js — Promise-based postMessage RPC (30s timeout)
               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ WEBVIEW (browser ES modules, no bundler)                                     │
│                                                                              │
│  ui/app.js (entry) ── lume-js reactive store (ui/store.js)                   │
│  ui/components/: dashboard, sessionList, sessionDetail, tabs (Tools /        │
│    Switches / Cache / Conversation), timeline, modelCard, table              │
│  ui/filters.js (time / workspace / sources / quality), ui/events.js          │
│  index.html — CSP template ({{cspSource}}), styles.css                       │
│  RENDER-ONLY: no cost/AIC math happens here                                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 3. Module-by-module walkthrough

### Entry point — `src/extension.js` (~460 lines)
- `activate()`: creates `Database` at `context.globalStorageUri`, registers
  `setGlobalStorageBase()` (dev-container path fallback), kicks off `db.init()` +
  `fullSync()` in the background (never blocks panel open), registers commands
  `copilotCostAnalyzer.openPanel` / `.refresh`, a status-bar item, and an activity-bar
  webview view that just opens the full panel.
- `showPanel()`: creates the webview panel, wires `createHostRpc(panel.webview)` and
  registers every RPC method (thin delegations to `sessionApi`), plus host-side actions:
  `revealChatSession` (vscode-chat-session URI; cross-workspace prompt), `openDebugLog`,
  `openCopilotDebugSetting`, `getSetupStatus`/`setEstimatedOptIn` (persisted opt-in for
  estimated sessions).
- `getWebviewContent()`: loads `src/ui/index.html`, rewrites asset URLs to webview URIs,
  injects `window.__DEBUG__` and `window.__LUME_URI__`.
- Two settings: `autoSyncOnStartup` (default true), `debugLogging` (default false).

### Discovery — `src/utils/paths.js`
- `getWorkspaceStoragePaths()`: returns every existing candidate among the hardcoded
  macOS/Windows/Linux paths for Code and Code Insiders; when none exist (dev container,
  VS Code Server), falls back to a base derived from the extension's own globalStorage
  (siblings under the same `User/` dir).
- `getCopilotCliSessionPaths()`: `$COPILOT_HOME/session-state` if set, else
  `~/.copilot/session-state`.
- `findWorkspaceFile(hash, ...segments)`: resolves a file across all bases.

### Sync engine — `src/db/sync.js` (~1180 lines; the heart of the write path)
- `discoverSessions()` — three passes, priority ordered:
  1. `debug-logs` (full data) — collects session ids first;
  2. `chatSessions` (estimated fallback) — only ids **not** covered by pass 1;
  3. `copilot-cli`.
- `syncSession()` dispatches on `source` to `syncDebugLogSession` / `syncChatSession` /
  `syncCliSession`. All three share the same row writers (`insertSessionRow`,
  `insertLlmCalls`, …) and each runs inside one `db.transaction()` after
  `deleteSessionRows()` (delete + reinsert, idempotent).
- Incremental gate: a `sync_log` row per session storing source_path, mtime, file_size,
  parser_version. Any mismatch forces a re-parse. **Constants to bump when logic
  changes**: `PARSER_VERSION` (33), `CHAT_PARSER_VERSION` (4), `CLI_PARSER_VERSION` (1).
  The `source_path` comparison is what upgrades an estimated chatSessions row to full
  once debug-logs appear.
- `parseChatSession()` + `computeInterruptions()`: cross-references debug-log user
  messages against the canonical chatSessions `requests[]` to classify each turn's end
  (`edited` — absent from history; `steered` — canceled + next request within ±2s;
  `stopped` — canceled otherwise; `interrupted` — unrecorded result, not last). Then
  reclassifies a following `provider_eviction` cache break to `user_interruption`
  unless a content diff proved the prefix byte-identical.
- `computeGlobalAicRatio()` / `recomputeApproxSessions()`: after each full sync, all
  sessions lacking real AIC are re-estimated from the latest learned nano-AIU-per-token
  ratio (chatSessions rows excluded — their cost is intentionally unknowable).
- `fullSync()` — module-level re-entrancy guard, per-session try/catch (errors counted,
  never abort the loop), `db.persist()` every 5 synced sessions + at the end.

### Debug-log parser — `src/api/parser/mainJsonlParser.js` (~700 lines)
- `parseDebugLog(file)`: readline stream; tolerates malformed lines (skip). Extracts
  llm calls (tokens, AIC, ttft, span ids, sidecar file refs), tool calls (args, result,
  compression-method detection), user messages (turn boundaries), agent responses,
  discovery events, session meta, title-child-log reference.
- `parseSessionDirectory(dir)`: parses `main.jsonl` + every `runSubagent-*.jsonl`,
  merges and re-sorts by timestamp with **separate main/subagent baselines** for token
  deltas, then classifies cache breaks:
  - Break = cached fell by >20% of prior value AND >256 tokens (proportional rule).
  - Ladder (order matters): `model_switch` → `subagent_boundary` →
    `system_prompt_change` → `tools_changed` → `options_changed` → `compaction`
    (same-model input trimmed >20%) → `retry` → `provider_eviction`.
  - `provider_eviction` refinement: normalizes each request's `inputMessages` to
    `{role, name, len, FNV-1a hash}` signatures and diffs consecutive prefixes.
    Byte-identical prefix ⇒ confirmed eviction/TTL; change inside the prefix ⇒
    `prefix_change` at that message index. Signatures are transient (`_msgSig`,
    deleted before return — never persisted).

### chatSessions parser — `src/api/parser/chatSessionParser.js`
- The file is a patch stream: `kind:0` snapshot, `kind:1` set-at-keypath, `kind:2`
  array delta (append or merge-by-index). `reconstructSession()` replays it.
- Maps each surviving request onto the same result shape as `parseSessionDirectory`
  so sync persists it through the shared writers. Data limits (verified): input
  undercounted, output accurate, no cache/AIC — hence "estimated" sessions where
  output tokens may be estimated from response text at ~4 chars/token and cost/AIC
  stay empty rather than fabricated.

### CLI parser — `src/api/parser/cliEventsParser.js`
- Flat event stream. Per-message `outputTokens` only; `session.shutdown` carries
  ground-truth totals: `totalPremiumRequests` (the actual billing unit), `totalNanoAiu`,
  `tokenDetails`, per-model `modelMetrics`. Sessions without a shutdown event (crash)
  are stored `limited` — nothing fabricated. `abort` with `reason: 'user_initiated'`
  marks explicit cancels.

### Pricing & cost — `src/api/parser/modelsJsonParser.js`, `src/api/compute/*`
- `loadPricing()`: `models.json` → `Map<modelId, {inputPrice, cachePrice, outputPrice}>`
  ($ per Mtok; raw values divided by 1e4). **Many real models.json files carry no
  `token_prices` at all** — the map is then empty and every `computeCallCost` returns 0.
- `computeCallCost(call, map)`: `fresh×input + cached×cache + output×output` per 1e6.
- `sessionMetrics.computeSessionMetrics()` — the display-cost policy:
  1. real summed nano-AIU when present (`cost = aic / 1e11`; 1 AIC = $0.01);
  2. else tokens × learned global ratio (marked `~` approx);
  3. else tokens × `DEFAULT_AIC_RATIO` (10597 nano-AIU/token, derived from a measured
     31-session corpus — deliberately NOT naive token×price, which overestimates ~8×);
  4. token-priced cost only surfaces when there are no tokens to estimate from.
  Cache hit % = cached / input.
- `aicClassifier.js`: hybrid classification — absolute bounds (≥5 AIC always expensive,
  <0.1 always none) + per-model percentile cutoffs (P90/P65/P30; models with <3 calls
  fall back to session-wide cutoffs).

### Persistence — `src/db/db.js`, `schema.sql`, `migrations.js`
- sql.js = SQLite compiled to WASM; zero native bindings, works on every VS Code
  platform. Whole DB lives in memory; `persist()` exports the full image and
  `fs.writeFileSync`s it to `<globalStorage>/copilot-analytics.db`.
- `_runSchema()`: executes `schema.sql` (all `CREATE ... IF NOT EXISTS`), then applies
  `MIGRATIONS` above the recorded `schema_version` (currently 4 guarded ALTERs).
- `transaction(fn)`: BEGIN/COMMIT/ROLLBACK; nested calls are no-ops inside the outer one.
- 10 tables. `sessions` is the hub; 7 child tables FK→sessions with
  `ON DELETE CASCADE` (sync still deletes children explicitly, belt-and-braces);
  `sync_log` and `model_catalog` stand alone.

### Read side — `src/api/sessionApi.js` (~840 lines)
- `getSessions()`: list + per-session retry_count + `channel` derived from
  source_path (`cli` / `vscode-insiders` / `remote` / `vscode`) — derivation keeps old
  rows correct without re-sync.
- `getSessionDetail()` → `buildTurns()`: groups calls/tools/messages by turn, flags
  limited-source calls, distributes estimated session AIC across calls proportionally
  to tokens, classifies per-call/turn AIC tiers, builds a chronological per-turn event
  list (user → tool → llm tie-break at equal seconds), cold-start and interruption flags.
- `getDashboard()`: daily cost, tools/models per session — all excluding
  `source_type='chatSessions'`; vendor enrichment from `model_catalog` with string
  matching fallback.
- `getConversation()`: user messages from `user_messages` + assistant text from
  `transcripts` (or reconstruction from `agent_responses` for estimated sessions),
  collapsing consecutive assistant status messages.
- `exportSession(format)`: `json` (default), `csv` (RFC-escaped llm-call table),
  `markdown` (summary), `ai-review` — a self-contained ~1–2k-token coaching prompt
  (`buildAiReviewPack`) with glossary, measured session facts, and a turn-by-turn
  digest (end states, cache breaks, verbatim user prompts, trimmed responses).
- Every public function try/catches and returns an empty-but-well-shaped value
  (tested behavior).

### RPC — `src/shared/rpc.js`
- `createHostRpc(webview)`: `handle(method, fn)` + `notify(event, data)`; unknown
  method / handler errors → structured error responses.
- `createWebviewRpc(vscodeApi)`: Promise `call()` with per-call timeout (default 30s),
  `on/off` for notifications, `dispose()` rejects all pending.
- Notification events used: `syncStart`, `syncComplete`, `loading`, `initError`.

### Webview — `src/ui/`
- `app.js` dynamically imports lume-js (URI injected by the host), binds the reactive
  `store` to the DOM, loads sessions/dashboard via RPC, and orchestrates view state
  (setup notice ↔ dashboard ↔ session detail).
- Components render HTML template strings into containers; `escapeHtml` guards
  log-derived content. Charts are hand-rolled `<canvas>` sparklines. Filters:
  time range, workspace, sources multi-select, data quality, text search.
- CSP in `index.html`: `default-src 'none'`, assets restricted to `{{cspSource}}`;
  note `script-src` currently includes `'unsafe-inline'` (see audit).

## 4. Data flow — from raw log line to a pixel

1. **Activation** (`extension.js`) → `db.init()` (load/create DB file, migrations) →
   `fullSync(db)` in background.
2. **Discovery** (`sync.discoverSessions`) walks every workspaceStorage base +
   CLI store → list of `{sessionId, source, paths, mtimes}`.
3. **Gate** — `sync_log` row compared on source_path + mtime + file_size +
   parser_version; unchanged sessions are skipped (typical steady-state sync is
   milliseconds).
4. **Parse** — source-specific parser produces one normalized shape:
   `{llmCalls, toolCalls, modelSwitches, userMessages, agentResponses, …}`.
5. **Enrich** — cache-break ladder + content diff (parser); interruption
   classification via chatSessions cross-reference (sync); per-call token cost from
   models.json pricing; session totals; `computeSessionMetrics` for display cost/AIC.
6. **Persist** — one transaction: delete session's rows, insert session + children,
   upsert sync_log, upsert model_catalog, replay transcripts. `db.persist()` every 5
   sessions.
7. **Recompute** — `recomputeApproxSessions` refreshes every approx session against the
   newest learned AIC ratio.
8. **Notify** — `rpc.notify('syncComplete', {synced, skipped, errors})` → webview
   re-fetches `getSessions` + `getDashboard`.
9. **Render** — user clicks a session → `getSessionDetail` → turn-grouped payload →
   components render Timeline / Tools / Switches / Cache / Conversation tabs.
10. **Export** — `exportSession` returns `{data, mimeType, filename}` for download or
    the AI-review clipboard pack.

## 5. Public surface

### VS Code contributions (package.json)
| Surface | Id / value |
|---|---|
| Command | `copilotCostAnalyzer.openPanel` — "Open Copilot Cost Analyzer" |
| Command | `copilotCostAnalyzer.refresh` — "Refresh Sessions" |
| Setting | `copilotCostAnalyzer.autoSyncOnStartup` (bool, default true) |
| Setting | `copilotCostAnalyzer.debugLogging` (bool, default false) |
| Views | Activity-bar container `copilotCostAnalyzer` + webview view `copilotCostAnalyzerPanel` |
| Status bar | `$(graph) Cost Analyzer` → openPanel |

### RPC methods (host ↔ webview)
`getSessions`, `getSessionDetail`, `getDashboard`, `getModelCatalog`,
`getAgentResponses`, `getCacheBreakSummary`, `getDiscoveryEvents`, `getTranscripts`,
`getConversation`, `exportSession`, `triggerSync`, `revealChatSession`, `openDebugLog`,
`showNotification`, `getSetupStatus`, `setEstimatedOptIn`, `openCopilotDebugSetting`.
Notifications: `syncStart`, `syncComplete`, `loading`, `initError`.

### Dev scripts (never shipped)
`generate-demo-db.js` (demo DB from `demo-sessions/*.json`), `db-switch.js`
(demo/real DB swap — quit VS Code first), `validate-db.js` (DB vs raw JSONL
integrity), `verify-sync.js` (wipe + resync against live data),
`container-smoke-test.js` (path resolution in Linux containers).

## 6. Dependency rationale

| Dependency | Why |
|---|---|
| `sql.js` (runtime) | SQLite without native bindings — a `.node` binary per platform/electron-ABI is the classic VS Code extension packaging trap. WASM works everywhere. Trade-off: whole DB in memory, full-file persist. |
| `lume-js` (runtime) | Minimal reactive state for the webview with **no build step** — the UI ships as raw ES modules; a framework requiring a bundler would force a build pipeline. Trade-off: niche dependency (low bus factor). |
| `vitest` (dev) | Fast, zero-config ESM/CJS test runner; whole suite runs in ~0.5s. |
| `eslint` 8 + `eslint:recommended` (dev) | Minimal lint floor (rules currently downgraded to warnings). |
| `@vscode/vsce` (dev) | VSIX packaging. Source of all `npm audit` dev-chain findings. |
| No bundler, no TS | Deliberate: `main` points at `src/extension.js`; the VSIX ships sources as-is. |

## 7. Extension points — where to add things

| You want to… | Touch |
|---|---|
| Support a new log/event type in debug logs | `mainJsonlParser.parseDebugLog` (new `event.type` branch) → new table or column via `migrations.js` (+ schema.sql for fresh installs) → writer in `sync.js` → **bump `PARSER_VERSION`** → query in `sessionApi` → RPC handler in `extension.js` → UI component |
| Add a new session source (like the CLI was) | New parser returning the `parseSessionDirectory` shape → discovery pass in `sync.discoverSessions` → `syncXxxSession` using the shared row writers → new `source_type` value + `deriveChannel` case |
| Add a new cache-break type | The classification ladder in `mainJsonlParser.parseSessionDirectory` (mind the priority order) → README badge table → `tabs.js` Cache tab rendering → bump `PARSER_VERSION` |
| Add a dashboard metric | Query in `sessionApi.getDashboard` → `ui/components/dashboard.js` |
| Add an export format | `sessionApi.exportSession` switch → export menu in `ui/events.js` |
| Change cost/AIC math | `sessionMetrics.js` ONLY (both sync and API depend on it); never in the webview |
| Add a schema column | New guarded migration (version N+1) in `migrations.js` AND the column in `schema.sql`, following migration 1's pattern |

## 8. Testing model

- `npm test` → 19 vitest files / 186 tests, <1s, no network, no real user data:
  parsers are fed inline fixtures or temp dirs; sync tests build throwaway
  workspaceStorage trees; DB tests run sql.js in-memory; integration test
  (`tests/integration/chatSessionsFallback.test.js`) covers the estimated→full upgrade
  end to end.
- Coverage (v8, UI excluded): ~79% statements overall; `extension.js` 0% (needs a
  vscode API mock); weakest branches: `cliEventsParser` (~31%), `mainJsonlParser` (~52%).
- Manual/live checks: `tests/api/validate-api-live.js`, `scripts/validate-db.js`,
  `scripts/verify-sync.js`, `npm run test:container`.
