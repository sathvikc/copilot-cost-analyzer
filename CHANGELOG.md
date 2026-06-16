# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
with the following constraint: **all versions are 0.x.x** (pre-1.0) while the
extension is in active development.

## [0.9.0] - 2026-06-16

### Added
- **Clearer cache-break reasons in the Cache tab** — when the provider drops a cached prefix that was actually unchanged (a true eviction, or a TTL expiry after an idle gap), the call is now labeled **Cache Evicted** / **Cache Expired** and reports how many cached tokens were lost, instead of vaguely blaming the most recent messages. When a message *inside* the cached prefix really did change, it's pinpointed as **Prefix Edited** at the exact message. The verdict comes from a content-level diff of the request history, so the stated cause is evidence-backed rather than inferred from token counts alone.

### Changed
- **Sharper tooltips for prompt-prefix breaks** — the `Sys Prompt` and `Tools Changed` badges now explain that the cached prefix diverged at that point, and idle-gap evictions are attributed to provider cache TTL.

## [0.8.0] - 2026-06-14

### Added
- **Adapts to whatever Copilot data is available** — when agent debug file logging is on, sessions show full cost, cache, and retry detail as before. When it's off, the dashboard is no longer blank: a setup view explains how to enable logging, and you can fall back to Copilot's always-on chat history to see those sessions with an estimated cost (badged `~ est`). Estimated sessions are clearly labeled, sit behind a one-time opt-in, and upgrade to full detail automatically once logging is enabled. A header **⚙ Setup** button returns you to the setup view any time.

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
