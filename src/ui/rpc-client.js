/**
 * @fileoverview Webview-side RPC client.
 *
 * Promise-based request/response over VS Code's postMessage API.
 * Supports notifications from the extension host.
 */

const RPC_REQUEST = 'rpc:request';
const RPC_RESPONSE = 'rpc:response';
const RPC_NOTIFICATION = 'rpc:notification';
const DEFAULT_TIMEOUT = 30000;

let _nextId = 1;

/**
 * Create a webview-side RPC client.
 * @param {Object} vscodeApi - acquireVsCodeApi() instance
 * @param {Object} [options]
 * @param {number} [options.timeout=30000]
 * @returns {{ call: Function, on: Function, off: Function, dispose: Function }}
 */
export function createWebviewRpc(vscodeApi, options = {}) {
  const timeout = options.timeout || DEFAULT_TIMEOUT;

  /** @type {Map<string, { resolve: Function, reject: Function, timer: number }>} */
  const pending = new Map();

  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();

  function handleMessage(event) {
    const msg = event.data;

    if (msg.type === RPC_RESPONSE) {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        const err = new Error(msg.error.message);
        err.code = msg.error.code;
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    if (msg.type === RPC_NOTIFICATION) {
      const cbs = listeners.get(msg.event);
      if (cbs) {
        for (const cb of cbs) {
          try { cb(msg.data); } catch { /* swallow listener errors */ }
        }
      }
    }
  }

  window.addEventListener('message', handleMessage);

  return {
    /**
     * Call a method on the extension host and await the response.
     * @param {string} method
     * @param {Object} [params]
     * @returns {Promise<*>}
     */
    call(method, params) {
      return new Promise((resolve, reject) => {
        const id = `rpc:${_nextId++}`;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC timeout: ${method} (${timeout}ms)`));
        }, timeout);
        pending.set(id, { resolve, reject, timer });
        vscodeApi.postMessage({ type: RPC_REQUEST, id, method, params });
      });
    },

    /**
     * Subscribe to a notification from the extension host.
     * @param {string} event
     * @param {Function} callback
     */
    on(event, callback) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(callback);
    },

    /**
     * Unsubscribe from a notification.
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
      window.removeEventListener('message', handleMessage);
    }
  };
}
