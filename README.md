# Copilot Cost Analyzer

<p align="center">
  <img src="assets/icons/icon.png" width="128" alt="Copilot Cost Analyzer Logo">
</p>

A VS Code extension that visualizes **token costs**, **cache behavior**, and **tool call impact** for GitHub Copilot Chat sessions.

> **Data-first analytics.**
>
> The extension shows you what happened in each Copilot Chat session — which tools ran, how many tokens they sent, when the cache broke, and what model switches cost you. For older sessions missing exact telemetry, intelligent approximations are used. You interpret the data.

---

## Demo

![Demo](assets/screenshots/demo.gif)

---

## Features

### Session Dashboard
- All Copilot Chat sessions discovered across **all workspaces** (Stable + Insiders)
- Per-session cost (USD), token counts, model usage, and data quality badges
- Search/filter by session ID, title, workspace path, or quality level

### Per-Session Detail

| Tab | What it shows |
|-----|---------------|
| **Timeline** | Turn-by-turn view of LLM calls and tool calls with token deltas, thinking content toggle, and activity filters |
| **Tools** | Tool leaderboard — which tools ran most, result sizes, and compression method counts |
| **Model Switches** | Every model change mid-session, with cache preserved % and input delta |
| **Cache** | Cache break analysis — sparkline graph, per-call table with break type classification and badges |

### Cache Break Classification

Each cache break is automatically classified with a cause:

| Badge | Type | Trigger |
|-------|------|---------|
| 🔄 Compaction | `compaction` | Conversation trimmed to fit context window (input tokens also dropped) |
| 🔀 Model Switch | `model_switch` | Model changed between consecutive calls |
| 🔗 Subagent | `subagent_boundary` | Switched to/from a subagent |
| ⚙️ Sys Prompt | `system_prompt_change` | System prompt was rebuilt (sidecar file reference changed) |
| 🛠 Tools Changed | `tools_changed` | Tool definitions changed between requests |
| ⚙ Options Changed | `options_changed` | Request options changed (e.g. `reasoning.effort`, `include`) |
| ↻ Retry | `retry` | Cache lost after a failed call was retried |
| ⚠ Possible Eviction | `provider_eviction` | No identifiable cause — likely provider cache TTL expiration |

Classification uses a priority hierarchy: `compaction > model_switch > subagent_boundary > system_prompt_change > tools_changed > options_changed > retry > provider_eviction`

### Persistent Storage
- SQLite database (`sql.js`) survives VS Code log cleanup
- Incremental sync — only re-parses changed sessions
- Parser version tracking forces re-sync when classification logic improves

---

## Screenshots

### Session Dashboard

![Session Dashboard](assets/screenshots/dashboard.png)

> All sessions across workspaces with aggregate stats (total AIC, estimated cost), per-model breakdown with cache hit rates, workspace summary, tools leaderboard, and a weekly activity chart.

### Session Detail — Timeline Tab

![Timeline](assets/screenshots/session-timeline.png)

> Turn-by-turn view of every LLM call with input/output/cache token counts, latency, AIC cost badge, and cold-start detection.

### Cache Break Analysis

![Cache Tab](assets/screenshots/session-cache.png)

> Sparkline chart + per-call table showing exactly when and why the prompt cache broke — with typed badges (`⚠ Possible Eviction`, `🛠 Tools Changed`, etc.) and cache delta per call.

### Model Breakdown

![Model Breakdown](assets/screenshots/session-model-switch.png)

> Per-model token and cost breakdown for sessions that switch models mid-conversation — with individual cache hit rates per model.

### Conversation View

![Conversation](assets/screenshots/session-conversation.png)

> Full conversation replay — user prompts and Copilot responses side by side, with turn grouping and markdown rendering.

---

## Data Sources

The extension reads from Copilot's **debug log files** stored in VS Code's workspace storage:

```
workspaceStorage/<hash>/GitHub.copilot-chat/
├── debug-logs/<session-id>/
│   ├── main.jsonl              ← Primary data source (all events)
│   ├── models.json             ← Model pricing data
│   ├── system_prompt_0.json    ← System prompt snapshots (sidecar)
│   ├── system_prompt_1.json
│   ├── tools_0.json            ← Tool catalog snapshots (sidecar)
│   └── tools_1.json
└── transcripts/<session-id>.jsonl  ← Conversation transcripts
```

