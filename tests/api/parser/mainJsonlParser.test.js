/**
 * @fileoverview Unit tests for mainJsonlParser.js
 *
 * Tests AIC fallback extraction and delta recomputation after merge.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseSessionDirectory } from '../../../src/api/parser/mainJsonlParser.js';

describe('parseSessionDirectory', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts AIC from nested attrs.usage.copilotUsageNanoAiu (older log format)', async () => {
    const mainJsonl = path.join(tmpDir, 'main.jsonl');
    const lines = [
      JSON.stringify({ type: 'user_message', ts: '2026-01-01T00:00:00Z', attrs: { content: 'hello' } }),
      JSON.stringify({ type: 'turn_start', ts: '2026-01-01T00:00:00Z' }),
      JSON.stringify({
        type: 'llm_request',
        status: 'ok',
        ts: '2026-01-01T00:00:01Z',
        attrs: {
          model: 'gpt-test',
          inputTokens: 1000,
          outputTokens: 500,
          cachedTokens: 200,
          usage: { copilotUsageNanoAiu: 123456789 }
        }
      }),
    ];
    fs.writeFileSync(mainJsonl, lines.join('\n'));

    const result = await parseSessionDirectory(tmpDir, 'test-session');
    expect(result.llmCalls).toHaveLength(1);
    expect(result.llmCalls[0].aic).toBe(123456789);
  });

  it('extracts AIC from top-level attrs.copilotUsageNanoAiu (current format)', async () => {
    const mainJsonl = path.join(tmpDir, 'main.jsonl');
    const lines = [
      JSON.stringify({ type: 'user_message', ts: '2026-01-01T00:00:00Z', attrs: { content: 'hello' } }),
      JSON.stringify({ type: 'turn_start', ts: '2026-01-01T00:00:00Z' }),
      JSON.stringify({
        type: 'llm_request',
        status: 'ok',
        ts: '2026-01-01T00:00:01Z',
        attrs: {
          model: 'gpt-test',
          inputTokens: 1000,
          outputTokens: 500,
          cachedTokens: 200,
          copilotUsageNanoAiu: 987654321
        }
      }),
    ];
    fs.writeFileSync(mainJsonl, lines.join('\n'));

    const result = await parseSessionDirectory(tmpDir, 'test-session');
    expect(result.llmCalls).toHaveLength(1);
    expect(result.llmCalls[0].aic).toBe(987654321);
  });

  it('recomputes deltas globally after merging main + subagent files', async () => {
    const mainJsonl = path.join(tmpDir, 'main.jsonl');
    const subJsonl = path.join(tmpDir, 'runSubagent-sub.jsonl');

    // Main: two calls with 1000, 1500 input tokens
    fs.writeFileSync(mainJsonl, [
      JSON.stringify({ type: 'user_message', ts: '2026-01-01T00:00:00Z', attrs: { content: 'main prompt' } }),
      JSON.stringify({ type: 'turn_start', ts: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'llm_request', status: 'ok', ts: '2026-01-01T00:00:01Z', attrs: { model: 'm1', inputTokens: 1000, outputTokens: 100 } }),
      JSON.stringify({ type: 'llm_request', status: 'ok', ts: '2026-01-01T00:00:02Z', attrs: { model: 'm1', inputTokens: 1500, outputTokens: 100 } }),
    ].join('\n'));

    // Subagent: one call with 2000 input tokens, but timestamp is BETWEEN main calls
    fs.writeFileSync(subJsonl, [
      JSON.stringify({ type: 'user_message', ts: '2026-01-01T00:00:00Z', attrs: { content: 'sub prompt' } }),
      JSON.stringify({ type: 'turn_start', ts: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'llm_request', status: 'ok', ts: '2026-01-01T00:00:01.500Z', attrs: { model: 'm2', inputTokens: 2000, outputTokens: 100 } }),
    ].join('\n'));

    const result = await parseSessionDirectory(tmpDir, 'test-session');
    expect(result.llmCalls).toHaveLength(3);

    // After sorting by timestamp, order should be: 1000 (t=1), 2000 (t=1.5), 1500 (t=2)
    const [c1, c2, c3] = result.llmCalls;
    expect(c1.inputTokens).toBe(1000);
    expect(c2.inputTokens).toBe(2000);
    expect(c3.inputTokens).toBe(1500);

    // Deltas are per-context (main vs subagent) so subagent doesn't reference main:
    // c1 (main): no previous main -> 0
    // c2 (subagent): no previous sub -> 0 (new independent context)
    // c3 (main): 1500 - 1000 (last main c1) = +500
    expect(c1.deltaInput).toBe(0);
    expect(c2.deltaInput).toBe(0);
    expect(c3.deltaInput).toBe(500);
  });

  it('parses llm_request regardless of status (not just ok)', async () => {
    const mainJsonl = path.join(tmpDir, 'main.jsonl');
    const lines = [
      JSON.stringify({ type: 'user_message', ts: '2026-01-01T00:00:00Z', attrs: { content: 'hello' } }),
      JSON.stringify({
        type: 'llm_request',
        status: 'error',
        ts: '2026-01-01T00:00:01Z',
        attrs: {
          model: 'gpt-test',
          inputTokens: 1000,
          outputTokens: 500,
          cachedTokens: 200,
          copilotUsageNanoAiu: 123456789
        }
      }),
    ];
    fs.writeFileSync(mainJsonl, lines.join('\n'));

    const result = await parseSessionDirectory(tmpDir, 'test-session');
    expect(result.llmCalls).toHaveLength(1);
    expect(result.llmCalls[0].status).toBe('error');
    expect(result.llmCalls[0].aic).toBe(123456789);
  });

  it('records model switches on retry only when model changes', async () => {
    const mainJsonl = path.join(tmpDir, 'main.jsonl');
    const lines = [
      JSON.stringify({ type: 'user_message', ts: '2026-01-01T00:00:00Z', attrs: { content: 'hello' } }),
      JSON.stringify({ type: 'llm_request', status: 'ok', ts: '2026-01-01T00:00:01Z', attrs: { model: 'claude-3.7', inputTokens: 1000, outputTokens: 100 } }),
      // Same-model retry is NOT a switch
      JSON.stringify({ type: 'llm_request', status: 'error', ts: '2026-01-01T00:00:02Z', attrs: { model: 'claude-3.7', inputTokens: 1000, outputTokens: 100, debugName: 'retry-error-panel/editAgent' } }),
      // Retry that changes model IS a legitimate switch
      JSON.stringify({ type: 'llm_request', status: 'ok', ts: '2026-01-01T00:00:03Z', attrs: { model: 'gpt-4o', inputTokens: 1000, outputTokens: 100, debugName: 'retry-panel/editAgent' } }),
    ];
    fs.writeFileSync(mainJsonl, lines.join('\n'));

    const result = await parseSessionDirectory(tmpDir, 'test-session');
    expect(result.llmCalls).toHaveLength(3);
    // All 3 calls should be parsed regardless of status
    expect(result.llmCalls[0].status).toBe('ok');
    expect(result.llmCalls[1].status).toBe('error');
    expect(result.llmCalls[2].status).toBe('ok');
    // Only the model-changing retry should be recorded as a switch
    expect(result.modelSwitches).toHaveLength(1);
    expect(result.modelSwitches[0].fromModel).toBe('claude-3.7');
    expect(result.modelSwitches[0].toModel).toBe('gpt-4o');
  });

  it('extracts tool dur from top-level event field (not attrs)', async () => {
    const mainJsonl = path.join(tmpDir, 'main.jsonl');
    fs.writeFileSync(mainJsonl, [
      JSON.stringify({ type: 'user_message', ts: '2026-01-01T00:00:00Z', attrs: { content: 'hello' } }),
      JSON.stringify({ type: 'tool_call', ts: '2026-01-01T00:00:01Z', dur: 450, name: 'read_file', parentSpanId: 'abc', attrs: { result: 'ok', args: '{}' } }),
      JSON.stringify({ type: 'tool_call', ts: '2026-01-01T00:00:02Z', name: 'grep_search', attrs: { result: 'ok', args: '{}' } }),
      JSON.stringify({ type: 'llm_request', status: 'ok', ts: '2026-01-01T00:00:03Z', spanId: 'llm1', attrs: { model: 'gpt-test', inputTokens: 1000, outputTokens: 100, ttft: 2100 } }),
    ].join('\n'));

    const result = await parseSessionDirectory(tmpDir, 'test-session');
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].dur).toBe(450);
    expect(result.toolCalls[0].parentSpanId).toBe('abc');
    expect(result.toolCalls[1].dur).toBeNull();
    expect(result.toolCalls[1].parentSpanId).toBeNull();
    // LLM call should have spanId and ttft from top-level / attrs
    expect(result.llmCalls).toHaveLength(1);
    expect(result.llmCalls[0].spanId).toBe('llm1');
    expect(result.llmCalls[0].ttft).toBe(2100);
  });

  it('links tools to LLM calls via shared parentSpanId (sibling matching)', async () => {
    const mainJsonl = path.join(tmpDir, 'main.jsonl');
    // Two tools and one LLM call sharing parentSpanId 'turn-1'
    // Another LLM call with a different parent
    fs.writeFileSync(mainJsonl, [
      JSON.stringify({ type: 'user_message', ts: '2026-01-01T00:00:00Z', attrs: { content: 'hello' } }),
      JSON.stringify({ type: 'tool_call', ts: '2026-01-01T00:00:01Z', dur: 100, name: 'read_file', parentSpanId: 'turn-1', attrs: { result: 'ok', args: '{}' } }),
      JSON.stringify({ type: 'tool_call', ts: '2026-01-01T00:00:02Z', dur: 200, name: 'grep_search', parentSpanId: 'turn-1', attrs: { result: 'ok', args: '{}' } }),
      JSON.stringify({ type: 'llm_request', status: 'ok', ts: '2026-01-01T00:00:03Z', spanId: 'llm-a', parentSpanId: 'turn-1', attrs: { model: 'gpt-test', inputTokens: 1000, outputTokens: 100 } }),
      JSON.stringify({ type: 'user_message', ts: '2026-01-01T00:00:10Z', attrs: { content: 'second' } }),
      JSON.stringify({ type: 'tool_call', ts: '2026-01-01T00:00:11Z', dur: 50, name: 'list_dir', parentSpanId: 'turn-2', attrs: { result: 'ok', args: '{}' } }),
      JSON.stringify({ type: 'llm_request', status: 'ok', ts: '2026-01-01T00:00:12Z', spanId: 'llm-b', parentSpanId: 'turn-2', attrs: { model: 'gpt-test', inputTokens: 2000, outputTokens: 100 } }),
    ].join('\n'));

    const result = await parseSessionDirectory(tmpDir, 'test-session');
    // Tools in turn-1 should link to LLM call#1 (shared parentSpanId 'turn-1')
    expect(result.toolCalls[0].linkedLlmCallId).toBe(1);
    expect(result.toolCalls[1].linkedLlmCallId).toBe(1);
    // Tool in turn-2 should link to LLM call#2 (shared parentSpanId 'turn-2')
    expect(result.toolCalls[2].linkedLlmCallId).toBe(2);
  });

  it('groups agent steps into a single user turn (turn boundary = user_message)', async () => {
    const mainJsonl = path.join(tmpDir, 'main.jsonl');
    // Simulate a session where the agent does multiple steps (turn_start + tool + llm)
    // between two real user messages.
    fs.writeFileSync(mainJsonl, [
      JSON.stringify({ type: 'user_message', ts: '2026-01-01T00:00:00Z', attrs: { content: 'first prompt' } }),
      JSON.stringify({ type: 'turn_start', ts: '2026-01-01T00:00:01Z' }),
      JSON.stringify({ type: 'tool_call', ts: '2026-01-01T00:00:02Z', name: 'read_file', attrs: { result: 'ok', args: '{}' } }),
      JSON.stringify({ type: 'llm_request', status: 'ok', ts: '2026-01-01T00:00:03Z', attrs: { model: 'm1', inputTokens: 1000, outputTokens: 100 } }),
      JSON.stringify({ type: 'turn_start', ts: '2026-01-01T00:00:04Z' }), // agent step, NOT a new user turn
      JSON.stringify({ type: 'tool_call', ts: '2026-01-01T00:00:05Z', name: 'read_file', attrs: { result: 'ok', args: '{}' } }),
      JSON.stringify({ type: 'llm_request', status: 'ok', ts: '2026-01-01T00:00:06Z', attrs: { model: 'm1', inputTokens: 1500, outputTokens: 100 } }),
      JSON.stringify({ type: 'user_message', ts: '2026-01-01T00:00:10Z', attrs: { content: 'second prompt' } }),
      JSON.stringify({ type: 'turn_start', ts: '2026-01-01T00:00:11Z' }),
      JSON.stringify({ type: 'llm_request', status: 'ok', ts: '2026-01-01T00:00:12Z', attrs: { model: 'm1', inputTokens: 2000, outputTokens: 100 } }),
    ].join('\n'));

    const result = await parseSessionDirectory(tmpDir, 'test-session');

    // Should produce exactly 2 user turns
    const turnNumbers = [...new Set(result.llmCalls.map(c => c.turnNumber))];
    expect(turnNumbers).toEqual([1, 2]);

    // Turn 1 should have 2 LLM calls (both agent steps belong to the first user turn)
    const turn1Calls = result.llmCalls.filter(c => c.turnNumber === 1);
    expect(turn1Calls).toHaveLength(2);
    expect(turn1Calls[0].inputTokens).toBe(1000);
    expect(turn1Calls[1].inputTokens).toBe(1500);

    // Turn 2 should have 1 LLM call
    const turn2Calls = result.llmCalls.filter(c => c.turnNumber === 2);
    expect(turn2Calls).toHaveLength(1);
    expect(turn2Calls[0].inputTokens).toBe(2000);

    // Both user messages should be captured
    expect(result.userMessages).toHaveLength(2);
    expect(result.userMessages[0].content).toBe('first prompt');
    expect(result.userMessages[0].turnNumber).toBe(1);
    expect(result.userMessages[1].content).toBe('second prompt');
    expect(result.userMessages[1].turnNumber).toBe(2);
  });
});
