'use strict';

/**
 * Phase 1 cache consume for cortex auto-recall.
 *
 * Extracted from `lib/cortex-recall` to keep that orchestrator under the
 * max-lines gate and `consumeCache` under the cyclomatic-complexity gate. The
 * single-consume guard, baseline defer, atomic claim (TOCTOU), and empty-record
 * short-circuit live in `resolveConsumable`, leaving `consumeCache` itself a
 * thin format-then-delete shell. Every entry point is fail-open (R14): a fs
 * error degrades to no injection and never blocks the dispatcher.
 *
 * @module lib/consume-cache
 */

const cache = require('./session-cache');
const sentinel = require('./consume-sentinel');
const { formatBlock } = require('./cortex-format');

// The SessionStart `baseline:true` placeholder consumeCache defers (GH-519).
function isBaselineRecord(record) {
  return record?.baseline === true;
}

/** Read the session cache record, degrading a fs/parse error to null (R14). */
function readRecord(sessionId, home) {
  try {
    return cache.read(sessionId, { home });
  } catch {
    return null;
  }
}

/**
 * Resolve the queries to render for this consume, or null when nothing should
 * inject. Encapsulates the single-consume guard, baseline defer, atomic Phase 1
 * claim (closes the TOCTOU double-inject window), and the empty-record
 * short-circuit so `consumeCache` stays under the complexity gate.
 *
 * @param {string} sessionId
 * @param {string} home
 * @returns {Array|null} the cached query records, or null to inject nothing
 */
function resolveConsumable(sessionId, home) {
  // Single-consume guard: an already-consumed session drops late cache, no inject.
  if (sentinel.isConsumed(cache, sessionId, home)) {
    sentinel.dropStaleCache(cache, sessionId, home);
    return null;
  }
  const record = readRecord(sessionId, home);
  // Defer the baseline placeholder so the real detached write survives (GH-519).
  if (isBaselineRecord(record)) return null;
  // Atomically claim Phase 1 regardless of content so a late write can't
  // re-inject (GH-519). A lost claim means a concurrent consume already injected
  // this turn — drop the cache and inject nothing (closes the TOCTOU window).
  if (!sentinel.markConsumed(cache, sessionId, home)) {
    sentinel.dropStaleCache(cache, sessionId, home);
    return null;
  }
  if (!record || !Array.isArray(record.queries) || record.queries.length === 0) return null;
  return record.queries;
}

// Format the `[cortex:auto-recall]` block from cached records, applying the
// config age/char/result bounds. Returns '' on any failure (R14).
function formatRecallBlock(queries, config) {
  try {
    return formatBlock({
      queries,
      maxAgeDays: config.max_age_days ?? 180,
      maxChars: config.max_chars_per_memory ?? 500,
      maxResults: config.max_results_per_query ?? 5,
    });
  } catch {
    return '';
  }
}

/**
 * Consume the background cache for a session: read the record, format the
 * `[cortex:auto-recall]` block, persist a READ-ONLY post-consume summary,
 * delete the cache file, and set a single-consume sentinel. Returns '' when
 * nothing to consume or when already consumed. Never throws (R14).
 *
 * @param {string} sessionId session identifier
 * @param {{ home: string, config?: { max_age_days?: number, max_chars_per_memory?: number } }} opts
 * @returns {string} the formatted block, or '' when nothing to consume
 */
function consumeCache(sessionId, { home, config = {} } = {}) {
  const queries = resolveConsumable(sessionId, home);
  if (!queries) return '';
  const block = formatRecallBlock(queries, config);
  // Persist a READ-ONLY summary (last query + hit counts, no bodies) BEFORE
  // deleting the data cache so `/synapsys recall` can still report this
  // session's recall after the single-consume delete (GH-519 review).
  sentinel.writeSummary(cache, sessionId, home, queries);
  try {
    cache.delete(sessionId, { home });
  } catch {
    /* best-effort cleanup */
  }
  return block;
}

module.exports = { consumeCache, isBaselineRecord, formatRecallBlock };
