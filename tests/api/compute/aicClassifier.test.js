/**
 * @fileoverview Unit tests for aicClassifier.js
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
  AIC_THRESHOLDS,
  computePercentileCutoffs,
  classifyAic,
  classifySessionCalls,
  turnLevelClass
} = require('../../../src/api/compute/aicClassifier');

describe('computePercentileCutoffs', () => {
  it('returns Infinity for empty array', () => {
    const cutoffs = computePercentileCutoffs([]);
    expect(cutoffs.expensive).toBe(Infinity);
    expect(cutoffs.moderate).toBe(Infinity);
    expect(cutoffs.low).toBe(Infinity);
  });

  it('computes percentiles from sorted array', () => {
    // 10 values: 1-10
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const cutoffs = computePercentileCutoffs(sorted);
    // expensive = 90th percentile = index 9 = 10
    expect(cutoffs.expensive).toBe(10);
    // moderate = 65th percentile = index 6 = 7
    expect(cutoffs.moderate).toBe(7);
    // low = 30th percentile = index 3 = 4
    expect(cutoffs.low).toBe(4);
  });
});

describe('classifyAic', () => {
  const cutoffs = { expensive: 3e9, moderate: 1e9, low: 0.5e9 };

  it('classifies >= 5 AIC as always expensive', () => {
    expect(classifyAic(5e9, cutoffs)).toBe('expensive');
    expect(classifyAic(100e9, cutoffs)).toBe('expensive');
  });

  it('classifies < 0.1 AIC as always none', () => {
    expect(classifyAic(0.05e9, cutoffs)).toBe('none');
    expect(classifyAic(0, cutoffs)).toBe('none');
  });

  it('uses percentiles for middle range', () => {
    expect(classifyAic(4e9, cutoffs)).toBe('expensive');
    expect(classifyAic(2e9, cutoffs)).toBe('moderate');
    expect(classifyAic(0.7e9, cutoffs)).toBe('low');
    expect(classifyAic(0.2e9, cutoffs)).toBe('none');
  });
});

describe('classifySessionCalls', () => {
  it('classifies calls using per-model percentiles', () => {
    const calls = [
      { call_number: 1, model: 'gpt-5', aic: 1e9 },
      { call_number: 2, model: 'gpt-5', aic: 2e9 },
      { call_number: 3, model: 'gpt-5', aic: 3e9 },
      { call_number: 4, model: 'gpt-5', aic: 0.5e9 },
    ];
    const result = classifySessionCalls(calls);
    expect(result.size).toBe(4);
    // Call 3 (3 AIC) should be the most expensive
    expect(result.get(3)).toBe('expensive');
  });

  it('handles empty calls', () => {
    const result = classifySessionCalls([]);
    expect(result.size).toBe(0);
  });
});

describe('turnLevelClass', () => {
  it('returns expensive if any call is expensive', () => {
    expect(turnLevelClass(['low', 'expensive', 'none'])).toBe('expensive');
  });

  it('returns moderate if highest is moderate', () => {
    expect(turnLevelClass(['low', 'moderate', 'none'])).toBe('moderate');
  });

  it('returns none for all none', () => {
    expect(turnLevelClass(['none', 'none'])).toBe('none');
  });

  it('returns none for empty array', () => {
    expect(turnLevelClass([])).toBe('none');
  });
});
