/**
 * @fileoverview Pure utility functions for the webview — no DOM dependencies.
 */

/**
 * Escape HTML special characters.
 * @param {string|null|undefined} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format a unix timestamp as relative time (e.g. "5m ago", "2d ago").
 * @param {number} ts - Unix timestamp in seconds
 * @returns {string}
 */
export function relativeTime(ts) {
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Truncate text to a maximum number of words.
 * @param {string|null} text
 * @param {number} maxWords
 * @returns {string}
 */
export function shortTitle(text, maxWords = 6) {
  if (!text) return 'Untitled Session';
  const words = text.split(/\s+/);
  return words.length <= maxWords ? text : words.slice(0, maxWords).join(' ') + '\u2026';
}

/**
 * Copy text to clipboard and show a toast notification.
 * @param {string} text
 * @param {string} [label]
 */
export function copyText(text, label) {
  navigator.clipboard.writeText(text).catch(() => {});
  showToast((label ? label + ' ' : '') + 'copied!');
}

/**
 * Show a temporary toast notification.
 * @param {string} message
 * @param {number} [duration=2000]
 */
export function showToast(message, duration = 2000) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.add('hidden'), duration);
}

/** Tool name to icon mapping */
const TOOL_ICONS = {
  read_file: '\uD83D\uDCC4', write_file: '\u270F\uFE0F', edit_file: '\uD83D\uDCDD',
  file_search: '\uD83D\uDD0D', list_dir: '\uD83D\uDCC1', run_in_terminal: '\uD83D\uDDA5\uFE0F',
  run_command: '\u26A1', manage_todo_list: '\u2705', thinking: '\uD83D\uDCAD',
  ask_followup_question: '\u2753', attempt_completion: '\uD83C\uDFC1',
  default: '\uD83D\uDD27'
};

/**
 * Get the emoji icon for a tool name.
 * @param {string} name
 * @returns {string}
 */
export function getToolIcon(name) {
  return TOOL_ICONS[name] || TOOL_ICONS.default;
}

/**
 * Create an HTML element with optional attributes and children.
 * @param {string} tag
 * @param {Object} [attrs]
 * @param {...(string|Node)} children
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') element.className = value;
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key.startsWith('on')) element.addEventListener(key.slice(2).toLowerCase(), value);
    else element.setAttribute(key, value);
  }
  for (const child of children) {
    if (typeof child === 'string') element.appendChild(document.createTextNode(child));
    else if (child instanceof Node) element.appendChild(child);
  }
  return element;
}
