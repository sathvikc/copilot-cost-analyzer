/**
 * @fileoverview Parses Copilot's models.json pricing file into a normalized lookup map.
 *
 * models.json is a JSON array of model descriptors with nested billing info.
 * We flatten it into a simple { modelId -> ParsedPricing } map for fast lookup.
 */

const fs = require('fs');
const path = require('path');

/**
 * Load and parse a session's models.json file.
 * @param {string} modelsJsonPath - Absolute path to models.json
 * @returns {Map<string, import('./types').ParsedPricing>}
 */
function loadPricing(modelsJsonPath) {
  const result = new Map();

  if (!fs.existsSync(modelsJsonPath)) {
    return result;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf-8'));
  } catch (err) {
    console.warn('Failed to parse models.json:', err.message);
    return result;
  }

  if (!Array.isArray(raw)) {
    console.warn('models.json root is not an array');
    return result;
  }

  for (const entry of raw) {
    const id = entry.id;
    if (!id) continue;

    const defaultPrices = entry.billing?.token_prices?.default;
    if (!defaultPrices) continue;

    // Prices in models.json are in "attocents * 10000" (i.e. $/M tokens multiplied by 10^4)
    // e.g. input_price: 200 means $0.02 per 1M tokens
    const divisor = 1e4;

    result.set(id, {
      modelId: id,
      displayName: entry.display_name || id,
      inputPrice: (defaultPrices.input_price || 0) / divisor,
      cachePrice: (defaultPrices.cache_price || 0) / divisor,
      outputPrice: (defaultPrices.output_price || 0) / divisor,
      contextMax: defaultPrices.context_max || 0
    });
  }

  return result;
}

/**
 * Compute the cost of a single LLM call given a pricing map.
 * @param {import('./types').LlmCall} call
 * @param {Map<string, import('./types').ParsedPricing>} pricingMap
 * @returns {number} cost in USD
 */
function computeCallCost(call, pricingMap) {
  const pricing = pricingMap.get(call.model);
  if (!pricing) {
    return 0;
  }

  const freshInput = call.cachedTokens !== null && call.cachedTokens !== undefined
    ? Math.max(0, call.inputTokens - call.cachedTokens)
    : call.inputTokens;

  const cachedInput = call.cachedTokens || 0;

  // Prices are dollars per 1M tokens
  const inputCost = freshInput * pricing.inputPrice / 1e6;
  const cacheCost = cachedInput * pricing.cachePrice / 1e6;
  const outputCost = call.outputTokens * pricing.outputPrice / 1e6;

  return inputCost + cacheCost + outputCost;
}

module.exports = { loadPricing, computeCallCost };
