# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
with the following constraint: **all versions are 0.x.x** (pre-1.0) while the
extension is in active development.

## [Unreleased]

## [0.6.15] - 2026-06-10

### Initial Public Release
- **Analytics Engine**: Extract and parse GitHub Copilot debug logs from VS Code workspace storage.
- **Cost Computation**: Real-time token usage calculation based on dynamic `models.json` pricing.
- **Cache Intelligence**: Advanced cache break classification (compaction, model switches, subagent boundaries).
- **Webview UI**: Built-in interactive dashboard showing session timeline, tool leaderboards, model switches, and conversational context.
- **Local Persistence**: All session data is persisted locally using in-memory SQLite (via `sql.js`).
