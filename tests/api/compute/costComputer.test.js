/**
 * @fileoverview Unit tests for costComputer.js
 *
 * Tests the pricing and cost computation logic with mock data.
 * These are pure functions — no filesystem, no VS Code API, no database.
 */

import { describe, it, expect } from 'vitest';
import { computeCallCost, formatCost } from '../../../src/api/compute/costComputer.js';

describe('computeCallCost', () => {
  const pricingMap = new Map([
    ['gpt-5.3-codex', {
      modelId: 'gpt-5.3-codex',
      displayName: 'GPT-5.3 Codex',
      inputPrice: 0.02,   // $0.02 per 1M tokens
      cachePrice: 0.005,   // $0.005 per 1M tokens
      outputPrice: 0.08, // $0.08 per 1M tokens
      contextMax: 200000
    }]
  ]);

  it('computes cost for a call with no cached tokens', () => {
    const call = {
      model: 'gpt-5.3-codex',
      inputTokens: 10000,
      cachedTokens: null,
      outputTokens: 500
    };
    const cost = computeCallCost(call, pricingMap);
    // (10000 * 0.02 + 0 * 0.005 + 500 * 0.08) / 1e6 = (200 + 0 + 40) / 1e6 = 0.00024
    expect(cost).toBeCloseTo(0.00024, 6);
  });

  it('computes cost for a call with cached tokens', () => {
    const call = {
      model: 'gpt-5.3-codex',
      inputTokens: 10000,
      cachedTokens: 8000,
      outputTokens: 500
    };
    const cost = computeCallCost(call, pricingMap);
    // freshInput = 2000, cachedInput = 8000
    // (2000 * 0.02 + 8000 * 0.005 + 500 * 0.08) / 1e6 = (40 + 40 + 40) / 1e6 = 0.00012
    expect(cost).toBeCloseTo(0.00012, 6);
  });

  it('returns 0 when model not in pricing map', () => {
    const call = {
      model: 'unknown-model',
      inputTokens: 10000,
      cachedTokens: null,
      outputTokens: 500
    };
    expect(computeCallCost(call, pricingMap)).toBe(0);
  });

  it('returns 0 for empty pricing map', () => {
    const call = {
      model: 'gpt-5.3-codex',
      inputTokens: 1000,
      cachedTokens: null,
      outputTokens: 100
    };
    expect(computeCallCost(call, new Map())).toBe(0);
  });
});

describe('formatCost', () => {
  it('formats small costs with 4 decimals', () => {
    expect(formatCost(0.0001234)).toBe('$0.0001');
  });

  it('formats larger costs with 2 decimals', () => {
    expect(formatCost(1.234)).toBe('$1.23');
  });

  it('returns dash for null', () => {
    expect(formatCost(null)).toBe('—');
  });
});

