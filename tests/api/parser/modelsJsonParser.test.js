/**
 * @fileoverview Unit tests for modelsJsonParser.js
 *
 * Tests pricing table loading and cost computation with mock data.
 */

import { describe, it, expect } from 'vitest';
import { computeCallCost } from '../../../src/api/compute/costComputer.js';

describe('computeCallCost with pricing edge cases', () => {
  it('handles zero tokens', () => {
    const pricingMap = new Map([
      ['model', { inputPrice: 1, cachePrice: 0.5, outputPrice: 2, contextMax: 1000 }]
    ]);
    const call = { model: 'model', inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
    expect(computeCallCost(call, pricingMap)).toBe(0);
  });

  it('handles very large token counts without overflow', () => {
    const pricingMap = new Map([
      ['model', { inputPrice: 0.01, cachePrice: 0.005, outputPrice: 0.03, contextMax: 200000 }]
    ]);
    const call = {
      model: 'model',
      inputTokens: 200000,
      cachedTokens: 150000,
      outputTokens: 40000
    };
    const cost = computeCallCost(call, pricingMap);
    // Should be a small dollar amount, not Infinity
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(10);
    expect(Number.isFinite(cost)).toBe(true);
  });

  it('cachedTokens of 0 is different from null', () => {
    const pricingMap = new Map([
      ['model', { inputPrice: 1, cachePrice: 0.5, outputPrice: 2, contextMax: 1000 }]
    ]);
    // cachedTokens = 0 means freshInput = inputTokens (all are fresh)
    const callZero = { model: 'model', inputTokens: 100, cachedTokens: 0, outputTokens: 10 };
    // cachedTokens = null means we can't determine cache, treat all as fresh
    const callNull = { model: 'model', inputTokens: 100, cachedTokens: null, outputTokens: 10 };

    // Both should compute the same cost since null fallback = full input
    expect(computeCallCost(callZero, pricingMap)).toBe(computeCallCost(callNull, pricingMap));
  });
});
