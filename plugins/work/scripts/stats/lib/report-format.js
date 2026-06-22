'use strict';

/**
 * Shared renderer for `/stats` and `/health` (GH-317 / R10).
 *
 * Pure module: no fs/git/process side effects, zero runtime dependencies.
 * Both commands emit the same `[PASS]/[WARN]/[FAIL]/[SKIP]` status lines and
 * two-space-indented `Key: value` metric blocks via these helpers.
 */

const KNOWN_STATUSES = ['PASS', 'WARN', 'FAIL', 'SKIP'];

/**
 * Render a single status line: `[STATUS] <label> — <detail>`.
 *
 * @param {{ status: string, label: string, detail?: string }} entry
 * @returns {string} the formatted status line
 * @throws {Error} when `status` is not one of PASS/WARN/FAIL/SKIP
 */
function statusLine({ status, label, detail } = {}) {
  if (!KNOWN_STATUSES.includes(status)) {
    throw new Error(
      `Unknown status "${status}". Expected one of: ${KNOWN_STATUSES.join(', ')}.`,
    );
  }
  const head = `[${status}] ${label}`;
  return detail === undefined || detail === null || detail === ''
    ? head
    : `${head} — ${detail}`;
}

/**
 * Render a block of metric pairs as two-space-indented `Key: value` lines.
 * Values are emitted verbatim (e.g. `n/a` passes through unchanged).
 *
 * @param {Array<[string, string]>} pairs
 * @returns {string} newline-joined indented metric lines ('' for an empty list)
 */
function metricBlock(pairs = []) {
  return pairs.map(([key, value]) => `  ${key}: ${value}`).join('\n');
}

module.exports = { statusLine, metricBlock };
