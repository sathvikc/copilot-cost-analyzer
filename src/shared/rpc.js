/**
 * @fileoverview Typed postMessage RPC layer for extension host ↔ webview communication.
 *
 * Provides a Promise-based request/response pattern over VS Code's postMessage API.
 * Supports error forwarding, timeout, and one-way notifications.
 *
 * Usage (extension host):
 *   const rpc = createHostRpc(panel.webview);
 *   rpc.handle('getSessions', () => sessionApi.getSessions(db));
 *   rpc.handle('getSessionDetail', ({ sessionId }) => sessionApi.getSessionDetail(db, sessionId));
 *   rpc.notify('syncComplete', { synced: 5 });
 *
 * Usage (webview):
 *   const rpc = createWebviewRpc(vscode);
 *   const sessions = await rpc.call('getSessions');
 *   const detail = await rpc.call('getSessionDetail', { sessionId: '...' });
 *   rpc.on('syncComplete', data => { ... });
 */

const { RPC_REQUEST, RPC_RESPONSE, RPC_NOTIFICATION } = require('./messageTypes');

// Default timeout for RPC calls (ms)
const DEFAULT_TIMEOUT = 30000;

// Simple incrementing counter for request IDs (no crypto dependency)
let _nextId = 1;
function nextId() {
  return `rpc:${_nextId++}`;
}

/**
 * Create an RPC host (extension host side).
 * Listens for requests from the webview and dispatches to registered handlers.
 *
 * @param {Object} webview - VS Code Webview instance (must support onDidReceiveMessage + postMessage)
 * @returns {{ handle: Function, notify: Function, dispose: Function }}
 */
function createHostRpc(webview) {
  /** @type {Map<string, Function>} */
  const handlers = new Map();

  const disposable = webview.onDidReceiveMessage(async (message) => {
    if (message.type !== RPC_REQUEST) return;

    const { id, method, params } = message;
    const handler = handlers.get(method);

    if (!handler) {
      webview.postMessage({
        type: RPC_RESPONSE,
        id,
        error: { message: `Unknown method: ${method}`, code: 'METHOD_NOT_FOUND' }
      });
      return;
    }

    try {
      const result = await handler(params || {});
      webview.postMessage({ type: RPC_RESPONSE, id, result });
    } catch (err) {
      webview.postMessage({
        type: RPC_RESPONSE,
        id,
        error: { message: err.message || String(err), code: 'HANDLER_ERROR' }
      });
    }
  });

  return {
    /**
     * Register a handler for a method name.
     * @param {string} method
     * @param {Function} fn - Async or sync handler; receives params object, returns result
     */
    handle(method, fn) {
      handlers.set(method, fn);
    },

    /**
     * Send a one-way notification to the webview (no response expected).
     * @param {string} event
     * @param {*} [data]
     */
    notify(event, data) {
      webview.postMessage({ type: RPC_NOTIFICATION, event, data });
    },

    /**
     * Dispose the message listener.
     */
    dispose() {
      if (disposable && typeof disposable.dispose === 'function') {
        disposable.dispose();
      }
      handlers.clear();
    }
  };
}

/**
 * Create an RPC client (webview side).
 * Sends requests to the extension host and resolves Promises on response.
 *
 * @param {Object} vscodeApi - The acquireVsCodeApi() instance (must support postMessage)
 * @param {Object} [options]
 * @param {number} [options.timeout=30000] - Default timeout in ms
 * @returns {{ call: Function, on: Function, off: Function, dispose: Function }}
 */
function createWebviewRpc(vscodeApi, options = {}) {
  const timeout = options.timeout || DEFAULT_TIMEOUT;

  /** @type {Map<string, { resolve: Function, reject: Function, timer: * }>} */
  const pending = new Map();

  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();

  function handleMessage(event) {
    const message = event.data;

    if (message.type === RPC_RESPONSE) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);

      if (message.error) {
        const err = new Error(message.error.message);
        err.code = message.error.code;
        entry.reject(err);
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    if (message.type === RPC_NOTIFICATION) {
      const cbs = listeners.get(message.event);
      if (cbs) {
        for (const cb of cbs) {
          try { cb(message.data); } catch { /* listener errors don't propagate */ }
        }
      }
    }
  }

  // In a webview, we listen via window.addEventListener
  if (typeof window !== 'undefined') {
    window.addEventListener('message', handleMessage);
  }

  return {
    /**
     * Call a method on the extension host and wait for the response.
     * @param {string} method
     * @param {Object} [params]
     * @returns {Promise<*>}
     */
    call(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC timeout: ${method} (${timeout}ms)`));
        }, timeout);

        pending.set(id, { resolve, reject, timer });
        vscodeApi.postMessage({ type: RPC_REQUEST, id, method, params });
      });
    },

    /**
     * Subscribe to a notification event from the host.
     * @param {string} event
     * @param {Function} callback
     */
    on(event, callback) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(callback);
    },

    /**
     * Unsubscribe from a notification event.
     * @param {string} event
     * @param {Function} callback
     */
    off(event, callback) {
      const cbs = listeners.get(event);
      if (cbs) cbs.delete(callback);
    },

    /**
     * Clean up all pending requests and listeners.
     */
    dispose() {
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('RPC disposed'));
      }
      pending.clear();
      listeners.clear();
      if (typeof window !== 'undefined') {
        window.removeEventListener('message', handleMessage);
      }
    }
  };
}

// Reset the ID counter (for testing)
function _resetIdCounter() {
  _nextId = 1;
}

module.exports = {
  createHostRpc,
  createWebviewRpc,
  _resetIdCounter,
  DEFAULT_TIMEOUT
};
