# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
with the following constraint: **all versions are 0.x.x** (pre-1.0) while the
extension is in active development.

## [Unreleased]

### Added
- **See your sessions even with debug logging off** — previously, if Copilot's agent debug file logging wasn't enabled, the dashboard was blank. The extension now falls back to Copilot's always-on chat history and shows those sessions with an estimated cost, badged `~ est`.
- **Estimated sessions upgrade automatically** — once you enable debug logging, any session that gains full logs is upgraded in place with its exact cost, cache, retry, and sub-agent details. The same session is never duplicated.
- **Clear labeling for estimated data** — estimated sessions are badged throughout, their model breakdown notes that cost and AIC are estimated, and the Cache and Retries views show a "requires debug logs" notice instead of an empty panel.

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