### What we parse from `main.jsonl`

Each `llm_request` entry contains:

| Field | Used for |
|-------|----------|
| `model`, `inputTokens`, `outputTokens`, `cachedTokens` | Cost computation, cache analysis |
| `debugName` | Retry detection, call labeling |
| `systemPromptFile` | System prompt change detection |
| `toolsFile` | Tool catalog change detection |
| `requestOptions` | Request options change detection |
| `requestShape` | Continuation vs full request identification |
| `inputMessages` | Available but not yet parsed (future: structural diff) |
| `ttft` | Time to first token |
| `copilotUsageNanoAiu` | AI credit usage |

### Relation to VS Code's Cache Explorer

VS Code has a built-in **Cache Explorer** (in `Agent Debug Logs`) that does **structural prefix diffing** — it compares the actual prompt content character-by-character. Our extension uses **token-count heuristics** and **file-reference tracking** instead, which is less precise but enables:

- **Historical persistence** — Cache Explorer only shows recent sessions
- **Cross-session analysis** — compare patterns across sessions and time
- **Cost correlation** — tie cache breaks to dollar impact
- **Aggregate statistics** — sparklines, break counts by type

### Dev Containers & Codespaces

The extension finds your sessions automatically in most setups. There are two cases:

**1. You use Copilot Chat *inside* the container/Codespace** — nothing to configure. Copilot writes its logs to the container, and the extension finds them automatically.

**2. Your Copilot history is on your computer (the host)** — the logs live on your machine, not in the container, so you mount them in. Add **one line** to the `mounts` array in your project's `.devcontainer/devcontainer.json` (pick the line for your host OS), then **Dev Containers: Rebuild Container**:

```jsonc
"mounts": [
  // macOS host:
  "source=${localEnv:HOME}/Library/Application Support/Code/User/workspaceStorage,target=${containerEnv:HOME}/.config/Code/User/workspaceStorage,type=bind,readonly=true"

  // Windows host:
  // "source=${localEnv:APPDATA}/Code/User/workspaceStorage,target=${containerEnv:HOME}/.config/Code/User/workspaceStorage,type=bind,readonly=true"

  // Linux host:
  // "source=${localEnv:HOME}/.config/Code/User/workspaceStorage,target=${containerEnv:HOME}/.config/Code/User/workspaceStorage,type=bind,readonly=true"
]
```

The mount is **read-only** — nothing on your machine is modified. `${containerEnv:HOME}` resolves the container user automatically, so this works whether your container user is `node`, `vscode`, or anything else.

---

## Installation

### From Source (Development)

```bash
# 1. Clone the repository
git clone https://github.com/sathvikc/copilot-cost-analyzer.git
cd copilot-cost-analyzer

# 2. Install dependencies
npm install

# 3. Run tests
npm test

# 4. Build and install into VS Code
npm run dev:vscode

# Or open in VS Code and press F5 for Extension Host
```

### From VS Code Marketplace (Coming Soon)

Search for **"Copilot Cost Analyzer"** in the Extensions panel.

---

## Usage

1. **Open the panel**
   - Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) → "Open Copilot Cost Analyzer"
   - Or click the icon in the activity bar

2. **Sync your sessions**
   - Click the **Sync** button to scan all Copilot debug logs from `workspaceStorage/`
   - Sessions are parsed, costs computed, and stored in SQLite
   - Auto-sync on startup is enabled by default

3. **Explore a session**
   - Click any session in the sidebar
   - Switch between **Timeline**, **Tools**, **Model Switches**, and **Cache** tabs

4. **Filter and search**
   - Use the search box to filter by session ID, title, or workspace path
   - Use the quality dropdown to show only sessions with full cache data
   - Use Activity filter checkboxes to show/hide LLM calls, subagents, thinking content

---

## Data Quality

Sessions are marked with a data quality badge:

| Badge | Meaning |
|-------|---------|
| **Full** | At least one LLM call carries `cachedTokens` data, so cache analysis and exact cost/token metrics are available. |
| **Limited** | No `cachedTokens` present — cache analysis is unavailable and cost/token metrics use intelligent approximations. |

The badge is derived from the data itself (whether any call reports `cachedTokens`), not from a date.

### Estimated sessions

