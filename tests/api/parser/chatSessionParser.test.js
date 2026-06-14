/**
 * @fileoverview Unit tests for chatSessionParser.js
 *
 * Builds synthetic chatSessions patch streams (snapshot + kind:1/kind:2 patches)
 * so the tests run without the user's real VS Code storage.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseChatSessionFile, reconstructSession, applyPatch } from '../../../src/api/parser/chatSessionParser.js';

/** Write JSONL lines to a temp file and return its path. */
function writeJsonl(dir, name, objs) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, objs.map((o) => JSON.stringify(o)).join('\n'));
  return p;
}

describe('chatSessionParser', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cca-cs-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('applyPatch / reconstructSession', () => {
    it('kind:1 sets a value at a key-path', () => {
      const root = { requests: [{ requestId: 'r0' }] };
      applyPatch(root, ['requests', 0, 'completionTokens'], '1089', 1);
      expect(root.requests[0].completionTokens).toBe('1089');
    });

    it('kind:2 merges numeric-keyed values into an array by index', () => {
      const root = { requests: [{ response: [] }] };
      applyPatch(root, ['requests', 0, 'response'], { 0: { kind: 'thinking', value: 'a' }, 1: { value: 'b' } }, 2);
      expect(root.requests[0].response).toHaveLength(2);
      expect(root.requests[0].response[1].value).toBe('b');
    });

    it('kind:2 appends new requests to the top-level requests array', () => {
      const root = { requests: [{ requestId: 'r0', modelId: 'copilot/gpt-5-mini' }] };
      applyPatch(root, ['requests'], { 1: { requestId: 'r1', modelId: 'copilot/claude-sonnet-4.6' } }, 2);
      expect(root.requests).toHaveLength(2);
      expect(root.requests[1].requestId).toBe('r1');
    });

    it('reconstructs snapshot + patches in order', () => {
      const session = reconstructSession([
        JSON.stringify({ kind: 0, v: { customTitle: 'orig', requests: [{ requestId: 'r0' }] } }),
        JSON.stringify({ kind: 1, k: ['customTitle'], v: 'renamed' }),
        JSON.stringify({ kind: 1, k: ['requests', 0, 'completionTokens'], v: '42' }),
      ]);
      expect(session.customTitle).toBe('renamed');
      expect(session.requests[0].completionTokens).toBe('42');
    });
  });

  describe('parseChatSessionFile', () => {
    it('maps a completed turn to an LLM call with estimated-friendly NULLs', () => {
      const filePath = writeJsonl(tmpDir, 'sess.jsonl', [
        {
          kind: 0,
          v: {
            customTitle: 'My session',
            creationDate: 1780892700000,
            initialLocation: 'panel',
            requests: [{
              requestId: 'r0',
              timestamp: 1780892700230,
              modelId: 'copilot/gpt-5-mini',
              modeInfo: { modeId: 'agent' },
              message: { text: 'hello world' },
              response: [],
            }],
          },
        },
        { kind: 1, k: ['requests', 0, 'result'], v: { metadata: { promptTokens: 19608, outputTokens: 49, resolvedModel: 'gpt-5-mini-2025-08-07' } } },
        { kind: 1, k: ['requests', 0, 'completionTokens'], v: '1089' },
        { kind: 2, k: ['requests', 0, 'response'], v: { 0: { value: 'Here is the answer.' } } },
      ]);

      const result = parseChatSessionFile(filePath, 'sess');

      expect(result.llmCalls).toHaveLength(1);
      const call = result.llmCalls[0];
      expect(call.model).toBe('gpt-5-mini'); // copilot/ prefix stripped
      expect(call.inputTokens).toBe(19608);
      expect(call.outputTokens).toBe(1089); // cumulative completionTokens, not outputTokens(49)
      expect(call.cachedTokens).toBeNull();
      expect(call.aic).toBeNull();
      expect(call.timestamp).toBe(Math.floor(1780892700230 / 1000));

      expect(result.title).toBe('My session');
      expect(result.mode).toBe('agent');
      expect(result.initialLocation).toBe('panel');
      expect(result.firstPrompt).toBe('hello world');
      expect(result.hasSubagent).toBe(false);
      expect(result.userMessages[0].content).toBe('hello world');
      expect(result.agentResponses[0].responseText).toBe('Here is the answer.');
    });

    it('extracts tool calls and results from toolCallRounds', () => {
      const filePath = writeJsonl(tmpDir, 'sess.jsonl', [
        {
          kind: 0,
          v: {
            requests: [{
              requestId: 'r0',
              timestamp: 1780892700230,
              modelId: 'copilot/gpt-5-mini',
              message: { text: 'do a thing' },
              response: [],
            }],
          },
        },
        {
          kind: 1,
          k: ['requests', 0, 'result'],
          v: {
            metadata: {
              promptTokens: 1000,
              toolCallRounds: [{
                response: 'Working on it.',
                thinking: 'Let me plan.',
                toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a.js"}' }],
              }],
              toolCallResults: { call_1: { content: [{ value: 'file contents here' }] } },
            },
          },
        },
        { kind: 1, k: ['requests', 0, 'completionTokens'], v: '20' },
      ]);

      const result = parseChatSessionFile(filePath, 'sess');
      expect(result.toolCalls).toHaveLength(1);
      const tool = result.toolCalls[0];
      expect(tool.toolName).toBe('read_file');
      expect(tool.argsFull).toBe('{"path":"a.js"}');
      expect(tool.resultText).toBe('file contents here');
      expect(tool.linkedLlmCallId).toBe(1);
      // Falls back to toolCallRounds for response/reasoning when no markdown parts.
      expect(result.agentResponses[0].responseText).toBe('Working on it.');
      expect(result.agentResponses[0].reasoningText).toBe('Let me plan.');
    });

    it('detects a model switch across turns and appended requests', () => {
      const filePath = writeJsonl(tmpDir, 'sess.jsonl', [
        {
          kind: 0,
          v: {
            requests: [{
              requestId: 'r0', timestamp: 1780892700000, modelId: 'copilot/gpt-5-mini',
              message: { text: 'first' }, response: [],
            }],
          },
        },
        { kind: 1, k: ['requests', 0, 'completionTokens'], v: '10' },
        { kind: 2, k: ['requests'], v: { 1: {
          requestId: 'r1', timestamp: 1780892800000, modelId: 'copilot/claude-sonnet-4.6',
          message: { text: 'second' }, response: [],
        } } },
        { kind: 1, k: ['requests', 1, 'completionTokens'], v: '15' },
      ]);

      const result = parseChatSessionFile(filePath, 'sess');
      expect(result.llmCalls).toHaveLength(2);
      expect(result.modelSwitches).toHaveLength(1);
      expect(result.modelSwitches[0].fromModel).toBe('gpt-5-mini');
      expect(result.modelSwitches[0].toModel).toBe('claude-sonnet-4.6');
      expect(result.firstTs).toBe(Math.floor(1780892700000 / 1000));
      expect(result.lastTs).toBe(Math.floor(1780892800000 / 1000));
    });

    it('returns an empty (but well-shaped) result for an unreadable file', () => {
      const result = parseChatSessionFile(path.join(tmpDir, 'missing.jsonl'), 'sess');
      expect(result.llmCalls).toEqual([]);
      expect(result.title).toBeNull();
      expect(result.sessionMeta).toEqual({ copilotVersion: null, vscodeVersion: null });
    });

    it('skips a request that never ran (no model)', () => {
      const filePath = writeJsonl(tmpDir, 'sess.jsonl', [
        { kind: 0, v: { requests: [{ requestId: 'r0', message: { text: 'pending' } }] } },
      ]);
      const result = parseChatSessionFile(filePath, 'sess');
      expect(result.llmCalls).toEqual([]);
    });
  });
});
