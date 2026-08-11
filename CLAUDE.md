# CLAUDE.md — Copilot Cost Analyzer

Agent onboarding for this repo. Read this first; it is accurate as of v0.9.0 (2026-07).

## What this project is

A **VS Code extension** (pure JavaScript, no build step, no TypeScript) that parses GitHub
Copilot's on-disk session logs — VS Code Chat debug logs, the always-written chatSessions
store, and Copilot CLI event logs — and visualizes **token costs, AI-credit (AIC) burn,
prompt-cache behavior (with 9-type cache-break classification), tool-call impact, model
switches, and user-interruption effects** in a webview dashboard. Data is persisted to a
local SQLite database (sql.js) with incremental sync. Not yet on the Marketplace; installed
from a locally built `.vsix`.

## Architecture (60 seconds)

```
Raw logs on disk                      Extension host (Node, CommonJS)                Webview (ES modules)
─────────────────────                 ─────────────────────────────────              ─────────────────────
workspaceStorage/<hash>/
  GitHub.copilot-chat/
    debug-logs/<id>/main.jsonl ──►  mainJsonlParser  ─┐
    debug-logs/<id>/models.json ──► modelsJsonParser  │
    transcripts/<id>.jsonl ───────► syncTranscripts   ├─► db/sync.js ─► sql.js DB ─► sessionApi.js ─► shared/rpc.js ─► ui/app.js
  chatSessions/<id>.jsonl ────────► chatSessionParser │   (discover,    (10 tables,   (query +          (postMessage    (lume-js store,
~/.copilot/session-state/           cliEventsParser  ─┘    incremental,  in-memory,    turn grouping,     RPC, 30s        components/)
  <id>/events.jsonl                                        transactional) persisted     export)            timeout)
                                                                          to disk)
```

Key rule: **all math happens in the backend** (`compute/`), stored in the DB; the webview
only renders. The webview never recomputes cost/AIC.

## Directory map

