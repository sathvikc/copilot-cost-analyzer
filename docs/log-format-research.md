# Copilot Log Format Research

Findings from studying the raw session stores that ship with VS Code Copilot Chat
and the Copilot CLI. Everything below was verified against real captured data in
`test-samples/` (893 chatSessions files, 104 CLI sessions), including one session
with **user-confirmed ground truth** for every interruption kind.

## 1. The three session stores

| Store | Written when | What it has | What it lacks |
|-------|-------------|-------------|---------------|
| `workspaceStorage/<hash>/GitHub.copilot-chat/debug-logs/<id>/main.jsonl` | only while `agentDebugLog` is enabled | per-call tokens, cache split, AIC, tool results, sidecar prompt/tool snapshots | canceled in-flight calls are never logged with token counts |
| `workspaceStorage/<hash>/chatSessions/<id>.jsonl` | always | canonical chat history, per-request `result` (timings, errorDetails), edit/cancel evidence | per-call input/cache tokens, AIC |
| `~/.copilot/session-state/<id>/events.jsonl` (CLI; `$COPILOT_HOME` overrides `~/.copilot`) | always | full event stream + **ground-truth session totals**: premium requests, nano-AIU, input/cache_read/cache_write/output, per-model metrics | per-call input/cache split |

The three complement each other; the extension now reads all three
(`source_type` = `debug-logs` / `chatSessions` / `copilot-cli`).

## 2. chatSessions is a patch stream

`chatSessions/<id>.jsonl` is an op-log:
`kind:0` = full snapshot, `kind:1` = set value at key-path `k`, `kind:2` = array
delta (append / merge-by-index). Replaying it yields the canonical session object
with a `requests[]` array — one entry per user-visible turn.

## 3. How a turn ends — the `result` signatures

Ground truth: session `18d04628…` where the user confirmed exactly what they did
(see `test-samples/IMG_4775.HEIC`).

| What the user did | `requests[i].result` signature | Extra evidence |
|---|---|---|
| Turn completed normally | `{ timings, metadata, … }` | — |
| **Steered** — sent the next message while the agent was running | `errorDetails.code === 'canceled'`, `responseIsIncomplete: true` — and the **next request is dispatched machine-fast**: `next.timestamp − (timestamp + timings.totalElapsed)` was **0.28–0.5 s** across every confirmed case in the corpus | VS Code cancels the in-flight run and immediately starts a new request carrying the steering text |
| **Stopped** (Stop button), then manually resent | either the same `canceled` marker with a **human-speed gap** (≥ 4.5 s … minutes), or `result` written as **`{}`** (observed when the agent was in a non-graceful state, e.g. inside an error-retry wait) | debug log shows a clean `turn_end` with **no `llm_request` logged** for the aborted step |
| **Edited & resent** a sent message | the original request is **removed from `requests[]` entirely** — no marker | the debug log still contains the original `user_message` |
| Window closed / crashed mid-run | `result` `{}` or never written | debug log ends mid-turn |

Classification rules implemented (`chatSessionParser.classifyRequestEnd`,
`sync.computeInterruptions`):

```
absent from chat history                          → edited
canceled  && gap-to-next within ±2 s              → steered
canceled  && otherwise                            → stopped
unrecorded result && NOT the last request         → interrupted
unrecorded result && last request                 → (no flag — may still be running)
```

The ±2 s window separates machine-driven dispatch (0.3–0.5 s observed) from human
typing (≥ 4.5 s observed). Duplicated/forked session files can produce a *negative*
gap ≈ −elapsed (repeated requests with identical timestamps); those fall outside
the window and correctly read as `stopped`.

Corpus stats (893 chatSessions files): 41 requests with the `canceled` marker —
5 of them machine-fast (steering) — plus 23 empty-result and 60+ never-written-result
requests, concentrated in sessions whose prompts describe stuck/interrupted runs.

## 4. Aborted calls in the debug log

Debug logs never record token counts for a canceled in-flight call. The
signature of an aborted step is a `turn_start` → `turn_end` span containing **no
`llm_request`**, immediately followed by the next `user_message`. This is why an
interruption is invisible to pure token-count analysis — and why the *next* turn
often shows a large unexplained cache drop.

## 5. Cache-break classification (updated ladder)

Priority: `model_switch / subagent_boundary / system_prompt_change /
tools_changed / options_changed` (identity changes) → `compaction` → `retry` →
`provider_eviction`.

`provider_eviction` is then refined:

1. **Content diff** (when `inputMessages` prefixes are comparable):
   byte-identical prefix → true **eviction / TTL expiry** (never blamed on
   appended content); a change *inside* the prefix → **prefix edited**.
2. **NEW — `user_interruption`**: if the previous turn was
   steered / stopped / interrupted / edited, the aborted turn's partial output
   is rewritten out of the history before the next request, so the cached prefix
   diverges there. Any `provider_eviction` on the first call after an
   interrupted turn is reclassified to `user_interruption` — **unless** the
   content diff proved the prefix byte-identical (then the eviction stands).

Verified in the ground-truth session: after the stopped turn, the next call's
cache fell 106,827 → 31,438 tokens; the content diff localized the change inside
the prefix and the reclassifier attributed it to the interruption. The *other*
break in that session (cached → 0 after an 11-minute idle gap, byte-identical
prefix) correctly stayed a TTL eviction.

## 6. Copilot CLI event stream

`~/.copilot/session-state/<id>/events.jsonl`, one JSON event per line
(`type`, `data`, `timestamp`, `id`, `parentId`). Types observed in
copilot-agent 1.0.x:

- `session.start` — sessionId, copilotVersion, `context.cwd/gitRoot/repository/branch`
- `session.model_change` — `newModel` (fires once at startup; later ones are real switches)
- `user.message` — `content`, `delivery` (`'idle'` = sent while agent idle)
- `assistant.message` — `model`, `content`, `reasoningText`, **`outputTokens`** (per message), `toolRequests`
- `tool.execution_start` / `tool.execution_complete` — toolCallId, toolName, arguments / success, result
- `abort` — **`reason: 'user_initiated'`** = the user pressed Esc/Ctrl+C (explicit-cancel ground truth)
- `subagent.started` / `subagent.completed`
- `session.shutdown` — **ground-truth totals**: `totalPremiumRequests`,
  `totalNanoAiu`, `tokenDetails` (input / cache_read / cache_write / output),
  `totalApiDurationMs`, per-model `modelMetrics` (requests.count/cost + usage),
  and a context breakdown (`systemTokens`, `conversationTokens`,
  `toolDefinitionsTokens`)

Notes:
- Per-call input/cache tokens are **not** logged; only `outputTokens` per
  assistant message. Session totals come from `session.shutdown`; a
  crashed/killed session has none → stored as `limited` quality, nothing fabricated.
- `modelMetrics[model].usage.inputTokens` already includes cache reads+writes,
  matching the VS Code semantic where `cachedTokens ⊆ inputTokens`.
- `totalPremiumRequests` is the actual UBB billing unit — the only place in any
  Copilot log where billed units appear directly.

## 7. Relation to AI Credits (UBB, effective June 1 2026)

GitHub bills AI Credits consumed by token usage (input, output, cached) at
published per-model API rates; plans include a monthly credit allowance equal to
the subscription price. `copilotUsageNanoAiu` (VS Code) and `totalNanoAiu` (CLI)
are the same nano-AIU unit: **1 AIU = $0.01** (`cost = nanoAiu / 1e11` dollars),
which is what the extension's AIC-derived cost math already assumes.
