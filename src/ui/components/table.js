/**
 * @fileoverview Reusable data table component.
 *
 * Renders table HTML from column definitions and row data.
 * Supports sticky headers, numeric alignment, custom formatters.
 */

import { escapeHtml } from '../helpers.js';

/**
 * Render a table body (tbody inner HTML) from config.
 * @param {Object} config
 * @param {Array<{ label: string, key: string, numeric?: boolean, format?: Function }>} config.columns
 * @param {Array<Object>} config.data
 * @param {string} [config.emptyMessage='No data']
 * @param {Function} [config.rowClass]
 * @returns {string}
 */
export function renderTableBody(config) {
  const { columns, data, emptyMessage = 'No data' } = config;
  if (!data || data.length === 0) {
    return `<tr><td colspan="${columns.length}" class="table-empty">${escapeHtml(emptyMessage)}</td></tr>`;
  }
  return data.map(row => {
    const cells = columns.map(col => {
      const val = row[col.key];
      const formatted = col.format ? col.format(val, row) : (val != null ? escapeHtml(String(val)) : '\u2014');
      const cls = col.numeric ? ' class="numeric"' : '';
      return `<td${cls}>${formatted}</td>`;
    });
    const rowCls = config.rowClass ? ` class="${config.rowClass(row)}"` : '';
    return `<tr${rowCls}>${cells.join('')}</tr>`;
  }).join('');
}

/**
 * Render a complete data table (thead + tbody) as HTML.
 * @param {Object} config
 * @param {Array<{ label: string, key: string, numeric?: boolean, format?: Function }>} config.columns
 * @param {Array<Object>} config.data
 * @param {string} [config.emptyMessage='No data']
 * @param {string} [config.className='data-table']
 * @returns {string}
 */
export function renderTable(config) {
  const { columns, className = 'data-table' } = config;
  const thead = `<thead><tr>${columns.map(c => {
    const cls = c.numeric ? ' class="numeric"' : '';
    return `<th${cls} scope="col">${escapeHtml(c.label)}</th>`;
  }).join('')}</tr></thead>`;
  const tbody = `<tbody>${renderTableBody(config)}</tbody>`;
  return `<table class="${className}" role="table">${thead}${tbody}</table>`;
}
