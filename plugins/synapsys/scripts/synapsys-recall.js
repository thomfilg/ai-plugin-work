'use strict';

const os = require('node:os');

const sessionCache = require('../lib/session-cache.js');

const EMPTY_MESSAGE = 'no auto-recall this session';

/**
 * Render a human-readable status report from a session-cache record.
 *
 * The record shape is `{ queries: [{ query, projectId, results, ranAt }] }`
 * as written by `scripts/synapsys-cortex-recall-bg.js`. Each query record
 * renders one line showing its query string and result count. When the
 * cache is absent or holds no queries, a single empty-state line is shown.
 *
 * @param {{ queries?: Array<{query: string, results?: unknown[]}> }|null|undefined} cache
 * @returns {string}
 */
function renderStatus(cache) {
  const queries = cache && Array.isArray(cache.queries) ? cache.queries : [];
  if (queries.length === 0) {
    return EMPTY_MESSAGE;
  }
  return queries
    .map((q) => {
      const count = Array.isArray(q.results) ? q.results.length : 0;
      const label = count === 1 ? 'result' : 'results';
      return `- ${q.query} → ${count} ${label}`;
    })
    .join('\n');
}

/**
 * Resolve the active session id the same way the hook does: prefer the
 * provided session id, else fall back to the parent process id.
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {string}
 */
function resolveSessionId({ env = process.env } = {}) {
  return env.CLAUDE_SESSION_ID || String(process.ppid);
}

/**
 * CLI entry: read the active session cache and print the status report.
 *
 * @param {{ home?: string, env?: NodeJS.ProcessEnv, log?: (s: string) => void }} [opts]
 */
function main({ home = os.homedir(), env = process.env, log = console.log } = {}) {
  const sessionId = resolveSessionId({ env });
  const cache = sessionCache.read(sessionId, { home });
  log(renderStatus(cache));
}

module.exports = { renderStatus, main, resolveSessionId };

if (require.main === module) {
  main();
}
