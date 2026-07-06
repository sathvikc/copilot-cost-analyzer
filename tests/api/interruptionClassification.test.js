/**
 * @fileoverview Tests for interruption classification (edited / steered /
 * stopped / interrupted).
 *
 * Ground truth: test-samples session 18d04628 (see docs/log-format-research.md).
 *   - A turn interrupted by the user's NEXT message (steering) keeps its request
 *     in chat history with errorDetails.code='canceled' and the next request is
 *     dispatched machine-fast (0.3–0.5s after the cancel instant).
 *   - A turn stopped with the Stop button either carries the same canceled
 *     marker with a human-speed follow-up, or an empty `result` ({}).
 *   - An edited & resent message disappears from chat history entirely.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { requestEndState, classifyRequestEnd } = require('../../src/api/parser/chatSessionParser');

const CANCELED_RESULT = {
  errorDetails: { code: 'canceled', message: 'Canceled', responseIsIncomplete: true },
  timings: { firstProgress: 27412, totalElapsed: 430143 },
};

describe('requestEndState', () => {
  it('classifies a normal result as completed', () => {
    expect(requestEndState({ result: { timings: { totalElapsed: 5000 }, metadata: {} } })).toBe('completed');
  });

  it('classifies errorDetails.code=canceled as canceled', () => {
    expect(requestEndState({ result: CANCELED_RESULT })).toBe('canceled');
  });

  it('classifies an empty result object as unrecorded (Stop in a non-graceful state)', () => {
    expect(requestEndState({ result: {} })).toBe('unrecorded');
  });

  it('classifies a missing result as unrecorded', () => {
    expect(requestEndState({})).toBe('unrecorded');
    expect(requestEndState({ result: null })).toBe('unrecorded');
  });
});

describe('classifyRequestEnd', () => {
  const t0 = 1781889853645;

  it('canceled + machine-fast next request (0.3s) → steered', () => {
    // Ground truth 18d04628 req2: elapsed 430143ms, next sent 423ms after cancel.
    const req = { timestamp: t0, result: CANCELED_RESULT };
    const next = { timestamp: t0 + 430143 + 423 };
    expect(classifyRequestEnd(req, next, false)).toBe('steered');
  });

  it('canceled + human-speed next request (30s) → stopped', () => {
    const req = { timestamp: t0, result: CANCELED_RESULT };
    const next = { timestamp: t0 + 430143 + 30000 };
    expect(classifyRequestEnd(req, next, false)).toBe('stopped');
  });

  it('canceled with no following request → stopped', () => {
    const req = { timestamp: t0, result: CANCELED_RESULT };
    expect(classifyRequestEnd(req, undefined, true)).toBe('stopped');
  });

  it('canceled without timings falls back to stopped (gap unknowable)', () => {
    const req = { timestamp: t0, result: { errorDetails: { code: 'canceled' } } };
    const next = { timestamp: t0 + 1000 };
    expect(classifyRequestEnd(req, next, false)).toBe('stopped');
  });

  it('empty result mid-session → interrupted (ground truth: explicit Stop)', () => {
    // Ground truth 18d04628 req3: user pressed Stop, result written as {}.
    const req = { timestamp: t0, result: {} };
    expect(classifyRequestEnd(req, { timestamp: t0 + 767000 }, false)).toBe('interrupted');
  });

  it('empty result on the LAST request → null (may still be running)', () => {
    const req = { timestamp: t0, result: {} };
    expect(classifyRequestEnd(req, undefined, true)).toBe(null);
  });

  it('completed request → null', () => {
    const req = { timestamp: t0, result: { timings: { totalElapsed: 12000 }, metadata: {} } };
    expect(classifyRequestEnd(req, { timestamp: t0 + 60000 }, false)).toBe(null);
  });

  it('duplicated-session artifact (next request timestamped BEFORE cancel end) → stopped, not steered', () => {
    // Some forked chatSessions files repeat requests with identical timestamps,
    // producing gap ≈ -elapsed. Those must not read as steering.
    const req = { timestamp: t0, result: { errorDetails: { code: 'canceled' }, timings: { totalElapsed: 36163 } } };
    const next = { timestamp: t0 }; // same instant → gap = -36163ms
    expect(classifyRequestEnd(req, next, false)).toBe('stopped');
  });
});
