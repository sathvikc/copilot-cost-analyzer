# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
with the following constraint: **all versions are 0.x.x** (pre-1.0) while the
extension is in active development.

## [Unreleased]

### Added
- **Sources filter** — a multi-select dropdown beside the workspace filter for choosing which sources to show: 🖥 VS Code, 🟢 VS Code Insiders, ⌘ Copilot CLI, 📦 Remote / Dev Container. All are selected by default; the dropdown only appears when more than one source exists. The source is derived from each session's storage path, so existing rows work without a re-sync. (VS Code Insiders sessions were already being discovered — this makes them visible *as* Insiders.) The Dashboard respects the same filter.
- **🧠 Copy AI Review Prompt** — one click in the session header copies a compact (~1–2k token), self-contained markdown pack: an instruction preamble, a glossary, measured session facts (tokens, cache hit, cost/AIC, premium requests, cache breaks by cause, retries, top tools), and a turn-by-turn digest with each turn's end state (completed/steered/stopped/edited) and verbatim prompts. Paste it into any AI agent to get evidence-based coaching on your usage habits — the agent never needs to parse megabytes of raw logs. Multi-day resumed sessions report "resumed over N days" instead of a misleading duration.
- **Copilot CLI sessions** — sessions from the Copilot CLI (`~/.copilot/session-state/`, or `$COPILOT_HOME/session-state`) are now discovered and analyzed alongside VS Code chats, marked with a `⌘ CLI` badge. The CLI's `session.shutdown` event supplies ground-truth totals: **billed premium requests** (shown as a header pill — the actual usage-based-billing unit), real nano-AIU, and input / cache-read / cache-write / output token counts. A crashed CLI session without a shutdown record is stored as limited quality; nothing is fabricated. The per-call cache/retry tabs explain that the CLI logs no per-call breakdown.
- **Interruption classification** — turns are now labeled by *how* they ended instead of a single "canceled" flag: **✏ edited & resent** (message removed from chat history), **⚡ steered** (you sent your next message mid-run; detected by the machine-fast ≤2s gap between the canceled run and the next request), **⏹ stopped** (Stop pressed), and **⚠ interrupted** (run ended with no recorded result). Signatures were verified against a ground-truth session and the full test-sample corpus; the research is documented in `docs/log-format-research.md`.
- **`user_interruption` cache-break type** — a cache break on the first call after an interrupted/edited/steered turn is now attributed to the history rewrite that interruption caused, instead of being mis-labeled "Possible Eviction". A content-diff-confirmed byte-identical prefix still wins: those remain true evictions.
- **Roadmap** (`docs/ROADMAP.md`) — the plan for turning causal data into per-session dollar insights and budget coaching for the usage-based-billing era.

### Fixed
- **Edited messages no longer render as "canceled"** — editing a sent message previously showed the same strikethrough/"canceled" label as pressing Stop; the two are now distinguished (only edited turns strike through, with an "edited & resent" badge).
- **Steering no longer mislabels the interrupted turn** — a turn interrupted by your own follow-up message was flagged "canceled" while the explicitly-stopped turn next to it showed nothing; both now carry their correct badges.
- **"Open Log" for non-debug-log sessions** — the button appended `/main.jsonl` to every source path; chatSessions/CLI sessions now open their actual log file.

## [0.9.0] - 2026-06-16

### Added
- **Clearer cache-break reasons in the Cache tab** — when the provider drops a cached prefix that was actually unchanged (a true eviction, or a TTL expiry after an idle gap), the call is now labeled **Cache Evicted** / **Cache Expired** and reports how many cached tokens were lost, instead of vaguely blaming the most recent messages. When a message *inside* the cached prefix really did change, it's pinpointed as **Prefix Edited** at the exact message. The verdict comes from a content-level diff of the request history, so the stated cause is evidence-backed rather than inferred from token counts alone.
- **Opening a chat from another workspace asks where to open it** — when a session belongs to a different workspace than the one you're in, the extension offers to open it in the current window or to open that workspace in a new window (so the chat's file references resolve), instead of silently opening it in the wrong context.

### Changed
- **Sharper tooltips for prompt-prefix breaks** — the `Sys Prompt` and `Tools Changed` badges now explain that the cached prefix diverged at that point, and idle-gap evictions are attributed to provider cache TTL.
- **Estimated sessions are clearer about what they don't know** — chat-history-only (estimated) sessions are now excluded from Dashboard totals (count, tokens, cost, AI Credits, workspaces) and show "—" for fields that need debug logs (input, cache, cost, AI Credits); only the output token count is shown, marked `~` because it's estimated from the response text. The earlier header "estimated" pill and "requires debug logs" card are replaced with lighter inline `~` markers and a short limited-data note.

## [0.8.0] - 2026-06-14

### Added
- **Adapts to whatever Copilot data is available** — when agent debug file logging is on, sessions show full cost, cache, and retry detail as before. When it's off, the dashboard is no longer blank: a setup view explains how to enable logging, and you can fall back to Copilot's always-on chat history to surface those sessions as estimated. Estimated sessions are clearly labeled, sit behind a one-time opt-in, and upgrade to full detail automatically once logging is enabled. A header **⚙ Setup** button returns you to the setup view any time.

## [0.7.0] - 2026-06-12

### Added
- **Works in dev containers and Codespaces** — the extension now finds your Copilot sessions when VS Code is running inside a dev container or GitHub Codespace, not just on a regular desktop install. Existing macOS, Windows, and Linux desktop behavior is unchanged.

### Fixed
- **Cost always shows, even for older sessions** — sessions that didn't have billing data in their logs previously showed $0.00. They now show an estimated cost based on token pricing, marked with `~`.
- **Cost marked `~` only when data is incomplete** — the `~` prefix now only appears when the extension cannot confirm the exact cost for a session (incomplete log data). Sessions with full data show exact costs without the prefix.
- **Sync button shows "Syncing…" from the moment sync starts** — previously the button only showed the syncing state when you clicked it manually. On first open, it now shows syncing while the background scan is running.
- **Syncing cost estimates stay accurate as you add sessions** — syncing a session with billing data now immediately updates the cost estimates of all older sessions, so figures stay consistent without needing a manual re-sync.
- **Manual sync always confirms what happened** — clicking Sync now always shows a result message ("Everything is up to date", "Synced 5 new sessions", etc.) instead of silently doing nothing when there were no new sessions.
- **"Open panel" setting is respected on every open** — the Auto-sync on startup setting was previously only applied once at startup; it now applies every time you open the panel.

### Removed
- **`copilotCostAnalyzer.dataCutoffDate` setting** — this setting had no effect. Data quality is determined automatically from what's available in the session logs, not from a date threshold.

## [0.6.15] - 2026-06-10

### Initial Public Release
- **Analytics Engine**: Extract and parse GitHub Copilot debug logs from VS Code workspace storage.
- **Cost Computation**: Real-time token usage calculation based on dynamic `models.json` pricing.
- **Cache Intelligence**: Advanced cache break classification (compaction, model switches, subagent boundaries).
- **Webview UI**: Built-in interactive dashboard showing session timeline, tool leaderboards, model switches, and conversational context.
- **Local Persistence**: All session data is persisted locally using in-memory SQLite (via `sql.js`).
