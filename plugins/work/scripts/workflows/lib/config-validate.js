'use strict';

/**
 * config-validate.js
 *
 * Pure, non-blocking startup validator for /work configuration. Reads the
 * descriptor map from `config-schema.js` (the single source of truth for known
 * keys + expected value formats) and the `nearest`/`distance` helpers from
 * `levenshtein.js` (for did-you-mean suggestions). Neither dependency is
 * modified; no `config.js` resolution logic is duplicated here.
 *
 * Exports:
 *   validateEnv(env, schema)   → Warning[]   (pure; no I/O, no stderr write)
 *   formatWarnings(warnings)   → string      (grouped block, '' when empty)
 *   runStartupValidation(...)  → void        (writes block once, fail-open)
 *
 * Warning shape:
 *   { kind: 'unknown-key'|'invalid-value', key, value?, suggestion?, expected? }
 */

const { SCHEMA, KNOWN_KEYS, PREFIXES } = require('./config-schema');
const { distance } = require('./levenshtein');

const PREFIX_RE = new RegExp(`^(${PREFIXES.join('|')})`);
const SUGGEST_MAX_DISTANCE = 2;

// ─── Value-format checkers ──────────────────────────────────────────────────
// One predicate + human-readable expectation per supported `type`.

function isParseableJsonArray(value) {
  try {
    return Array.isArray(JSON.parse(value));
  } catch {
    return false;
  }
}

const TYPE_CHECKERS = {
  flag01: {
    valid: (value) => value === '0' || value === '1',
    expected: () => '0 or 1',
  },
  bool: {
    valid: (value) => /^(true|false)$/i.test(String(value)),
    expected: () => 'true or false',
  },
  enum: {
    valid: (value, entry) =>
      Array.isArray(entry.allowed) && entry.allowed.includes(value),
    expected: (entry) =>
      `one of: ${(entry.allowed || []).map((v) => `"${v}"`).join(', ')}`,
  },
  'json-array': {
    valid: (value) => isParseableJsonArray(value),
    expected: () => 'a JSON array',
  },
  string: {
    valid: () => true,
    expected: () => 'any string',
  },
};

/**
 * Validate a single value against its schema entry. Returns an `invalid-value`
 * warning, or `null` when the value is acceptable (or the type is unknown,
 * which we treat as permissive rather than noisy).
 */
function checkValue(key, value, entry) {
  const checker = TYPE_CHECKERS[entry && entry.type];
  if (!checker) return null;
  const typeOk = checker.valid(value, entry);
  const patternOk =
    !(entry.pattern instanceof RegExp) || entry.pattern.test(String(value));
  if (typeOk && patternOk) return null;
  let expected = checker.expected(entry);
  if (!patternOk) {
    expected = `${expected} matching ${entry.pattern}`;
  }
  return { kind: 'invalid-value', key, value, expected };
}

// ─── Scans ──────────────────────────────────────────────────────────────────

/**
 * Collect `unknown-key` warnings for every prefixed env key that is not a known
 * schema key. Attaches a `suggestion` when the nearest known key is within
 * `SUGGEST_MAX_DISTANCE` (R3); omits it entirely otherwise (R4). Non-prefixed
 * keys are ignored (R5).
 */
