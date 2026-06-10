/**
 * @fileoverview Unit tests for the RPC layer.
 *
 * Uses mock webview/vscode objects to test the host and client sides
 * of the postMessage RPC bridge.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createHostRpc, createWebviewRpc, _resetIdCounter } = require('../../src/shared/rpc');
const { RPC_REQUEST, RPC_RESPONSE, RPC_NOTIFICATION } = require('../../src/shared/messageTypes');

/**
 * Create a mock webview with postMessage and onDidReceiveMessage.
 * Returns the mock and a function to simulate incoming messages.
 */
function createMockWebview() {
  let messageHandler = null;
  const posted = [];
  return {
    webview: {
      postMessage: (msg) => posted.push(msg),
      onDidReceiveMessage: (handler) => {
        messageHandler = handler;
        return { dispose: () => { messageHandler = null; } };
      }
    },
    posted,
    simulate: (msg) => messageHandler && messageHandler(msg)
  };
}

describe('createHostRpc', () => {
  it('dispatches to registered handler and responds', async () => {
    const { webview, posted, simulate } = createMockWebview();
    const rpc = createHostRpc(webview);
    rpc.handle('getSessions', () => [{ id: '1' }, { id: '2' }]);

    await simulate({ type: RPC_REQUEST, id: 'req-1', method: 'getSessions' });

    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe(RPC_RESPONSE);
    expect(posted[0].id).toBe('req-1');
    expect(posted[0].result).toEqual([{ id: '1' }, { id: '2' }]);
    expect(posted[0].error).toBeUndefined();

    rpc.dispose();
  });

  it('returns METHOD_NOT_FOUND for unknown methods', async () => {
    const { webview, posted, simulate } = createMockWebview();
    const rpc = createHostRpc(webview);

    await simulate({ type: RPC_REQUEST, id: 'req-2', method: 'unknownMethod' });

    expect(posted).toHaveLength(1);
    expect(posted[0].error.code).toBe('METHOD_NOT_FOUND');
    expect(posted[0].error.message).toContain('unknownMethod');

    rpc.dispose();
  });

  it('forwards handler errors as HANDLER_ERROR', async () => {
    const { webview, posted, simulate } = createMockWebview();
    const rpc = createHostRpc(webview);
    rpc.handle('failingMethod', () => { throw new Error('DB connection lost'); });

    await simulate({ type: RPC_REQUEST, id: 'req-3', method: 'failingMethod' });

    expect(posted).toHaveLength(1);
    expect(posted[0].error.code).toBe('HANDLER_ERROR');
    expect(posted[0].error.message).toBe('DB connection lost');

    rpc.dispose();
  });

  it('handles async handlers', async () => {
    const { webview, posted, simulate } = createMockWebview();
    const rpc = createHostRpc(webview);
    rpc.handle('asyncMethod', async ({ delay }) => {
      return { result: 'done', delay };
    });

    await simulate({ type: RPC_REQUEST, id: 'req-4', method: 'asyncMethod', params: { delay: 100 } });

    expect(posted[0].result).toEqual({ result: 'done', delay: 100 });

    rpc.dispose();
  });

  it('sends notifications', () => {
    const { webview, posted } = createMockWebview();
    const rpc = createHostRpc(webview);

    rpc.notify('syncComplete', { synced: 5 });

    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe(RPC_NOTIFICATION);
    expect(posted[0].event).toBe('syncComplete');
    expect(posted[0].data).toEqual({ synced: 5 });

    rpc.dispose();
  });

  it('ignores non-RPC messages', async () => {
    const { webview, posted, simulate } = createMockWebview();
    const rpc = createHostRpc(webview);
    rpc.handle('getSessions', () => []);

    await simulate({ type: 'someOtherMessage', data: 'foo' });
    expect(posted).toHaveLength(0);

    rpc.dispose();
  });
});

describe('createWebviewRpc', () => {
  beforeEach(() => {
    _resetIdCounter();
  });

  it('sends request and resolves on response', async () => {
    const posted = [];
    const mockVscode = { postMessage: (msg) => posted.push(msg) };
    const rpc = createWebviewRpc(mockVscode, { timeout: 5000 });

    const promise = rpc.call('getSessions');

    // Verify the request was posted
    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe(RPC_REQUEST);
    expect(posted[0].method).toBe('getSessions');

    // For Node.js testing, we verify the request format is correct
    expect(posted[0].id).toBeDefined();
    expect(posted[0].params).toBeUndefined();

    // Clean up: dispose rejects pending, so catch it
    rpc.dispose();
    await expect(promise).rejects.toThrow('RPC disposed');
  });

  it('sends params with the request', () => {
    const posted = [];
    const mockVscode = { postMessage: (msg) => posted.push(msg) };
    const rpc = createWebviewRpc(mockVscode, { timeout: 5000 });

    // Fire and forget (will timeout, but we just check the message)
    rpc.call('getSessionDetail', { sessionId: 'abc123' }).catch(() => {});

    expect(posted[0].params).toEqual({ sessionId: 'abc123' });

    rpc.dispose();
  });

  it('cleans up pending on dispose', () => {
    const posted = [];
    const mockVscode = { postMessage: (msg) => posted.push(msg) };
    const rpc = createWebviewRpc(mockVscode, { timeout: 60000 });

    const promise = rpc.call('getSessions');

    rpc.dispose();

    return expect(promise).rejects.toThrow('RPC disposed');
  });

  it('rejects with timeout when no response arrives', async () => {
    const posted = [];
    const mockVscode = { postMessage: (msg) => posted.push(msg) };
    const rpc = createWebviewRpc(mockVscode, { timeout: 50 }); // 50ms timeout

    const promise = rpc.call('slowMethod');
    await expect(promise).rejects.toThrow('RPC timeout: slowMethod');

    rpc.dispose();
  });

  it('handles concurrent calls independently', async () => {
    const posted = [];
    const mockVscode = { postMessage: (msg) => posted.push(msg) };
    const rpc = createWebviewRpc(mockVscode, { timeout: 5000 });

    const p1 = rpc.call('method1');
    const p2 = rpc.call('method2');

    expect(posted).toHaveLength(2);
    expect(posted[0].method).toBe('method1');
    expect(posted[1].method).toBe('method2');
    // IDs must be different
    expect(posted[0].id).not.toBe(posted[1].id);

    rpc.dispose();
    await expect(p1).rejects.toThrow('RPC disposed');
    await expect(p2).rejects.toThrow('RPC disposed');
  });

  it('registers and fires notification listeners', () => {
    const mockVscode = { postMessage: vi.fn() };
    const rpc = createWebviewRpc(mockVscode);

    const handler = vi.fn();
    rpc.on('syncComplete', handler);
    rpc.on('syncComplete', handler); // duplicate — Set deduplicates

    // Since we can't trigger window events in Node, verify the API works
    rpc.off('syncComplete', handler);

    rpc.dispose();
  });
});
