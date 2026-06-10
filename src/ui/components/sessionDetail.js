/**
 * @fileoverview Session detail view — header, summary cards, model breakdown.
 */

import { store } from '../store.js';
import { escapeHtml, copyText } from '../helpers.js';
import { formatNumber, formatCost, formatNumberWithCommas, getSessionAicClass } from '../formatters.js';
import { renderModelCard } from './modelCard.js';
import { renderTimeline } from './timeline.js';
import { rebuildToolFilters } from '../filters.js';
import { renderCacheSparkline, renderSessionTools, renderSessionModelSwitches } from './tabs.js';

/**
 * Render the session detail view.
 */
export function renderSessionDetail() {
  try {
    const session = store.sessionDetail;
    if (!session) return;

    // Title
    setText('detail-title', session.title || session.session_id.slice(0, 8) + '\u2026');

    // Subtitle (first prompt)
    const subtitleEl = document.getElementById('detail-subtitle');
    if (subtitleEl) {
      if (session.first_prompt) {
        subtitleEl.textContent = session.first_prompt;
        subtitleEl.classList.remove('hidden');
      } else {
        subtitleEl.classList.add('hidden');
      }
    }

    // Badges
    document.getElementById('badge-quality')?.classList.add('hidden');
    document.getElementById('badge-subagent')?.classList.toggle('hidden', !session.has_subagent);
    document.getElementById('badge-switch')?.classList.toggle('hidden', !session.has_model_switch);
    const retryCount = store.llmCalls.filter(c => c.debug_name && c.debug_name.includes('retry')).length;
    document.getElementById('badge-retry')?.classList.toggle('hidden', retryCount === 0);
    const retryEl = document.getElementById('badge-retry');
    if (retryEl && retryCount > 0) retryEl.textContent = '\u21BB ' + retryCount + ' retr' + (retryCount === 1 ? 'y' : 'ies');
    // Update breadcrumb
    const bcSep = document.getElementById('bc-separator');
    const bcSession = document.getElementById('bc-session');
    if (bcSep) bcSep.classList.remove('hidden');
    if (bcSession) {
      bcSession.textContent = session.title || session.session_id.slice(0, 16) + '\u2026';
      bcSession.classList.remove('hidden');
    }

    // Metadata
    setText('detail-sid-code', session.session_id || '\u2014');
    setText('detail-ws-name', session.workspace_path ? (session.workspace_path.split('/').pop() || session.workspace_path) : 'unknown');

    const timeRange = document.getElementById('detail-time-range');
    if (timeRange) {
      const start = session.start_time ? new Date(session.start_time * 1000).toLocaleString() : '\u2014';
      const end = session.end_time ? new Date(session.end_time * 1000).toLocaleString() : '\u2014';
      timeRange.textContent = start + (session.end_time && session.end_time !== session.start_time ? ' \u2192 ' + end : '');
    }

    // Copy handlers (bind once)
    bindCopy('detail-session-id', () => store.sessionDetail?.session_id, 'Session ID');
    bindCopy('detail-ws', () => store.sessionDetail?.workspace_path, 'Workspace');

    // Open log button
    const openBtn = document.getElementById('btn-open-log');
    if (openBtn) {
      if (session.source_path) {
        openBtn.classList.remove('hidden');
        openBtn.onclick = () => {
          const mainJsonl = session.source_path + '/main.jsonl';
          if (window.__rpc) window.__rpc.call('openDebugLog', { filePath: mainJsonl }).catch(() => {});
        };
      } else {
        openBtn.classList.add('hidden');
      }
    }

    // Reveal chat session button
    const revealBtn = document.getElementById('btn-reveal-chat');
    if (revealBtn) {
      revealBtn.classList.remove('hidden');
      revealBtn.onclick = () => {
        if (window.__rpc) window.__rpc.call('revealChatSession', { sessionId: session.session_id }).catch(() => {});
      };
    }

    // Summary cards
    store.cardCalls = session.total_llm_calls;
    store.cardInput = formatNumber(session.total_input_tokens);
    store.cardOutput = formatNumber(session.total_output_tokens);
    store.cardCached = session.total_cached_tokens != null ? formatNumber(session.total_cached_tokens) : '\u2014';
    store.cardCost = formatCost(session.computed_cost);
    store.cardAic = session.computed_aic > 0 ? (session.is_aic_approx ? '~' : '') + formatNumberWithCommas((session.computed_aic / 1e9).toFixed(2)) : '\u2014';
    store.cardCacheHit = session.cache_hit_pct > 0 ? session.cache_hit_pct.toFixed(1) + '%' : '\u2014';

    // Card color classes
    setClass('card-calls', 'card-value');
    setClass('card-input', 'card-value');
    setClass('card-output', 'card-value');
    setClass('card-cached', 'card-value value-success');
    const chp = session.cache_hit_pct || 0;
    setClass('card-cache-hit', 'card-value ' + (chp >= 80 ? 'value-success' : chp >= 50 ? 'value-warning' : 'value-error'));
    setClass('card-cost', 'card-value value-accent');
    const aicCardEl = document.getElementById('card-aic');
    if (aicCardEl) {
      const aicCls = getSessionAicClass(session.computed_aic);
      aicCardEl.className = 'card-value llm-aic ' + aicCls;
      if (session.is_aic_approx) aicCardEl.title = 'Estimated from token ratio; actual AIC may differ';
      else aicCardEl.removeAttribute('title');
    }

    // Discrepancy note
    const hasRetryCalls = store.llmCalls.some(c => c.debug_name && c.debug_name.includes('retry'));
    document.getElementById('aic-discrepancy-note')?.classList.toggle('hidden', !hasRetryCalls);

    // Sub-renders
    renderTimeline();
    renderSessionModelBreakdown();
    const expandBtn = document.getElementById('expand-all');
    if (expandBtn) expandBtn.textContent = store.timelineExpanded ? '\u229F Collapse' : '\u229E Expand';

    rebuildToolFilters();
    renderCacheSparkline();
    renderSessionTools();
    renderSessionModelSwitches();
  } catch (err) {
    if (window.__DEBUG__) console.error('[ui] renderSessionDetail ERROR:', err);
  }
}

