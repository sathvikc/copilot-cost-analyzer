/**
 * @fileoverview Shared format functions for Copilot Cost Analyzer.
 *
 * CommonJS module usable in both extension host (Node.js) and webview (via bundler or inline).
 * Single source of truth for all display formatting — eliminates duplication
 * between costComputer.js, modelsJsonParser.js, and index.html inline script.
 */

/**
 * Format a number with locale-aware grouping (e.g. 1,234,567).
 * @param {number|null|undefined} n
 * @returns {string}
 */
function formatNumber(n) {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString();
}

/**
 * Format a dollar amount with tiered precision.
 * - < $0.0001 → 6 decimal places
 * - < $0.01   → 4 decimal places
 * - otherwise → 2 decimal places
 * @param {number|null|undefined} cost - Cost in USD
 * @returns {string}
 */
function formatCost(cost) {
  if (cost === null || cost === undefined) return '—';
  if (cost === 0) return '$0.00';
  if (cost < 0.0001 && cost > -0.0001) return `$${cost.toFixed(6)}`;
  if (cost < 0.01 && cost > -0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/**
 * Format AIC (AI Credits) from nano-units to human-readable string.
 * 1 AIC = 1 cent = $0.01; nanoAiu = 10^-9 AIC.
 * @param {number|null|undefined} nanoAiu - AIC in nano-units
 * @returns {string}
 */
function formatAic(nanoAiu) {
  if (nanoAiu === null || nanoAiu === undefined) return '—';
  const aic = nanoAiu / 1e9;
  if (aic < 0.01) return `${aic.toFixed(4)} AIC`;
  if (aic < 1) return `${aic.toFixed(2)} AIC`;
  return `${Math.round(aic)} AIC`;
}

/**
 * Format latency in milliseconds to a human-readable string.
 * > 1000ms → "X.Xs", otherwise → "Xms"
 * @param {number|null|undefined} ms - Latency in milliseconds
 * @returns {string}
 */
function formatLatency(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms > 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

/**
 * Classify latency into a CSS-friendly class name.
 * @param {number|null|undefined} ms
 * @returns {'fast'|'mid'|'slow'|''}
 */
function latencyClass(ms) {
  if (ms === null || ms === undefined) return '';
  if (ms < 1000) return 'fast';
  if (ms <= 5000) return 'mid';
  return 'slow';
}

/**
 * Format a number in compact notation (e.g. 1.2M, 45K).
 * @param {number|null|undefined} n
 * @returns {string}
 */
function formatCompact(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/**
 * Escape HTML special characters to prevent XSS in webview.
 * Uses string replacement (no DOM dependency).
 * @param {string|null|undefined} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  formatNumber,
  formatCost,
  formatAic,
  formatLatency,
  latencyClass,
  formatCompact,
  escapeHtml
};
