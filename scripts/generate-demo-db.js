#!/usr/bin/env node
/**
 * generate-demo-db.js — Populate a demo SQLite database from JSON session files.
 *
 * Usage:
 *   node scripts/generate-demo-db.js [--out <path>]
 *
 * Reads:  scripts/demo-sessions/*.json
 * Writes: scripts/demo.db  (or the path given via --out)
 *
 * Each JSON file describes one complete session. The script computes costs and
 * AIC from token counts + model prices, detects model switches automatically,
 * and inserts all rows in a single transaction per session.
 *
 * JSON format: see scripts/demo-sessions/ for examples.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createRequire } = require('module');

// Use the project's Database class (handles schema init + migrations)
const { Database } = require('../src/db/db');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEMO_SESSIONS_DIR = path.join(__dirname, 'demo-sessions');
const DEFAULT_OUT = path.join(__dirname, 'demo.db');
const PARSER_VERSION = 30; // match sync.js — prevents re-sync overwriting demo data

// ---------------------------------------------------------------------------
// Cost computation (mirrors modelsJsonParser.js logic)
// ---------------------------------------------------------------------------

/**
 * Compute USD cost for one LLM call.
 * @param {number} inputTokens
 * @param {number} cachedTokens
 * @param {number} outputTokens
 * @param {{input: number, cache: number, output: number}} prices  $/MTok each
 * @returns {number} USD
 */
function computeCost(inputTokens, cachedTokens, outputTokens, prices) {
  const freshInput = inputTokens - (cachedTokens || 0);
  return (
    freshInput * prices.input +
    (cachedTokens || 0) * prices.cache +
    outputTokens * prices.output
  ) / 1_000_000;
}

/**
 * Convert USD cost to AIC nano-credits (matches aicClassifier / sessionMetrics).
 * computed_cost = total_aic / 1e11  =>  aic = cost * 1e11
 */
function costToAic(cost) {
  return Math.round(cost * 1e11);
}

// ---------------------------------------------------------------------------
// Session insertion
// ---------------------------------------------------------------------------

/**
 * Insert one demo session (all tables) inside a single transaction.
 * @param {import('../src/db/db').Database} db
 * @param {object} session — parsed JSON session file
 */
