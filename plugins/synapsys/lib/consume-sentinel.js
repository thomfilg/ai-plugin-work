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

/** Mark a session consumed so later prompts / late background writes never re-inject. */
function markConsumed(cache, sessionId, home) {
  try {
    cache.write(consumedKey(sessionId), { consumedAt: new Date().toISOString() }, { home });
  } catch {
    // Best-effort sentinel — fall back to the pre-fix single-delete behavior.
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

module.exports = { consumedKey, isConsumed, markConsumed, dropStaleCache };
