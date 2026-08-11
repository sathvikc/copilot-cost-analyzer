# Roadmap — from "data viewer" to "credit coach"

Copilot moved to usage-based billing on **June 1, 2026**: every plan now gets a
monthly AI-Credit allowance equal to its price (Pro $10 → $10 of credits) and
credits burn with token usage — including cached tokens — at per-model API
rates. The tools people had ("you used N tokens today") stopped answering the
question that matters: **"why did I burn credits, and what should I do
differently?"**

Competing extensions (Token Cost Tracker, AI Engineering Fluency, Token-Track,
Eating Token, Copilot Budget, ghcpCliDashboard…) all show *totals*. None of them
explain *causes*. This project's edge is causal analysis: cache-break
classification, interruption detection, retry cost, model-switch cost — each one
maps to a behavior the user can change. The roadmap leans into that.

## Now shipped (this release)

- **Interruption classification** — edited / steered / stopped / interrupted,
  from cross-referencing chat history against debug logs (see
  `docs/log-format-research.md` §3).
- **`user_interruption` cache-break type** — stops blaming the provider for
  breaks the user's own stop/edit/steer caused.
- **Copilot CLI support** — full session ingestion incl. ground-truth premium
  requests, nano-AIU, and token totals from `session.shutdown`.
- **Source filter** — a Sources multi-select beside the workspace filter
  (VS Code / VS Code Insiders / Copilot CLI / Remote & Dev Container), derived
  from each session's source path; hidden when only one source exists.
- **AI review pack (v1)** — "🧠 Copy AI Review Prompt" in the session header
  exports a self-contained, ~1–2k-token markdown pack (instruction preamble +
  measured session facts + turn-by-turn digest with end states and cache
  events) that can be pasted into any agent for habit coaching. The point:
  the reviewing agent gets pre-digested evidence instead of parsing megabytes
  of raw logs — no noise, minimal tokens.

## Next: the Insights engine (highest user value)

A per-session "Why did this cost what it cost?" panel plus a cross-session
habits view. Every insight = observation + dollar impact + one-line fix. All
computable from data we already store:

1. **Wasted-credit breakdown per session**
   - Cache-break cost: for each break, `(tokens re-sent uncached) × (input − cached
     rate)` — a dollar figure per break type. "Model switching cost you ~$0.42
     this session. Pin one model for the whole session to avoid it."
   - Interruption cost: tokens of the discarded partial turns + the prefix
     re-write they trigger. "Stopping mid-run and resending cost ~$0.31 — prefer
     steering (just type; don't press Stop first): it keeps more of the prefix warm."
   - Retry cost is already computed; give it a dollar figure too.
2. **Habit trends (Dashboard)**
   - Cache-hit % over time, interruptions per session, breaks by type per week —
     "your cache hit rate rose from 62% → 84% since you stopped switching models."
3. **Budget awareness**
   - Setting for plan allowance ($10/$19/$39). Header burn meter: credits used
     this month (real AIC + CLI premium requests), forecast vs. allowance,
     "on pace to run out on the 24th."
4. **Idle-TTL coaching**
   - We already detect TTL evictions and the idle gap. Teach it: "Gaps over
     ~5 min restart the cache cold. Batch your follow-ups; a cold restart on
     this session's context costs ~$0.18."

## Next: review packs grow up

The v1 per-session pack generalizes into a family of "give the agent exactly
what it needs" exports:

1. **Period review pack** — same idea across a date range: sessions per
   workspace, what was built (first prompts + titles), total cost, efficiency
   trend (cache hit %, interruptions/session over time), habit changes. Two
   preambles for the same data: *coach mode* ("what should I change next
   half?") and *review mode* ("draft accomplishment bullets for my half-yearly
   Workday review — evidence-based, no inflation"). The second one writes the
   performance-review section nobody enjoys writing, from data that actually
   exists.
2. **Chat participant / MCP tool** — instead of copy-paste, expose the same
   digested packs as an `@costAnalyzer` chat participant (or MCP tool) so the
   user can ask "why was yesterday expensive?" inside Copilot Chat and the
   model receives the digest, never the raw logs.
3. **Session compare pack** — two sessions side by side ("before/after I
   stopped switching models"), for verifying a habit change actually paid off.

## Then

- **Per-model metrics for CLI sessions** — `session.shutdown.modelMetrics` has
  real per-model usage; plumb it into the model-breakdown cards instead of the
  current "—".
- **Educational mode** — a "Learn" tab: what prompt caching is, why edits break
  it, what compaction is, with the user's *own sessions* as examples. This is
  the "teach users to use AI models without burning tokens" goal, using their
  data instead of abstract advice.
- **Status-bar burn meter** (month-to-date credits, click → dashboard).
- **Timed habit nudges — on our own surfaces.** Verified (VS Code source
  `chatTipCatalog.ts` + the shipped Insiders bundle): the Copilot Chat tips
  area is fed by a compile-time `TIP_CATALOG` inside the workbench;
  `IChatTipService` is core-internal with no extension API, contribution
  point, or product/experiment feed — extensions cannot inject tips there.
  So timed nudges ("your cache expired 3× today") must use extension-owned
  surfaces: `showInformationMessage` with actions, a status-bar lightbulb,
  or a tips strip in our panel. (Getting a tip added for *everyone* is a PR
  to microsoft/vscode's catalog, not an extension feature.)
- **Export/report** — weekly Markdown cost report (per workspace, per model,
  top waste causes) for team leads under org budget caps.
- **JetBrains/Visual Studio parity research** — same chatSessions format?

## Explicitly out of scope

- Anything requiring a GitHub API token (billing API) — the local-first,
  zero-auth design is a feature.
- Fabricated numbers. Estimated values stay visibly `~`-prefixed; missing data
  stays "—". Trust is the product.