function insertSession(db, session) {
  const prices = session.model_prices || {};

  // We'll accumulate session-level aggregates as we process calls.
  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;
  let totalCacheWrite = 0;
  let totalCost = 0;
  let totalAic = 0;
  let totalLlmCalls = 0;
  const modelsUsed = new Set();

  let callNumber = 0;

  // Track the previous LLM call for model-switch detection.
  let prevCall = null;
  let cacheHitPct = 0;

  db.transaction(() => {
    // ---- Process turns ------------------------------------------------
    for (const turn of session.turns || []) {
      const turnTs = turn.timestamp || session.start_time;

      // User message
      if (turn.user_message) {
        db.run(
          `INSERT INTO user_messages
            (session_id, turn_number, content, timestamp, is_canceled)
           VALUES ($sid, $tn, $content, $ts, $canceled)`,
          {
            $sid: session.session_id,
            $tn: turn.turn_number,
            $content: turn.user_message,
            $ts: turnTs,
            $canceled: turn.is_canceled || 0
          }
        );
      }

      // LLM calls
      for (const call of turn.llm_calls || []) {
        callNumber++;
        totalLlmCalls++;
        modelsUsed.add(call.model);

        const modelPrices = prices[call.model];
        if (!modelPrices) {
          throw new Error(
            `No price data for model "${call.model}" in session "${session.session_id}". ` +
            `Add it to "model_prices" in the JSON.`
          );
        }

        const cost = computeCost(
          call.input_tokens,
          call.cached_tokens || 0,
          call.output_tokens,
          modelPrices
        );
        const aic = costToAic(cost);

        totalInput += call.input_tokens;
        totalOutput += call.output_tokens;
        totalCached += call.cached_tokens || 0;
        totalCacheWrite += call.cache_write_tokens || 0;
        totalCost += cost;
        totalAic += aic;

        const callTs = turnTs + Math.round((call.timestamp_offset || 0) / 1000);

        db.run(
          `INSERT INTO llm_calls
            (session_id, turn_number, call_number, model,
             input_tokens, cached_tokens, cache_write_tokens, output_tokens,
             cost, aic, timestamp, debug_name, status,
             span_id, parent_span_id, ttft,
             is_subagent, cache_break_type, time_since_prev)
           VALUES
            ($sid, $tn, $cn, $model,
             $input, $cached, $cacheWrite, $output,
             $cost, $aic, $ts, $dname, 'ok',
             $span, $pspan, $ttft,
             $sub, $cbt, $tsp)`,
          {
            $sid: session.session_id,
            $tn: turn.turn_number,
            $cn: callNumber,
            $model: call.model,
            $input: call.input_tokens,
            $cached: call.cached_tokens != null ? call.cached_tokens : null,
            $cacheWrite: call.cache_write_tokens != null ? call.cache_write_tokens : null,
            $output: call.output_tokens,
            $cost: cost,
            $aic: aic,
            $ts: callTs,
            $dname: call.debug_name || null,
            $span: call.span_id || null,
            $pspan: call.parent_span_id || null,
            $ttft: call.ttft || null,
            $sub: call.is_subagent ? 1 : 0,
            $cbt: call.cache_break_type || null,
            $tsp: prevCall ? (callTs - prevCall.ts) : null
          }
        );

        // Model switch detection
        if (prevCall && prevCall.model !== call.model) {
          db.run(
            `INSERT INTO model_switches
              (session_id, from_model, to_model, at_call_number,
               cache_before, cache_after, input_delta, timestamp)
             VALUES ($sid, $fm, $tm, $cn, $cb, $ca, $id, $ts)`,
            {
              $sid: session.session_id,
              $fm: prevCall.model,
              $tm: call.model,
              $cn: callNumber,
              $cb: prevCall.cached_tokens || null,
              $ca: call.cached_tokens || null,
              $id: call.input_tokens - prevCall.input_tokens,
              $ts: callTs
            }
          );
        }

        prevCall = {
          model: call.model,
          input_tokens: call.input_tokens,
          cached_tokens: call.cached_tokens || 0,
          ts: callTs
        };
      }

      // Tool calls
      let toolOrder = 0;
      for (const tool of turn.tool_calls || []) {
        toolOrder++;
        const toolTs = turnTs + Math.round((tool.timestamp_offset || 0) / 1000);

        db.run(
          `INSERT INTO tool_calls
            (session_id, turn_number, tool_name, args_preview, args_full,
             result_size, result_text, status, compression_method,
             dur, timestamp, parent_span_id)
           VALUES
            ($sid, $tn, $name, $args, $argsFull,
             $rsize, $rtext, $status, $compress,
             $dur, $ts, $pspan)`,
          {
            $sid: session.session_id,
            $tn: turn.turn_number,
            $name: tool.tool_name,
            $args: tool.args_preview || null,
            $argsFull: tool.args_full || null,
            $rsize: tool.result_size || 0,
            $rtext: tool.result_text || null,
            $status: tool.status || 'ok',
            $compress: tool.compression_method || null,
            $dur: tool.dur || null,
            $ts: toolTs,
            $pspan: tool.parent_span_id || null
          }
        );
      }

      // Agent response — stored in agent_responses + transcripts
      if (turn.agent_response) {
        const resp = turn.agent_response;
        const respTs = turnTs + Math.round((resp.timestamp_offset || 0) / 1000);

        // agent_responses row (plain text — extractTextFromParts handles it)
        db.run(
          `INSERT INTO agent_responses
            (session_id, turn_number, response_text, reasoning_text,
             timestamp, span_id, parent_span_id)
           VALUES ($sid, $tn, $rt, $rtext, $ts, $span, $pspan)`,
          {
            $sid: session.session_id,
            $tn: turn.turn_number,
            $rt: resp.response_text || null,
            $rtext: resp.reasoning_text || null,
            $ts: respTs,
            $span: resp.span_id || null,
            $pspan: null
          }
        );

        // transcripts row — getConversation() reads event_data.data.content
        const eventData = JSON.stringify({
          data: {
            content: resp.response_text || '',
            turnId: `turn-${session.session_id}-${turn.turn_number}`
          }
        });
        db.run(
          `INSERT INTO transcripts
            (session_id, event_type, event_data, event_uuid, parent_uuid, timestamp)
           VALUES ($sid, 'assistant.message', $data, $uuid, $puuid, $ts)`,
          {
            $sid: session.session_id,
            $data: eventData,
            $uuid: `${session.session_id}-asst-${turn.turn_number}`,
            $puuid: null,
            $ts: respTs
          }
        );
      }
    }

    // ---- Discovery events ------------------------------------------------
    for (const evt of session.discovery_events || []) {
      const evtTs = session.start_time + Math.round((evt.timestamp_offset || 0) / 1000);
      db.run(
        `INSERT INTO discovery_events
          (session_id, event_type, event_name, details, timestamp)
         VALUES ($sid, $type, $name, $details, $ts)`,
        {
          $sid: session.session_id,
          $type: evt.event_type,
          $name: evt.event_name || null,
          $details: evt.details || null,
          $ts: evtTs
        }
      );
    }

    // ---- Session row ------------------------------------------------
    const hasModelSwitch = [...modelsUsed].length > 1 ? 1 : 0;
    const hasSubagent = (session.turns || []).some(t =>
      (t.llm_calls || []).some(c => c.is_subagent)
    ) ? 1 : 0;

    const endTime = prevCall ? prevCall.ts : session.start_time;
    cacheHitPct = totalInput > 0
      ? (totalCached / totalInput) * 100
      : 0;

    db.run(
      `INSERT OR REPLACE INTO sessions
        (session_id, workspace_hash, workspace_path, title,
         start_time, end_time, mode, initial_location,
         copilot_version, vscode_version,
         data_quality, first_prompt,
         total_llm_calls, total_input_tokens, total_output_tokens,
         total_cached_tokens, total_cache_write_tokens,
         total_cost, total_aic,
         computed_aic, computed_cost,
         is_aic_approx, cache_hit_pct,
         has_model_switch, has_subagent,
         models_used_json)
       VALUES
        ($sid, $wh, $wp, $title,
         $start, $end, $mode, $iloc,
         $cpver, $vsver,
         $dq, $fp,
         $nlc, $nit, $not,
         $nct, $ncwt,
         $cost, $aic,
         $caic, $ccost,
         0, $chp,
         $hms, $hsa,
         $muj)`,
      {
        $sid: session.session_id,
        $wh: session.workspace_hash,
        $wp: session.workspace_path || null,
        $title: session.title || null,
        $start: session.start_time,
        $end: endTime,
        $mode: session.mode || null,
        $iloc: session.initial_location || null,
        $cpver: session.copilot_version || null,
        $vsver: session.vscode_version || null,
        $dq: session.data_quality || 'full',
        $fp: session.first_prompt || null,
        $nlc: totalLlmCalls,
        $nit: totalInput,
        $not: totalOutput,
        $nct: totalCached,
        $ncwt: totalCacheWrite,
        $cost: totalCost,
        $aic: totalAic,
        $caic: totalAic,
        $ccost: totalCost,
        $chp: cacheHitPct,
        $hms: hasModelSwitch,
        $hsa: hasSubagent,
        $muj: JSON.stringify([...modelsUsed])
      }
    );

    // ---- Sync log (marks session as synced at PARSER_VERSION) -------
    db.run(
      `INSERT OR REPLACE INTO sync_log
        (session_id, source_path, main_jsonl_mtime, total_lines,
         file_size, parser_version, synced_at)
       VALUES ($sid, $sp, $mtime, $lines, $fsize, $pver, $sat)`,
      {
        $sid: session.session_id,
        $sp: `/demo/sessions/${session.session_id}`,
        $mtime: session.start_time,
        $lines: totalLlmCalls * 3,
        $fsize: totalLlmCalls * 512,
        $pver: PARSER_VERSION,
        $sat: Math.floor(Date.now() / 1000)
      }
    );
  });

  return {
    sessionId: session.session_id,
    calls: totalLlmCalls,
    cost: totalCost,
    cacheHitPct
  };
}

