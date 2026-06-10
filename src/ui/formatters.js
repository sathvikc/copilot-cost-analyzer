/**
 * @fileoverview Display formatters for the webview.
 *
 * Single source of truth for all number/cost/latency formatting in the UI.
 * Mirrors src/shared/formatters.js (CJS) for browser-side ESM usage.
 */

const EM_DASH = '\u2014';

/**
 * Format a number with locale-aware grouping (e.g. 1,234,567).
 * @param {number|null|undefined} n
 * @returns {string}
 */
export function formatNumber(n) {
  if (n == null) return EM_DASH;
  return n.toLocaleString();
}

/**
 * Format a number with commas and up to 2 decimal places.
 * @param {number|string|null|undefined} n
 * @returns {string}
 */
export function formatNumberWithCommas(n) {
  if (n == null || isNaN(n)) return EM_DASH;
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * Format a dollar amount with tiered precision.
 * @param {number|null|undefined} cost
 * @returns {string}
 */
export function formatCost(cost) {
  if (cost == null) return EM_DASH;
  if (cost === 0) return '$0.00';
  if (Math.abs(cost) < 0.0001) return `$${cost.toFixed(6)}`;
  if (Math.abs(cost) < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/**
 * Format AIC from nano-units to human-readable string.
 * @param {number|null|undefined} nanoAiu
 * @returns {string}
 */
export function formatAic(nanoAiu) {
  if (nanoAiu == null) return EM_DASH;
  const aic = nanoAiu / 1e9;
  if (aic < 0.01) return `${aic.toFixed(4)} AIC`;
  if (aic < 1) return `${aic.toFixed(2)} AIC`;
  return `${Math.round(aic)} AIC`;
}

/**
 * Format a number in compact notation (e.g. 1.2M, 45K).
 * @param {number|null|undefined} n
 * @returns {string}
 */
export function formatCompact(n) {
  if (n == null) return EM_DASH;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString();
}

/**
 * Format latency in milliseconds to human-readable string.
 * @param {number|null|undefined} ms
 * @returns {string}
 */
export function formatLatency(ms) {
  if (ms == null) return EM_DASH;
  if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
  return ms + 'ms';
}

/**
 * Classify latency into a CSS class.
 * @param {number|null|undefined} ms
 * @returns {string}
 */
export function latencyClass(ms) {
  if (ms == null) return '';
  if (ms < 1000) return 'latency-fast';
  if (ms <= 5000) return 'latency-mid';
  return 'latency-slow';
}

/**
 * Format AIC nano-units to a short display string (no " AIC" suffix).
 * @param {number} nanoAiu
 * @param {boolean} [isApprox=false]
 * @returns {string}
 */
export function formatAicShort(nanoAiu, isApprox = false) {
  if (!nanoAiu || nanoAiu <= 0) return EM_DASH;
  const prefix = isApprox ? '~' : '';
  return prefix + formatNumberWithCommas((nanoAiu / 1e9).toFixed(2));
}

/**
 * Classify a session-level AIC value into a CSS class.
 * Uses absolute thresholds (no percentile context available for sessions).
 * Matches aicClassifier.js class names: expensive, moderate, low, none.
 * @param {number|null|undefined} nanoAiu - AIC in nano-units
 * @returns {'expensive'|'moderate'|'low'|'none'}
 */
export function getSessionAicClass(nanoAiu) {
  if (!nanoAiu || nanoAiu <= 0) return 'none';
  const aic = nanoAiu / 1e9;
  if (aic >= 5) return 'expensive';
  if (aic >= 1) return 'moderate';
  if (aic >= 0.1) return 'low';
  return 'none';
}
