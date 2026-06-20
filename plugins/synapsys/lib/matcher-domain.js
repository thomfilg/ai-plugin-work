'use strict';

/**
 * Domain gate, split out of matcher.js (same self-contained sub-module pattern
 * as matcher-stop.js / matcher-posttool.js) to keep matcher.js under the
 * max-lines quality gate. Pure function — no injected helpers needed.
 */

/**
 * Domain gate (GH-513 R4 / AC2): when `memory.domain` is non-empty AND an
 * `activeDomains` set is supplied AND their intersection is empty, the memory
 * is excluded BEFORE trigger evaluation. Returns true when the memory should
 * be skipped with reason `domain-mismatch`.
 *
 * Fail-open semantics:
 *   - memory.domain empty/missing  -> not gated (backward compat R10/AC1)
 *   - activeDomains undefined/null -> not gated (backward compat R10)
 *
 * @param {object} memory
 * @param {Set<string>|undefined} activeDomains
 * @returns {boolean}
 */
function isDomainMismatch(memory, activeDomains) {
  if (!activeDomains) return false;
  const domains = memory && memory.domain;
  if (!Array.isArray(domains) || domains.length === 0) return false;
  for (const d of domains) {
    if (activeDomains.has(d)) return false;
  }
  return true;
}

module.exports = { isDomainMismatch };