| Path | Role |
|---|---|
| `src/extension.js` | Entry point: activation, DB init, background sync, webview panel, all 15 RPC handlers |
| `src/api/parser/mainJsonlParser.js` | Streaming (readline) parser for `main.jsonl` + `runSubagent-*.jsonl`; cache-break classification ladder + content-diff refinement (FNV-1a message signatures) |
| `src/api/parser/chatSessionParser.js` | Parser for the `chatSessions/<id>.jsonl` **patch stream** (kind 0=snapshot, 1=set, 2=array delta) → "estimated" sessions |
| `src/api/parser/cliEventsParser.js` | Copilot CLI `events.jsonl` parser; `session.shutdown` carries ground-truth totals (premium requests, nano-AIU, token details) |
| `src/api/parser/modelsJsonParser.js` | `models.json` → pricing map; per-call token cost (`computeCallCost`) |
| `src/api/parser/types.js` | JSDoc typedefs only (no runtime code) |
| `src/api/compute/sessionMetrics.js` | **Single source of truth for cost/AIC math.** AIC-derived cost preferred; learned global AIC-per-token ratio fallback; `DEFAULT_AIC_RATIO = 10597` nano-AIU/token |
| `src/api/compute/aicClassifier.js` | Per-call cost tier (expensive/moderate/low/none) via hybrid absolute + per-model percentile thresholds |
| `src/api/compute/costComputer.js` | Thin re-export shim (loadPricing, computeCallCost, formatCost) |
| `src/api/sessionApi.js` | Query/API layer: getSessions, getSessionDetail (turn grouping), getDashboard, exportSession (json/csv/markdown/**ai-review**), getCacheBreakSummary, getConversation |
| `src/db/db.js` | sql.js wrapper: init, migrations, transaction (nested = no-op), persist (exports whole DB → `fs.writeFileSync`) |
| `src/db/schema.sql` | Base schema, 10 tables: sessions, user_messages, llm_calls, tool_calls, model_switches, sync_log, model_catalog, agent_responses, discovery_events, transcripts (+ schema_version) |
| `src/db/migrations.js` | Guarded ALTERs, versions 1–4 (source_type, cache_break_detail, interruption_type, total_premium_requests) |
| `src/db/sync.js` | Discovery (3 sources), incremental sync gated by sync_log (mtime + file_size + parser_version), interruption classification, per-session DB transaction. **`PARSER_VERSION = 33` lives here** |
| `src/shared/rpc.js` | postMessage RPC (host + webview sides), 30s default timeout |
| `src/shared/formatters.js` | Display formatting + `escapeHtml` — shared host/webview |
| `src/utils/paths.js` | Cross-platform workspaceStorage discovery (macOS/Win/Linux, Stable + Insiders, dev-container fallback via `setGlobalStorageBase`), `$COPILOT_HOME`/`~/.copilot` for CLI |
| `src/ui/` | Webview: `app.js` (ESM entry, lume-js reactive store), `components/` (dashboard, sessionList, sessionDetail, tabs, timeline…), `filters.js`, `events.js`, `index.html` (CSP template) |
| `tests/` | Vitest suites mirroring `src/` (19 files, 186 tests, <1s). `tests/api/test-session-api.js` and `validate-api-live.js` are **manual** scripts against live data, not vitest |
| `scripts/` | Dev-only: `generate-demo-db.js` (+ `demo-sessions/*.json`), `db-switch.js` (swap real/demo DB — **touches your real DB**), `validate-db.js`, `verify-sync.js`, `container-smoke-test.js` |
| `docs/log-format-research.md` | **Ground-truth reference for every input format** — read before touching any parser |
| `docs/ROADMAP.md` | Product roadmap (insights engine, budget coaching) |
| `test-samples/` | **3.3 GB of REAL personal session data.** Gitignored. Never commit, never read exhaustively, never ship |
| `.devcontainer/` | Dev container that bind-mounts the host's workspaceStorage read-only |

## Input data formats (what the parsers eat)

Full verified detail in `docs/log-format-research.md`. Summary:

1. **`debug-logs/<id>/main.jsonl`** (only written when the VS Code setting
   `github.copilot.chat.agentDebugLog.fileLogging.enabled` is on). One JSON event per line:
   `{ts, type, name, spanId, parentSpanId, status, dur, attrs}`. Event types handled:
   `session_start`, `user_message`, `turn_start` (agent step, NOT a user-turn boundary),
   `child_session_ref` (title file), `agent_response`, `discovery`, `llm_request`
   (attrs: `model, inputTokens, outputTokens, cachedTokens, cacheWriteTokens,
   copilotUsageNanoAiu, ttft, debugName, systemPromptFile, toolsFile, requestOptions,
   inputMessages`), `tool_call` (attrs: `args, result`). Sidecar files:
   `models.json` (pricing; **many real files have NO `billing.token_prices` at all** — then
   token-cost is 0 and AIC-derived cost carries the session), `system_prompt_N.json`,
   `tools_N.json`, `runSubagent-*.jsonl`.
2. **`chatSessions/<id>.jsonl`** — always-written patch stream; replay to reconstruct the
   canonical session object (`requests[]`). `promptTokens` = final internal call only
   (undercounts input); `completionTokens` = cumulative (accurate). No cache/AIC data.
   Also the cross-reference for interruption detection (edited/steered/stopped/interrupted).
3. **`~/.copilot/session-state/<id>/events.jsonl`** — CLI event stream; only
   `session.shutdown` has ground-truth totals (`totalPremiumRequests`, `totalNanoAiu`,
   `tokenDetails`, `modelMetrics`). No per-call input/cache split.

## Commands

```bash
npm install                 # setup (Node 20 in devcontainer; sql.js is pure JS/wasm — no native builds)
npm test                    # vitest run — 186 tests, finishes in ~0.5s
npm run test:watch          # watch mode
npm run test:coverage       # v8 coverage (UI excluded by vitest.config.js)
npm run lint                # eslint src/ (rules downgraded to "warn" — exits 0 even with findings)
npm run build               # lint + test + package .vsix into dist/
npm run dev:vscode          # build .vsix and install into local VS Code
npm run test:container      # docker smoke test for path resolution (needs Docker)
npm run db:demo|db:restore|db:backup|db:list   # swap demo/real DB (quit VS Code first!)
```

Run/debug: open repo in VS Code and press F5 (Extension Development Host), or
`npm run dev:vscode` then "Open Copilot Cost Analyzer" from the Command Palette.

## Code conventions

- **CommonJS** (`require`/`module.exports`) everywhere except `src/ui/**` which is
  **browser ES modules** (`import`), loaded raw by the webview — no bundler anywhere.
- JSDoc `@fileoverview` on every file; typedefs centralized in `src/api/parser/types.js`.
- ES2022, 2-space indent, single quotes.
- Commits: Angular convention `<type>(<scope>): summary`; scopes include
  `parser, db, compute, sync, cost, ui, api, docs`.
- Versions stay `0.x.x` (pre-1.0). Keep `CHANGELOG.md` (Keep-a-Changelog) updated —
  new work goes under `## [Unreleased]`.
- DB access only via the `Database` wrapper (`query/queryOne/run/scalar/transaction`)
  with `$named` bind params — never string-interpolate values into SQL.
- Logging via `createLogger('<module>')` from `src/utils/logger.js` (prefix `@@@ [CCA]`).
- Webview HTML built with template strings; **all user/log-derived content must go
  through `escapeHtml`** (from `shared/formatters.js` or `ui/helpers.js`).

## Gotchas and invariants (violate these and you corrupt data or ship bugs)

1. **Bump the parser version when you change parsing/classification logic**:
   `PARSER_VERSION` (sync.js ~line 334) for debug-logs, `CHAT_PARSER_VERSION` for
   chatSessions, `CLI_PARSER_VERSION` for CLI. Otherwise already-synced sessions keep
   stale rows forever (sync is gated on mtime + file_size + parser_version).
2. **Never fabricate numbers.** chatSessions ("estimated") rows deliberately store
   `computed_aic = 0`, `computed_cost = 0`, `cached = NULL`; UI shows `—` for unknowable
   fields and `~` for estimates. `recomputeApproxSessions` explicitly excludes
   `source_type = 'chatSessions'`. Keep it that way.
3. **Cost unit model**: 1 AIC = $0.01; `copilotUsageNanoAiu` is AIC × 1e9; dollars =
   nano-AIU / 1e11. AIC-derived cost is ground truth; token×price is a fallback that
   overestimates ~8× (documented in sessionMetrics.js) — do not "fix" the preference order.
4. **`cachedTokens ⊆ inputTokens`** (VS Code semantic). Cache hit % = cached / input,
   NOT cached / (cached + input). CLI `modelMetrics.usage.inputTokens` already includes
   cache reads/writes — don't double count.
5. **Cache-break classification order matters** (mainJsonlParser.js ~line 599):
   model_switch > subagent_boundary > system_prompt_change > tools_changed >
   options_changed > compaction > retry > provider_eviction; then content-diff refinement;
   then `user_interruption` reclassification in sync.js — unless the diff proved the
   prefix byte-identical.
6. **`turn_start` is NOT a user turn.** User turns advance only on `user_message` with
   content. Subagent calls keep separate delta/cache baselines and never contribute
   model switches or user messages to the main session.
7. **Deleting a session = `deleteSessionRows()` inside a transaction** — sessions have 7
   child tables; sync always deletes + reinserts atomically.
8. **sql.js holds the entire DB in memory**; `persist()` rewrites the whole file
   (non-atomic). Don't add per-row persist calls; sync persists every 5 sessions.
9. **source_type values are load-bearing**: `'debug-logs' | 'chatSessions' | 'copilot-cli'`.
   Dashboard totals exclude `chatSessions`. The estimated→full upgrade relies on
   sync_log's `source_path` comparison (sync.js ~line 374).
10. **`test-samples/` is real private data (3.3 GB)** — employer repo names, prompts,
    file paths. It is gitignored but **NOT excluded by `.vscodeignore`** (known audit
    finding — a `vsce package` run today would ship it). Never commit it, never `grep -r`
    it wholesale, and don't move it into the package.
11. Timestamps: debug-log `ts` is epoch **ms** → stored as epoch **seconds** (float);
    chatSessions request timestamps are ms. sessionApi floors user-message timestamps to
    make same-instant events tie (see buildTurns comment) — keep that flooring.
12. `npm run lint` passes even with findings (rules are "warn") — don't treat exit 0 as clean.

## What NOT to touch

- **`test-samples/`** — read a few files for format reference only; never modify/commit.
- **`scripts/db-switch.js`, `verify-sync.js`, `validate-db.js`** run against the user's
  REAL extension DB under `~/Library/Application Support/Code/User/globalStorage/…` —
  do not run casually.
- **`docs/log-format-research.md`** encodes verified ground truth (incl. a
  user-confirmed session). Don't edit signatures/thresholds (e.g. the ±2s steering
  window) without new evidence.
- **`src/db/schema.sql` base tables** — schema changes go in `src/db/migrations.js` as a
  new guarded version, plus the same column added to schema.sql for fresh installs
  (see migration 1's pattern).
- The `_msgSig` transient field on llm calls must be deleted before rows reach the DB
  layer (parser does this) — don't persist it.
