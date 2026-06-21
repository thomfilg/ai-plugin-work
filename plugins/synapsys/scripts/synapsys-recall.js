'use strict';

const os = require('node:os');

const sessionCache = require('../lib/session-cache.js');
const injectLedger = require('../lib/inject-ledger.js');
const consumeSentinel = require('../lib/consume-sentinel.js');

const EMPTY_MESSAGE = 'no auto-recall this session';

/**
 * Render a human-readable status report from a session-cache record.
 *
 * Accepts either the live pre-consume record
 * (`{ queries: [{ query, projectId, results, ranAt }] }`, written by
 * `scripts/synapsys-cortex-recall-bg.js`) or the READ-ONLY post-consume summary
 * (`{ summary: true, queries: [{ query, count }] }`, written by
 * `lib/consume-sentinel.writeSummary` when the single-consume cache is deleted).
 * Each query record renders one line showing its query string and result count;
 * the summary form is tagged so the status surface still works after consume.
 * When neither is present (or holds no queries), a single empty-state line shows.
 *
 * @param {{ summary?: boolean, queries?: Array<{query: string, results?: unknown[], count?: number}> }|null|undefined} cache
 * @returns {string}
 */
function renderStatus(cache) {
  const queries = cache && Array.isArray(cache.queries) ? cache.queries : [];
  if (queries.length === 0) {
    return EMPTY_MESSAGE;
  }
  const lines = queries.map((q) => {
    const count = Array.isArray(q.results) ? q.results.length : Number(q.count) || 0;
    const label = count === 1 ? 'result' : 'results';
    return `- ${q.query} → ${count} ${label}`;
  });
  // Tag the post-consume summary so it's clear this recall already injected
  // earlier this session rather than being pending for the next prompt.
  if (cache && cache.summary === true) {
    lines.push('(already injected this session)');
  }
  return lines.join('\n');
}

/**
 * Resolve the active session id through the SAME resolver the hook's cortex
 * cache uses (`injectLedger.resolveSessionId`): env `CLAUDE_CODE_SESSION_ID` →
 * sanitized `payload.session_id` → `.current` → hashed-cwd fallback. Using the
 * identical resolver guarantees `/synapsys recall` reads the cache the hook
 * actually wrote, rather than keying off a divergent id.
 *
 * @param {{ payload?: object }} [opts] optional hook-style payload
 * @returns {string}
 */
function resolveSessionId({ payload = {} } = {}) {
  return injectLedger.resolveSessionId(payload);
}

/**
 * CLI entry: read the active session cache and print the status report.
 *
 * @param {{ home?: string, payload?: object, log?: (s: string) => void }} [opts]
 */
function main({ home = os.homedir(), payload = {}, log = console.log } = {}) {
  const sessionId = resolveSessionId({ payload });
  // Prefer the live pre-consume cache; once the first UserPromptSubmit has
  // single-consumed (and deleted) it, fall back to the READ-ONLY post-consume
  // summary so the status surface still reports this session's recall (GH-519).
  const cache = sessionCache.read(sessionId, { home });
  const record =
    cache && Array.isArray(cache.queries) && cache.queries.length > 0
      ? cache
      : consumeSentinel.readSummary(sessionCache, sessionId, home);
  log(renderStatus(record));
}

module.exports = { renderStatus, main, resolveSessionId };

if (require.main === module) {
  main();
}
