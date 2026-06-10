/**
 * @fileoverview Centralized logging with @@@ [CCA] prefix.
 *
 * All logs use the format: @@@ [CCA] [MODULE/FUNCTION] message
 * Easy to filter in VS Code Dev Tools with "@@@ [CCA]"
 */

/**
 * Create a logger scoped to a module.
 * @param {string} module - Module name (e.g., 'sync', 'db', 'parser')
 * @returns {{ log: Function, warn: Function, error: Function }}
 */
function createLogger(module) {
  const prefix = `@@@ [CCA] [${module}]`;
  return {
    log: (...args) => console.log(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args)
  };
}

module.exports = { createLogger };
