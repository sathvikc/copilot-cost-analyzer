/**
 * @fileoverview Unit tests for shared formatters module.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
  formatNumber,
  formatCost,
  formatAic,
  formatLatency,
  latencyClass,
  formatCompact,
  escapeHtml
} = require('../../src/shared/formatters');

describe('formatNumber', () => {
  it('formats integers with locale grouping', () => {
    expect(formatNumber(1234567)).toContain('1');
    expect(formatNumber(0)).toBe('0');
  });

  it('returns — for null/undefined', () => {
    expect(formatNumber(null)).toBe('—');
    expect(formatNumber(undefined)).toBe('—');
  });

});

describe('formatCost', () => {
  it('returns — for null/undefined', () => {
    expect(formatCost(null)).toBe('—');
    expect(formatCost(undefined)).toBe('—');
  });

  it('uses 6 decimal places for very small costs', () => {
    expect(formatCost(0.00001)).toBe('$0.000010');
  });

  it('uses 4 decimal places for small costs', () => {
    expect(formatCost(0.005)).toBe('$0.0050');
  });

  it('uses 2 decimal places for normal costs', () => {
    expect(formatCost(1.5)).toBe('$1.50');
    expect(formatCost(0.01)).toBe('$0.01');
  });

  it('handles zero', () => {
    expect(formatCost(0)).toBe('$0.00');
  });

});

describe('formatAic', () => {
  it('returns — for null/undefined', () => {
    expect(formatAic(null)).toBe('—');
    expect(formatAic(undefined)).toBe('—');
  });

  it('formats small AIC with 4 decimal places', () => {
    expect(formatAic(0.005e9)).toBe('0.0050 AIC');
  });

  it('formats medium AIC with 2 decimal places', () => {
    expect(formatAic(0.5e9)).toBe('0.50 AIC');
  });

  it('formats large AIC as integer', () => {
    expect(formatAic(5e9)).toBe('5 AIC');
    expect(formatAic(100e9)).toBe('100 AIC');
  });

});

describe('formatLatency', () => {
  it('returns — for null/undefined', () => {
    expect(formatLatency(null)).toBe('—');
    expect(formatLatency(undefined)).toBe('—');
  });

  it('formats > 1000ms as seconds', () => {
    expect(formatLatency(1500)).toBe('1.5s');
    expect(formatLatency(3200)).toBe('3.2s');
  });

  it('formats <= 1000ms as milliseconds', () => {
    expect(formatLatency(500)).toBe('500ms');
    expect(formatLatency(1000)).toBe('1000ms');
  });

});

describe('latencyClass', () => {
  it('returns empty string for null/undefined', () => {
    expect(latencyClass(null)).toBe('');
    expect(latencyClass(undefined)).toBe('');
  });

  it('classifies fast/mid/slow', () => {
    expect(latencyClass(500)).toBe('fast');
    expect(latencyClass(999)).toBe('fast');
    expect(latencyClass(1000)).toBe('mid');
    expect(latencyClass(5000)).toBe('mid');
    expect(latencyClass(5001)).toBe('slow');
  });

});

describe('formatCompact', () => {
  it('returns — for null/undefined', () => {
    expect(formatCompact(null)).toBe('—');
    expect(formatCompact(undefined)).toBe('—');
  });

  it('formats millions', () => {
    expect(formatCompact(1500000)).toBe('1.5M');
  });

  it('formats thousands', () => {
    expect(formatCompact(45000)).toBe('45.0K');
  });

  it('returns raw number for small values', () => {
    expect(formatCompact(42)).toBe('42');
  });

});

describe('escapeHtml', () => {
  it('returns empty string for null/undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('escapes all special characters', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  it('escapes ampersands and single quotes', () => {
    expect(escapeHtml("Tom & Jerry's")).toBe('Tom &amp; Jerry&#39;s');
  });

  it('passes through safe strings unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  it('coerces non-string values to string', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(true)).toBe('true');
  });
});
