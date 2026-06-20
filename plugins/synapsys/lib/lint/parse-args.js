'use strict';

/**
 * Argv flag parsing for synapsys-lint.
 *
 * Split out of `scripts/synapsys-lint.js` (GH-534) to keep the entry-point
 * under the file-size cap and reduce per-function complexity. Pure helpers —
 * no I/O.
 */

const VALID_SCOPES = new Set(['project', 'shared', 'all']);
const DEFAULT_OVERLAP_HIGH = 0.5;
const DEFAULT_BODY_DENSITY = 4;

/**
 * Parse a `--scope=` value. Returns `{ value }` or `{ error }`.
 */
function parseScope(raw) {
  const scope = raw === undefined || raw === true ? 'all' : String(raw);
  if (!VALID_SCOPES.has(scope)) {
    return { error: `invalid --scope=${scope} (expected project|shared|all)` };
  }
  return { value: scope };
}

/**
 * Parse `--overlap-threshold=`. Float in [0,1]. Returns `{ value }` or
 * `{ error }`.
 */
function parseOverlap(raw) {
  if (raw === undefined || raw === true) return { value: DEFAULT_OVERLAP_HIGH };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    return { error: `invalid --overlap-threshold=${raw} (expected float in [0,1])` };
  }
  return { value: n };
}

/**
 * Parse `--body-density-threshold=`. Positive integer. Returns `{ value }`
 * or `{ error }`.
 */
function parseBodyDensity(raw) {
  if (raw === undefined || raw === true) return { value: DEFAULT_BODY_DENSITY };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return { error: `invalid --body-density-threshold=${raw} (expected positive integer)` };
  }
  return { value: n };
}

/**
 * Parse argv flags into a normalized options object. Returns `{ error }` when
 * a flag value is invalid so the CLI can exit with code 2.
 */
function parseArgs(flag) {
  const scopeRes = parseScope(flag('scope'));
  if (scopeRes.error) return { error: scopeRes.error };

  const overlapRes = parseOverlap(flag('overlap-threshold'));
  if (overlapRes.error) return { error: overlapRes.error };

  const bodyRes = parseBodyDensity(flag('body-density-threshold'));
  if (bodyRes.error) return { error: bodyRes.error };

  const onlyInvolvingRaw = flag('only-involving');
  const onlyInvolving =
    onlyInvolvingRaw === undefined || onlyInvolvingRaw === true ? null : String(onlyInvolvingRaw);

  return {
    json: !!flag('json'),
    scope: scopeRes.value,
    thresholds: { overlap: overlapRes.value, bodyDensity: bodyRes.value },
    onlyInvolving,
  };
}

module.exports = { parseArgs };
