'use strict';
/**
 * duration.js — shared elapsed formatter for the status bars: renders a
 * millisecond span as `<s>s` / `<m>m <s>s` / `<h>h <m>m`. Used by both the
 * follow-up monitor line and the work bar's on-step timer so the format is
 * identical and defined once.
 */

/**
 * @param {number} ms elapsed milliseconds
 * @returns {string}
 */
function formatDurationMs(ms) {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

module.exports = { formatDurationMs };
