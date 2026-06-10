/**
 * @fileoverview Reusable model breakdown card component.
 */

import { escapeHtml } from '../helpers.js';
import { formatCost, formatCompact, formatNumberWithCommas, getSessionAicClass } from '../formatters.js';

/**
 * Render a key-value row inside a model card.
 * @param {string} label
 * @param {string} value
 * @param {Object} [opts]
 * @param {string} [opts.valueClass='model-card-value']
 * @returns {string}
 */
function renderRow(label, value, opts = {}) {
  const cls = opts.valueClass || 'model-card-value';
  return `<div class="model-card-row"><span class="model-card-label">${escapeHtml(label)}</span><span class="${cls}">${value}</span></div>`;
}

/**
 * Render a single model breakdown card.
 * @param {Object} m - Model breakdown data
 * @param {Object} [opts]
 * @param {Object} [opts.subagentCounts]
 * @param {boolean} [opts.showAic=true]
 * @param {boolean} [opts.showCacheWrite=true]
 * @param {boolean} [opts.applyAicColor=true]
 * @returns {string}
 */
export function renderModelCard(m, opts = {}) {
  const showCacheWrite = opts.showCacheWrite !== false;
  const subagentCounts = opts.subagentCounts || {};
  const subCount = subagentCounts[m.model] || 0;
  const subBadge = subCount > 0
    ? `<span class="badge badge-info" role="status">\u2139 sub-agent \u00D7${formatNumberWithCommas(subCount)}</span>`
    : '';

  const cacheHitPct = m.input_tokens > 0 ? (m.cached_tokens / m.input_tokens * 100).toFixed(1) : 0;
  const vendor = m.vendor || '';

  const aicValue = m.aic > 0 ? (m.aic / 1e9).toFixed(2) : '';
  const aicDisplay = aicValue ? formatNumberWithCommas(aicValue) + ' AIC' : '';
  const costDisplay = m.cost > 0 ? formatCost(m.cost) : '';

  const freshInput = m.input_tokens > 0 && m.cached_tokens != null
    ? Math.max(0, m.input_tokens - m.cached_tokens) : (m.input_tokens || 0);

  const rows = [
    renderRow('Total input', formatCompact(m.input_tokens || 0)),
    renderRow('Cached input', formatCompact(m.cached_tokens || 0), { valueClass: 'model-card-value value-success' }),
    renderRow('Fresh input', formatCompact(freshInput))
  ];
  if (showCacheWrite) {
    const cw = m.cache_write_tokens;
    rows.push(renderRow('Cache write', cw == null ? '\u2014' : formatCompact(cw)));
  }
  rows.push(renderRow('Output', formatCompact(m.output_tokens || 0)));

  const cacheClass = cacheHitPct >= 80 ? 'cache-good' : cacheHitPct >= 50 ? 'cache-mid' : 'cache-bad';

  return `
    <div class="model-card" role="article" aria-label="${escapeHtml(m.model)} model breakdown">
      <div class="model-card-header">
        <div class="model-card-title-group">
          <div class="model-card-name-wrap">
            <span class="model-card-name">${escapeHtml(m.model)}</span>
            ${subBadge}
          </div>
          <div class="model-card-vendor">${escapeHtml(vendor)}</div>
        </div>
        <div class="model-card-aic-wrap">
          ${aicDisplay ? `<div class="model-card-aic${opts.applyAicColor !== false ? ' llm-aic ' + getSessionAicClass(m.aic) : ''}">${aicDisplay}</div>` : ''}
          ${costDisplay ? `<div class="model-card-cost-sub">${costDisplay}</div>` : ''}
        </div>
      </div>
      ${rows.join('')}
      <div class="cache-bar-track" role="progressbar" aria-valuenow="${cacheHitPct}" aria-valuemin="0" aria-valuemax="100" aria-label="Cache hit rate ${cacheHitPct}%">
        <div class="cache-bar-fill" style="width:${cacheHitPct}%"></div>
      </div>
      <div class="cache-bar-label ${cacheClass}">Cache hit rate ${cacheHitPct}%</div>
    </div>`;
}
