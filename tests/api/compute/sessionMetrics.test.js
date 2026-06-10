/**
 * @fileoverview Unit tests for sessionMetrics.js
 *
 * Tests the global AIC ratio and session metric computation.
 */

import { describe, it, expect } from 'vitest';
import { computeGlobalAicRatio, computeSessionMetrics } from '../../../src/api/compute/sessionMetrics.js';

describe('computeGlobalAicRatio', () => {
  it('computes ratio without double-counting cached tokens', () => {
    const db = {
      queryOne: () => ({
        total_aic: 1e10,   // 10 AIC
        total_tokens: 2000 // 1000 input + 1000 output (NOT + cached)
      })
    };
    const ratio = computeGlobalAicRatio(db);
    expect(ratio).toBe(1e10 / 2000); // 5e6 nano-AIC per token
  });

  it('returns 0 when no sessions with known AIC', () => {
    const db = {
      queryOne: () => ({
        total_aic: 0,
        total_tokens: 0
      })
    };
    expect(computeGlobalAicRatio(db)).toBe(0);
  });
});

describe('computeSessionMetrics', () => {
  it('uses actual total_aic when available', () => {
    const session = {
      total_aic: 1e9, // 1 AIC
      total_input_tokens: 1000,
      total_output_tokens: 500,
      total_cached_tokens: 800
    };
    const result = computeSessionMetrics(session, 0.5e6);
    expect(result.computedAic).toBe(1e9);
    expect(result.isAicApprox).toBe(false);
    expect(result.computedCost).toBe(1e9 / 1e11); // $0.01
  });

  it('estimates AIC from tokens without double-counting cached', () => {
    const session = {
      total_aic: 0,
      total_input_tokens: 1000,
      total_output_tokens: 500,
      total_cached_tokens: 800 // should NOT be added to token count
    };
    const ratio = 1e6; // 1 nano-AIC per token
    const result = computeSessionMetrics(session, ratio);
    // tokens = 1000 + 500 = 1500 (not 1500 + 800 = 2300)
    expect(result.computedAic).toBe(1500 * ratio); // 1.5e9
    expect(result.isAicApprox).toBe(true);
  });

  it('computes cache hit percentage correctly', () => {
    const session = {
      total_aic: 1e9,
      total_input_tokens: 1000,
      total_output_tokens: 500,
      total_cached_tokens: 800
    };
    const result = computeSessionMetrics(session, 0);
    expect(result.cacheHitPct).toBe(80); // 800 / 1000 * 100
  });

  it('returns 0 cache hit when no input tokens', () => {
    const session = {
      total_aic: 1e9,
      total_input_tokens: 0,
      total_output_tokens: 500,
      total_cached_tokens: 0
    };
    const result = computeSessionMetrics(session, 0);
    expect(result.cacheHitPct).toBe(0);
  });
});