// ---------------------------------------------------------------------------
// Model catalog insertion
// ---------------------------------------------------------------------------

const MODEL_CATALOG = [
  {
    model_id: 'gpt-4o',
    display_name: 'GPT-4o',
    vendor: 'OpenAI',
    family: 'gpt-4o',
    category: 'powerful',
    price_category: 'high',
    supports_vision: 1,
    supports_tool_calls: 1,
    supports_thinking: 0,
    input_price_per_mtok: 50000,   // $/MTok * 1e4
    output_price_per_mtok: 150000,
    cache_price_per_mtok: 25000
  },
  {
    model_id: 'gpt-4o-mini',
    display_name: 'GPT-4o mini',
    vendor: 'OpenAI',
    family: 'gpt-4o',
    category: 'versatile',
    price_category: 'low',
    supports_vision: 1,
    supports_tool_calls: 1,
    supports_thinking: 0,
    input_price_per_mtok: 1500,
    output_price_per_mtok: 6000,
    cache_price_per_mtok: 750
  },
  {
    model_id: 'claude-sonnet-4-5',
    display_name: 'Claude Sonnet 4.5',
    vendor: 'Anthropic',
    family: 'claude-4',
    category: 'powerful',
    price_category: 'medium',
    supports_vision: 1,
    supports_tool_calls: 1,
    supports_thinking: 1,
    input_price_per_mtok: 30000,
    output_price_per_mtok: 150000,
    cache_price_per_mtok: 3000
  },
  {
    model_id: 'o3-mini',
    display_name: 'o3-mini',
    vendor: 'OpenAI',
    family: 'o3',
    category: 'powerful',
    price_category: 'medium',
    supports_vision: 0,
    supports_tool_calls: 1,
    supports_thinking: 1,
    input_price_per_mtok: 11000,
    output_price_per_mtok: 44000,
    cache_price_per_mtok: 5500
  }
];

