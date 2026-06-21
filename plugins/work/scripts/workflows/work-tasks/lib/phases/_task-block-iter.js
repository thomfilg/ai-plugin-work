'use strict';

/**
 * Shared task-block iterator used by draft.js and traceability.js. Splits a
 * tasks.md body on `## Task N` headings and yields `{ num, rest, body }`
 * tuples where `body` has been trimmed of trailing non-task `##` sections.
 */

function iterTaskBlocks(text) {
  const out = [];
  if (!text) return out;
  const parts = text.split(/^##\s+Task\s+(\d+)/m);
  for (let i = 1; i < parts.length; i += 2) {
    const num = parts[i];
    const rest = parts[i + 1] || '';
    const body = rest.replace(/\n## (?!Task\s)\S[\s\S]*$/, '');
    out.push({ num, rest, body });
  }
  return out;
}

module.exports = { iterTaskBlocks };
