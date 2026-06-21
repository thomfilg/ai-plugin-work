'use strict';

// infra-patterns.js — single source of truth for infra-failure detection
// and the staleness threshold used by the follow-up monitor cache.
//
// Pure module: no I/O, no side effects. Consumed by:
//   - monitor.js (writeMonitorResult / clearStaleInfraCache helpers)
//   - follow-up-next.js (state shape only; reads via consumers)
//
// Background: GH-536. When `gh` shells out and fails with an infra-shaped
// error (DNS, auth, transient HTTP 4xx, network reset), the follow-up loop
// previously cached that failure forever and required a manual `--init` to
// recover. This module isolates the detection rules so the auto-clear
// behavior (R2) and the named staleness threshold (R6) live in one place.

/**
 * Regular expressions that identify an infra-shaped failure inside captured
 * `gh` (or generic shell) output. Grouped by category for readability:
 *   - resolve : GitHub-API name-resolution / object-not-found errors
 *   - http    : Transient authn/authz/missing-resource HTTP responses
 *   - network : Low-level Node/libcurl/system network errors
 *
 * Order is not significant — `isInfraFailure` returns true on first match.
 * Adding new patterns is intentional and should be reviewed alongside
 * `__tests__/infra-patterns.test.js` so the verification grep list stays
 * in sync with spec §Verification Checklist (R14).
 *
 * @type {ReadonlyArray<RegExp>}
 */
const INFRA_FAILURE_PATTERNS = Object.freeze([
  // resolve
  /Could not resolve to a Repository/,
  // http (covers 401 Unauthorized, 403 Forbidden, 404 Not Found) — anchored to
  // line-start (with optional leading whitespace) so that test logs asserting
  // on HTTP responses ("FAIL ... returns HTTP 401", "expected status 200, got
  // HTTP 404") are NOT mistaken for gh-CLI transport errors.
  /(^|\n)\s*HTTP 4(01|03|04)\b/,
  // gh CLI surface error wrapping any of the above — anchored to line-start
  // so a stack frame mentioning the phrase mid-line ("at gh command failed
  // handler") is not auto-cleared.
  /(^|\n)gh command failed/,
  // network
  /ENOTFOUND/,
  /ETIMEDOUT/,
  /ECONNRESET/,
]);

/**
 * Number of seconds after which a cached `lastMonitorResult` is considered
 * stale and (when its output matches `INFRA_FAILURE_PATTERNS`) eligible for
 * auto-clear at the top of the monitor step.
 *
 * Per R6 this constant MUST appear in exactly one place; consumers should
 * never inline `60` themselves.
 *
 * Unit: seconds.
 *
 * @type {number}
 */
const STALE_THRESHOLD_SECONDS = 60;

/**
 * Returns true when `output` matches any pattern in `INFRA_FAILURE_PATTERNS`.
 *
 * Null/undefined/empty inputs always return false — a missing output cannot
 * be classified as an infra failure (the caller is responsible for treating
 * "no output" as "not infra" and surfacing it through normal channels).
 *
 * @param {string | null | undefined} output - Captured stderr/stdout from the failing command.
 * @returns {boolean} true iff at least one infra pattern matches the output.
 */
function isInfraFailure(output) {
  if (typeof output !== 'string' || output.length === 0) {
    return false;
  }
  for (const pattern of INFRA_FAILURE_PATTERNS) {
    if (pattern.test(output)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true when the cached `lastMonitorAt` timestamp is older than
 * `STALE_THRESHOLD_SECONDS` relative to `now`, OR when `lastMonitorAt` is
 * null/undefined (R8: legacy state files written before GH-536 lacked the
 * timestamp; treat them as infinitely old so the auto-clear path is reached).
 *
 * Unparseable timestamps are also treated as infinitely old — defensive
 * default that prefers re-execution over indefinitely cached garbage.
 *
 * @param {string | null | undefined} lastMonitorAt - ISO-8601 timestamp or nullish.
 * @param {number} [now=Date.now()] - Reference time in ms since epoch.
 * @returns {boolean} true iff the cache entry is stale (>= threshold) or missing.
 */
function isStale(lastMonitorAt, now = Date.now()) {
  if (lastMonitorAt === null || lastMonitorAt === undefined) {
    return true;
  }
  const parsed = Date.parse(lastMonitorAt);
  if (Number.isNaN(parsed)) {
    // Surface garbage timestamps via stderr so state-file corruption is
    // visible instead of silently auto-clearing the cache forever.
    process.stderr.write(
      `[infra-patterns] WARN: unparseable lastMonitorAt=${JSON.stringify(lastMonitorAt)}; treating as stale\n`
    );
    return true;
  }
  const ageSeconds = (now - parsed) / 1000;
  return ageSeconds >= STALE_THRESHOLD_SECONDS;
}

module.exports = {
  INFRA_FAILURE_PATTERNS,
  STALE_THRESHOLD_SECONDS,
  isInfraFailure,
  isStale,
};
