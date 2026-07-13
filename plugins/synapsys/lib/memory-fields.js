'use strict';

// Per-field frontmatter normalization for memory files. Extracted from
// memory-store.js so that file stays under the quality gate's max-lines
// budget; memory-store re-exports nothing from here today (all consumers go
// through readMemoryFile), but the helpers keep their original names and
// byte-identical behavior.

const VALID_FIRE_MODES = new Set(['always', 'once', 'occasionally']);
const DEFAULT_FIRE_MODE = 'once';
const DEFAULT_FIRE_CADENCE = 5;

function parseFireMode(raw, memoryName) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_FIRE_MODE;
  const val = String(raw).trim();
  if (VALID_FIRE_MODES.has(val)) return val;
  process.stderr.write(
    `[synapsys] memory "${memoryName}": invalid fire_mode "${val}" — falling back to "${DEFAULT_FIRE_MODE}"\n`
  );
  return DEFAULT_FIRE_MODE;
}

function parseFireCadence(raw, memoryName) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_FIRE_CADENCE;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (Number.isInteger(n) && n > 0) return n;
  process.stderr.write(
    `[synapsys] memory "${memoryName}": invalid fire_cadence "${raw}" — falling back to ${DEFAULT_FIRE_CADENCE}\n`
  );
  return DEFAULT_FIRE_CADENCE;
}

// GH-520: per-memory enforce mode. Anything unknown (typos, booleans, lists)
// normalizes to 'advise' with a stderr warning so existing memories are
// byte-for-byte unaffected and a bad value can never accidentally block.
const VALID_ENFORCE_MODES = new Set(['advise', 'suggest', 'block']);
const DEFAULT_ENFORCE = 'advise';

function parseEnforce(raw, memoryName) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_ENFORCE;
  const val = String(raw).trim();
  if (VALID_ENFORCE_MODES.has(val)) return val;
  process.stderr.write(
    `[synapsys] memory "${memoryName}": invalid enforce "${val}" — falling back to "${DEFAULT_ENFORCE}"\n`
  );
  return DEFAULT_ENFORCE;
}

// Scalar string fields (enforce_classifier / enforce_satisfied_by). Registry
// validation of the classifier name happens at enforcement time
// (hooks/lib/enforce.js) so this parser stays registry-agnostic.
function _enforceScalar(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function _truthy(value) {
  return value === true || value === 'true';
}

// Inject mode is 'full' only when explicitly requested; everything else
// (including missing) falls back to 'summary'. Extracted as a named helper to
// keep readMemoryFile under the complexity gate.
function _parseInject(value) {
  return value === 'full' ? 'full' : 'summary';
}

// Absent OR empty/whitespace-only trigger_posttool_exit means "no exit gate"
// (null) — consistent with the R11 lint rule. A literal 0 / "0" / "zero" is a
// real target and must be preserved (so `|| null` would be wrong — it drops 0).
function _normalizeExitTarget(value) {
  // Only strings and numbers are meaningful exit targets. Any other falsy
  // value (e.g. a bare `trigger_posttool_exit: false` coerced to boolean by
  // the frontmatter parser) is "unset" — but the numeric 0 must survive.
  if (typeof value !== 'string' && typeof value !== 'number' && !value) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  return value;
}

// Coerce a frontmatter signals-list field (cite_signals, behavior_signals)
// to an array of non-empty strings, or `undefined` when the key is absent.
// The frontmatter parser already turns `[a, b]` into a JS array (via
// BRACKET_LIST_KEYS), but a single scalar (e.g. `cite_signals: solo`)
// should still surface as a one-element array so downstream consumers
// don't have to special-case the shape.
//
// Inline scalar form matches the README example `cite_signals: A, B, C`;
// we split on commas so each token is a separate signal rather than a
// single combined string that would never match the assistant response.
// The frontmatter parser surfaces YAML flow lists like `[A]` / `[A, B]`
// as the literal bracketed string when it doesn't recognize the array
// form, so we strip a single matched pair of outer brackets before splitting.
function normalizeSignalsList(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) {
    const filtered = value.map((s) => String(s).trim()).filter(Boolean);
    return filtered.length ? filtered : undefined;
  }
  let scalar = String(value).trim();
  const bracketed = scalar.match(/^\[(.*)\]$/);
  if (bracketed) scalar = bracketed[1];
  const tokens = scalar
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return tokens.length ? tokens : undefined;
}

// Thin wrappers preserved so call sites and any downstream introspection
// keep their semantic name. Both delegate to the shared helper above.
function normalizeCiteSignals(value) {
  return normalizeSignalsList(value);
}

function normalizeBehaviorSignals(value) {
  return normalizeSignalsList(value);
}

// Coerce `meta.telemetry` to a boolean when explicitly set, or `undefined`
// when absent. Consumers treat absent telemetry as enabled (opt-out semantics),
// so we must distinguish "missing" from "explicit false".
function normalizeTelemetry(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'false') return false;
  if (value === 'true') return true;
  return undefined;
}

function parseExpired(value) {
  if (!value) return false;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return false;
  return date.getTime() < Date.now();
}

module.exports = {
  parseFireMode,
  parseFireCadence,
  parseEnforce,
  _enforceScalar,
  _truthy,
  _parseInject,
  _normalizeExitTarget,
  normalizeSignalsList,
  normalizeCiteSignals,
  normalizeBehaviorSignals,
  normalizeTelemetry,
  parseExpired,
};