/**
 * Render per-session model breakdown from LLM calls.
 */
export function renderSessionModelBreakdown() {
  const container = document.getElementById('detail-model-breakdown');
  if (!container) return;
  const calls = store.llmCalls;
  if (!calls || calls.length === 0) {
    container.innerHTML = '<div class="empty-message">No model data</div>';
    return;
  }
  const byModel = {};
  for (const c of calls) {
    const m = c.model || 'unknown';
    if (!byModel[m]) byModel[m] = { model: m, calls: 0, cost: 0, aic: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, cache_write_tokens: null, hasCacheWrite: false };
    byModel[m].calls++;
    byModel[m].cost += c.cost || 0;
    byModel[m].input_tokens += c.input_tokens || 0;
    byModel[m].output_tokens += c.output_tokens || 0;
    byModel[m].cached_tokens += c.cached_tokens || 0;
    if (c.cache_write_tokens != null) {
      byModel[m].cache_write_tokens = (byModel[m].cache_write_tokens || 0) + c.cache_write_tokens;
      byModel[m].hasCacheWrite = true;
    }
    if (c.aic > 0) byModel[m].aic += c.aic;
  }
  for (const m of Object.values(byModel)) {
    m.displayCost = m.aic > 0 ? m.aic / 1e11 : m.cost;
  }
  const list = Object.values(byModel).sort((a, b) => b.displayCost - a.displayCost);
  const session = store.sessionDetail;
  const sessionSubCounts = session?.subagent_counts_json
    ? (() => { try { return JSON.parse(session.subagent_counts_json); } catch { return {}; } })()
    : {};
  container.innerHTML = list.map(m => {
    m.vendor = m.model.toLowerCase().includes('claude') ? 'Anthropic' : m.model.toLowerCase().includes('gpt') ? 'OpenAI' : '';
    m.aic = m.aic || 0;
    m.cost = m.displayCost || 0;
    return renderModelCard(m, { subagentCounts: sessionSubCounts, showAic: true, showCacheWrite: false });
  }).join('');
}

// --- Helpers ---

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function setClass(id, className) {
  const el = document.getElementById(id);
  if (el) el.className = className;
}

function bindCopy(id, valueFn, label) {
  const el = document.getElementById(id);
  if (el && !el._bound) {
    el._bound = true;
    el.addEventListener('click', () => {
      const val = valueFn();
      if (val) copyText(val, label);
    });
  }
}
