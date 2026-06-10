/**
 * @fileoverview AIC (AI Credits) classification logic.
 *
 * Classifies LLM calls into cost tiers (expensive/moderate/low/none)
 * using a hybrid approach: absolute thresholds for extreme values,
 * and session-relative percentiles for the middle range.
 *
 * Thresholds and classification are centralized here — CSS colors
 * map to these class names via --aic-expensive/moderate/low/none variables.
 */

// Absolute thresholds (in nano-AIU = AIC * 1e9)
const AIC_THRESHOLDS = {
  EXPENSIVE: 5,    // >= 5 AIC is always expensive
  NONE: 0.1        // < 0.1 AIC is always none
};

// Percentile breakpoints for relative classification
const AIC_PERCENTILES = {
  EXPENSIVE: 0.90,  // top 10%
  MODERATE: 0.65,   // next 25%
  LOW: 0.30         // next 35%; bottom 30% → none
};

// AIC to USD conversion rate
const AIC_DOLLAR_RATE = 1e11; // nano-AIU → credits → dollars

// Class priority for determining turn-level class (highest wins)
const CLASS_PRIORITY = ['expensive', 'moderate', 'low', 'none'];

/**
 * Compute percentile cutoffs from a sorted array of AIC values.
 * @param {number[]} sortedAics - Sorted ascending array of AIC values (nano-AIU)
 * @returns {{ expensive: number, moderate: number, low: number }}
 */
function computePercentileCutoffs(sortedAics) {
  if (sortedAics.length === 0) {
    return { expensive: Infinity, moderate: Infinity, low: Infinity };
  }
  const n = sortedAics.length;
  const at = p => sortedAics[Math.min(Math.floor(n * p), n - 1)];
  return {
    expensive: at(AIC_PERCENTILES.EXPENSIVE),
    moderate: at(AIC_PERCENTILES.MODERATE),
    low: at(AIC_PERCENTILES.LOW)
  };
}

/**
 * Classify a single AIC value using hybrid absolute + percentile logic.
 * @param {number} aic - AIC value in nano-AIU
 * @param {{ expensive: number, moderate: number, low: number }} cutoffs
 * @returns {'expensive'|'moderate'|'low'|'none'}
 */
function classifyAic(aic, cutoffs) {
  const aicCredits = aic / 1e9;
  // Absolute floor/ceiling
  if (aicCredits >= AIC_THRESHOLDS.EXPENSIVE) return 'expensive';
  if (aicCredits < AIC_THRESHOLDS.NONE) return 'none';
  // Relative percentiles for the middle range
  if (aic >= cutoffs.expensive) return 'expensive';
  if (aic >= cutoffs.moderate) return 'moderate';
  if (aic >= cutoffs.low) return 'low';
  return 'none';
}

/**
 * Classify all LLM calls in a session, using per-model percentiles where possible.
 * Models with < 3 calls fall back to session-wide percentiles.
 *
 * @param {Array<Object>} llmCalls - LLM call rows from DB
 * @returns {Map<number, string>} Map of call_number → aicClass
 */
function classifySessionCalls(llmCalls) {
  const results = new Map();

  // Session-wide cutoffs as fallback
  const sessionAics = llmCalls.map(c => c.aic || 0).sort((a, b) => a - b);
  const sessionCutoffs = computePercentileCutoffs(sessionAics);

  // Per-model cutoffs
  const modelCutoffs = new Map();
  const callsByModel = new Map();
  for (const call of llmCalls) {
    const model = call.model || 'unknown';
    if (!callsByModel.has(model)) callsByModel.set(model, []);
    callsByModel.get(model).push(call.aic || 0);
  }
  for (const [model, aics] of callsByModel) {
    const sorted = aics.slice().sort((a, b) => a - b);
    modelCutoffs.set(model, sorted.length >= 3 ? computePercentileCutoffs(sorted) : sessionCutoffs);
  }

  // Classify each call
  for (const call of llmCalls) {
    const model = call.model || 'unknown';
    const cutoffs = modelCutoffs.get(model) || sessionCutoffs;
    results.set(call.call_number, classifyAic(call.aic || 0, cutoffs));
  }

  return results;
}

/**
 * Determine the turn-level AIC class (highest class among its calls).
 * @param {string[]} callClasses - Array of aicClass values for calls in the turn
 * @returns {'expensive'|'moderate'|'low'|'none'}
 */
function turnLevelClass(callClasses) {
  for (const cls of CLASS_PRIORITY) {
    if (callClasses.includes(cls)) return cls;
  }
  return 'none';
}

module.exports = {
  AIC_THRESHOLDS,
  AIC_PERCENTILES,
  AIC_DOLLAR_RATE,
  computePercentileCutoffs,
  classifyAic,
  classifySessionCalls,
  turnLevelClass
};
