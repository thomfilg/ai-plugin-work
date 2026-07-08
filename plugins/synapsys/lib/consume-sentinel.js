'use strict';

/**
 * Single-consume sentinel for Phase 1 cortex auto-recall (GH-519 review:
 * "Baseline cache breaks single consume" / "Late recall injects second
 * prompt"). Phase 1 auto-recall must inject AT MOST ONCE per session — at the
 * first UserPromptSubmit after SessionStart. Without a sentinel, the detached
 * background job finishing AFTER the first consume would write a fresh cache
 * that a later prompt re-injects. On first consume we set a sentinel keyed off
 * the session id; subsequent consumes drop any late-written cache and return
 * nothing. Every helper is fail-open — a fs error degrades to the pre-fix
 * single-delete behavior and never blocks the dispatcher.
 *
 * @module lib/consume-sentinel
 */

/** Derive the sentinel cache key for a session (kept distinct from the data cache). */
function consumedKey(sessionId) {
  return `${sessionId}__consumed`;
}

/** True when this session has already consumed its Phase 1 auto-recall. */
function isConsumed(cache, sessionId, home) {
  try {
    return cache.read(consumedKey(sessionId), { home }) != null;
  } catch {
    return false;
  }
}

/**
 * Atomically mark a session consumed so later prompts / late background writes
 * never re-inject. Uses the cache's atomic create-or-fail `claim` (flag `wx`)
 * — NOT a non-atomic write — so two concurrent first-prompt consumes can't both
 * pass the earlier `isConsumed` check and both inject (low-prob TOCTOU). Returns
 * true when THIS call claimed Phase 1 (proceed to inject), false when a
 * concurrent consume already claimed it (suppress). Fail-open: any fs error
 * other than EEXIST returns true, degrading to the pre-fix single-delete
 * behavior rather than blocking the dispatcher.
 */
function markConsumed(cache, sessionId, home) {
  try {
    return cache.claim(consumedKey(sessionId), { consumedAt: new Date().toISOString() }, { home });
  } catch {
    // Best-effort sentinel — fall back to the pre-fix single-delete behavior.
    return true;
  }
}

/** Derive the READ-ONLY post-consume summary key (kept distinct from the data cache). */
function summaryKey(sessionId) {
  return `${sessionId}__summary`;
}

/**
 * Persist a small READ-ONLY summary of the just-consumed recall so
 * `/synapsys recall` can still report the session's last query + hit counts
 * after the single-consume cache was deleted. Stores ONLY query + count — never
 * the result bodies — so the summary can never be re-injected as recall output.
 * Best-effort: any fs error degrades the status surface to its empty-state line.
 */
function writeSummary(cache, sessionId, home, queries) {
  try {
    cache.write(
      summaryKey(sessionId),
      {
        summary: true,
        consumedAt: new Date().toISOString(),
        queries: (queries || []).map((q) => ({
          query: q.query,
          count: Array.isArray(q.results) ? q.results.length : 0,
        })),
      },
      { home }
    );
  } catch {
    // Best-effort — the status surface falls back to "no auto-recall this session".
  }
}

/** Read the READ-ONLY post-consume summary for a session, or null when absent. */
function readSummary(cache, sessionId, home) {
  try {
    return cache.read(summaryKey(sessionId), { home });
  } catch {
    return null;
  }
}

/** Drop a (possibly late-written) data cache for an already-consumed session. */
function dropStaleCache(cache, sessionId, home) {
  try {
    cache.delete(sessionId, { home });
  } catch {
    // Ignore — best-effort cleanup.
  }
}

module.exports = {
  consumedKey,
  isConsumed,
  markConsumed,
  dropStaleCache,
  summaryKey,
  writeSummary,
  readSummary,
};
