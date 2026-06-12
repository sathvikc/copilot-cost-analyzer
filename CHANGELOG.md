# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
with the following constraint: **all versions are 0.x.x** (pre-1.0) while the
extension is in active development.

## [Unreleased]

### Fixed
- **Cost display shows `~` prefix for limited-quality sessions** — sessions without `cachedTokens` data in debug logs had their cost silently overestimated (all input treated as fresh). Session detail cost card and dashboard cost card now prefix with `~` to signal this. Quality is auto-detected from the presence of `cachedTokens` in the log data.
- **Dashboard header cost replaced static `est.` with conditional `~`** — `~` now only appears when at least one session in the filtered view has limited data quality, instead of always showing `est.`.
- **Panel-open sync respects `autoSyncOnStartup` setting** — both the panel-reveal and panel-create paths now gate sync on the user's setting. Previously the setting was only respected on extension startup, not on subsequent panel opens.

### Removed
- **`copilotCostAnalyzer.dataCutoffDate` setting** — data quality was never date-driven. It is determined automatically by whether `cachedTokens` is present in the debug log. The setting has been removed.

## [0.6.15] - 2026-06-10

### Initial Public Release
- **Analytics Engine**: Extract and parse GitHub Copilot debug logs from VS Code workspace storage.
- **Cost Computation**: Real-time token usage calculation based on dynamic `models.json` pricing.
- **Cache Intelligence**: Advanced cache break classification (compaction, model switches, subagent boundaries).
- **Webview UI**: Built-in interactive dashboard showing session timeline, tool leaderboards, model switches, and conversational context.
- **Local Persistence**: All session data is persisted locally using in-memory SQLite (via `sql.js`).