function insertModelCatalog(db) {
  db.transaction(() => {
    for (const m of MODEL_CATALOG) {
      db.run(
        `INSERT OR IGNORE INTO model_catalog
          (model_id, display_name, vendor, family, category, price_category,
           supports_vision, supports_tool_calls, supports_thinking,
           input_price_per_mtok, output_price_per_mtok, cache_price_per_mtok)
         VALUES
          ($id, $dn, $vendor, $family, $cat, $pc,
           $sv, $stc, $sth,
           $ip, $op, $cp)`,
        {
          $id: m.model_id,
          $dn: m.display_name,
          $vendor: m.vendor,
          $family: m.family,
          $cat: m.category,
          $pc: m.price_category,
          $sv: m.supports_vision,
          $stc: m.supports_tool_calls,
          $sth: m.supports_thinking,
          $ip: m.input_price_per_mtok,
          $op: m.output_price_per_mtok,
          $cp: m.cache_price_per_mtok
        }
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Parse --out flag
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outPath = outIdx !== -1 && args[outIdx + 1]
    ? path.resolve(args[outIdx + 1])
    : DEFAULT_OUT;

  // Read session files
  if (!fs.existsSync(DEMO_SESSIONS_DIR)) {
    console.error(`No demo-sessions directory found at: ${DEMO_SESSIONS_DIR}`);
    process.exit(1);
  }

  const sessionFiles = fs.readdirSync(DEMO_SESSIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort();

  if (sessionFiles.length === 0) {
    console.error(`No .json files found in ${DEMO_SESSIONS_DIR}`);
    process.exit(1);
  }

  console.log(`Found ${sessionFiles.length} session file(s):`);
  for (const f of sessionFiles) console.log(`  ${f}`);

  // Init DB in a temp dir, then copy to output
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-db-'));
  const db = new Database(tmpDir);
  await db.init();

  insertModelCatalog(db);

  const results = [];
  for (const file of sessionFiles) {
    const filePath = path.join(DEMO_SESSIONS_DIR, file);
    let session;
    try {
      session = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (err) {
      console.error(`  ✗ ${file} — JSON parse error: ${err.message}`);
      continue;
    }

    try {
      const result = insertSession(db, session);
      results.push(result);
      console.log(
        `  ✓ ${result.sessionId} — ${result.calls} calls, ` +
        `$${result.cost.toFixed(4)}, ${result.cacheHitPct.toFixed(1)}% cache hit`
      );
    } catch (err) {
      console.error(`  ✗ ${file} — insert error: ${err.message}`);
      if (process.env.DEBUG) console.error(err.stack);
    }
  }

  db.persist();

  // Copy to output path
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.copyFileSync(db.dbPath, outPath);
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const stats = fs.statSync(outPath);
  console.log(`\nDemo DB written: ${outPath} (${(stats.size / 1024).toFixed(1)} KB)`);
  console.log(`Sessions: ${results.length}  |  Total calls: ${results.reduce((s, r) => s + r.calls, 0)}`);
  console.log(`\nTo use: copy demo.db to the extension globalStorage directory as copilot-analytics.db`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