When Copilot's debug logging is **off**, the extension can still read the always-written
`chatSessions/*.jsonl` files as a fallback. These sessions are marked **estimated**
(`source_type = 'chatSessions'`): costs are inferred without token pricing, so they render
with a `~` prefix and are always **Limited**. They stay hidden behind an opt-in until you
choose **View N estimated sessions** in the setup notice; the header **⚙ Setup** button takes
you back to those instructions at any time. Enabling debug logging upgrades future sessions to
**Full**.

---

## Architecture

```
Copilot debug logs  (VS Code workspaceStorage on disk)
  main.jsonl · models.json · transcripts/*.jsonl · chatSessions/*.jsonl
                          │
                          ▼
                      sync.js
              discovers sessions, orchestrates parsing
                          │
           ┌──────────────┴──────────────┐
           ▼                             ▼
  mainJsonlParser.js            modelsJsonParser.js
  LLM calls, tool calls,        pricing map +
  user messages, switches,      per-call cost
  cache breaks, transcripts
           │                             │
           └──────────────┬──────────────┘
                          ▼
                compute/ (cost, AIC, metrics)
                          │
                          ▼
              SQLite — copilot-analytics.db
                      (sql.js, 10 tables)
                          │
                          ▼
                   sessionApi.js
                 queries DB, formats data
                          │
              postMessage RPC  (shared/rpc.js)
                          │
                          ▼
                  Webview Panel (ES modules)
        Timeline · Cache · Tools · Switches · Conversation
```

### Tech Stack

| Layer | Choice |
|-------|--------|
| Language | Node.js / JavaScript (ES2022) |
| UI | Webview Panel with ES modules |
| Parser | Node.js `readline` for JSONL streaming |
| Database | **sql.js** (pure JS SQLite, 10 tables) |
| Charts | Hand-rolled `<canvas>` sparklines |
| RPC | `postMessage`-based bridge (no HTTP server) |
| Tests | **Vitest** (159 tests across 15 test files) |

---

## Prior Art

This project is inspired by the existing VS Code extension **Token Cost Tracker** (`netcomlabs-ai.copilot-cost-token-tracker`). It builds on that foundation and adds:

- Cache break detection and classification (8 types)
- Tool call impact analysis
- Model switch tracking
- Persistent SQLite storage with incremental sync
- Dynamic pricing from `models.json`
- Thinking content toggle
- Activity filters

You can run both extensions side-by-side for comparison.

> **Why rebuild?** Token Cost Tracker is a closed-source extension. This project is **fully open source** (MIT) so anyone can inspect, contribute, or fork the code. See the [repository](https://github.com/sathvikc/copilot-cost-analyzer) to get involved.

---

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `copilotCostAnalyzer.autoSyncOnStartup` | `true` | Automatically sync debug logs when VS Code starts |
| `copilotCostAnalyzer.debugLogging` | `false` | Enable verbose debug logging in the extension and webview console |

---

## Development

### Commit Convention

All commits follow the **Angular Commit Message Convention**:

```
<type>(<scope>): <short summary>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`

Scopes: `parser`, `db`, `compute`, `panel`, `webview`, `theme`, `sync`, `cost`

### Scripts

| Command | Purpose |
|---------|---------|
| `npm test` | Run unit tests (Vitest, 159 tests) |
| `npm run test:watch` | Watch mode for tests |
| `npm run build` | Lint + test + package `.vsix` |
| `npm run dev:vscode` | Build and install into VS Code |
| `npm run install:vscode` | Install latest `.vsix` into VS Code |

### Key Files

| Path | Purpose |
|------|---------|
| `src/api/parser/mainJsonlParser.js` | JSONL parser + cache break classification |
| `src/api/parser/types.js` | JSDoc type definitions |
| `src/api/sessionApi.js` | All API functions (session queries) |
| `src/api/compute/costComputer.js` | Cost computation from model pricing |
| `src/api/compute/aicClassifier.js` | AI credit classification |
| `src/db/schema.sql` | Database schema (10 tables) |
| `src/db/migrations.js` | Schema migrations (1: adds `source_type` to sessions) |
| `src/db/sync.js` | Session discovery + incremental sync |
| `src/ui/` | Webview UI (ES modules) |
| `src/shared/rpc.js` | postMessage RPC bridge |

### Versioning

All versions are **0.x.x** while the project is in active development.

---

## License

[MIT](LICENSE) — Sathvik Cheela
