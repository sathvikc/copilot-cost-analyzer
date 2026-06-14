/**
 * @fileoverview Shared session metrics computation.
 *
 * All AIC, cost, and cache-hit math lives here.
 * Backend (sync.js) calls this during sync to store computed values in the DB.
 * Backend (extension.js) reads stored values and sends them to the UI.
 * The webview NEVER recomputes — it only renders.
 */

/**
 * Fallback AIC-per-token ratio (nano-AIU per token) for installs that have NO
 * debug-logs anywhere, so computeGlobalAicRatio() returns 0. Without it,
 * pure-chatSessions (Option B) users would see $0 / 0 AIC for every session.
 *
 * Derivation — this user's own debug-logs portfolio (SESSION.md §3.2):
 *   31 shared sessions → AIC 13.308 AIU (= 1.3308e10 nano-AIU) over
 *   1,219,847 input + 36,028 output = 1,255,875 tokens.
 *   1.3308e10 / 1,255,875 ≈ 10597 nano-AIU per token.
 * This is a *learned* ratio, so it already bakes in real cache behaviour
 * (≈89% of input was cached) and does NOT suffer the ~8× overestimate of
 * naive token×price (see §3.2). Estimates built from it must be labelled "≈".
 */
const DEFAULT_AIC_RATIO = 10597;

/**
 * The AIC-per-token ratio to actually use: the learned global ratio when known,
 * otherwise the documented static default. Idempotent for positive inputs.
 * @param {number} globalAicRatio - from computeGlobalAicRatio()
 * @returns {number}
 */
function effectiveAicRatio(globalAicRatio) {
  return globalAicRatio > 0 ? globalAicRatio : DEFAULT_AIC_RATIO;
}

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
 * When AIC is missing, estimate from tokens using the global ratio — or, when no
 * AIC data exists anywhere (globalAicRatio = 0, e.g. pure-Option-B / pre-June
 * installs), the documented DEFAULT_AIC_RATIO so the estimate is non-zero. We
 * deliberately do NOT use naive token×price here (it overestimates ~8×, see §3.2);
 * tokenBasedCost only surfaces when there are no tokens to estimate from.
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
    // Use the learned ratio if known, else the documented static default so
    // pure-Option-B sessions still get a (clearly-estimated) non-zero cost.
    computedAic = tokens * effectiveAicRatio(globalAicRatio);
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
  computeSessionMetrics,
  effectiveAicRatio,
  DEFAULT_AIC_RATIO
};