function scanUnknownKeys(env, knownKeys, knownSet) {
  const warnings = [];
  for (const key of Object.keys(env)) {
    if (knownSet.has(key)) continue;

    // Single-pass nearest scan: track the minimum edit distance while
    // computing each candidate's distance exactly once. The strict `<`
    // comparison keeps the FIRST candidate by index on ties, matching the
    // stable tie-break of the previous `nearest(key, knownKeys, 1)` call, and
    // leaves `best`/`bestDistance` as `undefined`/`Infinity` for empty keys.
    let best;
    let bestDistance = Infinity;
    for (const known of knownKeys) {
      const d = distance(key, known);
      if (d < bestDistance) {
        bestDistance = d;
        best = known;
      }
    }

    // A key is in scope for the unknown-key scan when it carries a known
    // prefix OR is a near miss of a known key (a typo in the prefix itself,
    // e.g. ENABEL_DRAFT_PR → ENABLE_DRAFT_PR, still counts). Keys that neither
    // match a prefix nor land within edit distance of any known key are
    // genuinely foreign and ignored (R5).
    const prefixed = PREFIX_RE.test(key);
    if (!prefixed && bestDistance > SUGGEST_MAX_DISTANCE) continue;

    const warning = { kind: 'unknown-key', key };
    if (bestDistance <= SUGGEST_MAX_DISTANCE) {
      warning.suggestion = best;
    }
    warnings.push(warning);
  }
  return warnings;
}

/**
 * Collect `invalid-value` warnings for every schema key present in `env` whose
 * value fails its declared `type`/`allowed`/`pattern` (R6).
 */
function scanValues(env, schema, knownKeys) {
  const warnings = [];
  for (const key of knownKeys) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) continue;
    const value = env[key];
    if (value === undefined) continue;
    // An empty string is falsy under config.js's uniform `process.env.KEY ||
    // default` resolution, so it is semantically "unset" at runtime and gets
    // replaced by the default. Skip it to avoid spurious invalid-value
    // warnings (matches config.js default semantics exactly).
    if (value === '') continue;
    const warning = checkValue(key, value, schema[key]);
    if (warning) warnings.push(warning);
  }
  return warnings;
}

/**
 * Pure validator. Returns the collected warnings for `env` against `schema`.
 * No I/O, no stderr write.
 *
 * @param {Record<string, string>} [env=process.env]
 * @param {Record<string, object>} [schema=SCHEMA]
 * @returns {Array<object>}
 */
function validateEnv(env = process.env, schema = SCHEMA) {
  const knownKeys = schema === SCHEMA ? KNOWN_KEYS : Object.keys(schema);
  const knownSet = new Set(knownKeys);
  return [
    ...scanUnknownKeys(env, knownKeys, knownSet),
    ...scanValues(env, schema, knownKeys),
  ];
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function renderWarning(w) {
  if (w.kind === 'unknown-key') {
    return w.suggestion
      ? `  - unknown config key "${w.key}" — did you mean "${w.suggestion}"?`
      : `  - unrecognized config key "${w.key}" — not a known /work key (may belong to another tool)`;
  }
  return `  - invalid value for "${w.key}": "${w.value}" — expected ${w.expected}`;
}

/**
 * Render the collected warnings as one grouped block string (R7). Returns `''`
 * for an empty list.
 *
 * @param {Array<object>} warnings
 * @returns {string}
 */
function formatWarnings(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) return '';
  const lines = warnings.map(renderWarning);
  return [
    '[/work] config validation found potential issues (non-blocking):',
    ...lines,
    '',
  ].join('\n');
}

// ─── Startup entry point ────────────────────────────────────────────────────

const MARKER = '__WORK_CONFIG_VALIDATED';
let _validated = false;

/**
 * Run startup validation exactly once per /work invocation. Writes a single
 * grouped block to stderr when there are warnings, nothing otherwise. Strictly
 * non-blocking: never calls `process.exit`, never throws to the caller, exit
 * code unchanged; internal errors are caught and swallowed (fail-open) (R8, R9).
 *
 * @param {Record<string, string>} [env=process.env]
 * @param {Record<string, object>} [schema=SCHEMA]
 * @returns {void}
 */
function runStartupValidation(env = process.env, schema = SCHEMA) {
  try {
    if (_validated || process.env[MARKER]) return;
    _validated = true;
    process.env[MARKER] = '1';

    const block = formatWarnings(validateEnv(env, schema));
    if (block) process.stderr.write(block);
  } catch {
    // Fail-open: swallow any internal error; never disturb the caller.
  }
}

module.exports = { validateEnv, formatWarnings, runStartupValidation };
