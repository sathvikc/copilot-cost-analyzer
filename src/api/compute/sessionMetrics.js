/**
 * @fileoverview Shared session metrics computation.
 *
 * All AIC, cost, and cache-hit math lives here.
 * Backend (sync.js) calls this during sync to store computed values in the DB.
 * Backend (extension.js) reads stored values and sends them to the UI.
 * The webview NEVER recomputes — it only renders.
 */

/**
 * Compute the global AIC-per-token ratio from all sessions with known AIC.
 * @param {Object} db - Database instance with .query() and .queryOne()
 * @returns {number} AIC per token ratio (0 if no known AIC sessions)
 */
function computeGlobalAicRatio(db) {
  const row = db.queryOne(`
    SELECT
      COALESCE(SUM(total_aic), 0) as total_aic,
      COALESCE(SUM(total_input_tokens + total_output_tokens), 0) as total_tokens
    FROM sessions
    WHERE total_aic > 0
  `);
  const totalAic = row?.total_aic || 0;
  const totalTokens = row?.total_tokens || 0;
  return totalTokens > 0 ? totalAic / totalTokens : 0;
}

/**
 * Compute display metrics for a single session.
 *
 * When actual AIC exists (from debug log), cost is derived from AIC (ground truth).
 * When AIC is missing, estimate from tokens using the global ratio.
 * When globalAicRatio is 0 (no AIC data at all, e.g. pre-June installs), fall back
 * to tokenBasedCost from pricing JSON so sessions don't show $0.
 *
 * @param {Object} session - Raw session row from DB
 * @param {number} globalAicRatio - Pre-computed global AIC-per-token ratio
 * @param {number} [tokenBasedCost=0] - Token-pricing cost as fallback when AIC unavailable
 * @returns {{
 *   computedAic: number,
 *   computedCost: number,
 *   isAicApprox: boolean,
 *   cacheHitPct: number
 * }}
 */
function computeSessionMetrics(session, globalAicRatio, tokenBasedCost = 0) {
  // AIC: use actual if available, otherwise estimate from tokens
  let computedAic = 0;
  let isAicApprox = false;

  if (session.total_aic > 0) {
    computedAic = session.total_aic;
  } else {
    const tokens = (session.total_input_tokens || 0)
      + (session.total_output_tokens || 0);
    computedAic = tokens * globalAicRatio;
    isAicApprox = computedAic > 0;
  }

  // Cost: prefer AIC-derived; fall back to token-based pricing when no AIC data exists
  const computedCost = computedAic > 0 ? computedAic / 1e11 : tokenBasedCost;

  // Cache hit: cached / input (not cached / (cached + input))
  const cacheHitPct = session.total_input_tokens > 0
    ? (session.total_cached_tokens || 0) / session.total_input_tokens * 100
    : 0;

  return { computedAic, computedCost, isAicApprox, cacheHitPct };
}

module.exports = {
  computeGlobalAicRatio,
  computeSessionMetrics
};
