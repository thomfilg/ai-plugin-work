'use strict';

/**
 * validate.js — startup env validation (warnings only, never blocking).
 *
 * Two checks over a merged schema (see schema.js#mergeSchemas):
 *   1. Unknown keys — env vars matching a declared prefix that no plugin
 *      declares. Likely typos: a Levenshtein-≤2 neighbor is suggested.
 *   2. Invalid values — set vars whose literal value fails the declared
 *      type (bool01, boolean, enum, number, json).
 */

const MAX_SUGGEST_DISTANCE = 2;

/** Levenshtein distance with an early bail once `limit` is exceeded. */
function levenshtein(a, b, limit = MAX_SUGGEST_DISTANCE) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_v, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > limit) return limit + 1;
    prev = curr;
  }
  return prev[b.length];
}

function nearestKnownKey(name, knownKeys) {
  let best = null;
  let bestDist = MAX_SUGGEST_DISTANCE + 1;
  for (const known of knownKeys) {
    const dist = levenshtein(name, known);
    if (dist < bestDist) {
      bestDist = dist;
      best = known;
    }
  }
  return bestDist <= MAX_SUGGEST_DISTANCE ? best : null;
}

/**
 * Scan env values for likely typos. Two detection paths:
 *   - exact-prefix: undeclared names carrying a declared prefix (any source);
 *   - fuzzy: names within edit-distance 2 of a declared var — catches typos
 *     inside the prefix itself (e.g. ENABEL_DRAFT_PR), but ONLY for values
 *     sourced from config files. Process-env names skip the fuzzy path:
 *     unrelated session vars would otherwise collide with declared names.
 *
 * Accepts the readValues() map ({ NAME: { source } }) or a plain array of
 * names (treated as file-sourced).
 * Returns [{ name, suggestion }] — suggestion may be null.
 */
function findUnknownKeys(merged, envValues) {
  const entries = Array.isArray(envValues)
    ? envValues.map((name) => [name, { source: 'env-file' }])
    : Object.entries(envValues);
  const known = new Set([...Object.keys(merged.vars), ...merged.internal]);
  const knownKeys = [...known];
  const unknown = [];
  for (const [name, entry] of entries) {
    if (known.has(name)) continue;
    const fromFile = entry.source !== 'process';
    const suggestion = fromFile ? nearestKnownKey(name, knownKeys) : null;
    if (suggestion || merged.prefixes.some((prefix) => name.startsWith(prefix))) {
      unknown.push({ name, suggestion });
    }
  }
  return unknown;
}

const TYPE_CHECKS = {
  bool01: (value) => (value === '0' || value === '1' ? null : '0 or 1'),
  boolean: (value) => (['true', 'false'].includes(value.toLowerCase()) ? null : 'true or false'),
  number: (value) => (/^-?\d+(\.\d+)?$/.test(value) ? null : 'a number'),
  enum: (value, def) => (def.values.includes(value) ? null : `one of: ${def.values.join(', ')}`),
  json: (value) => {
    try {
      JSON.parse(value);
      return null;
    } catch {
      return 'valid JSON';
    }
  },
};

/**
 * Check every set, statically-known value against its declared type.
 * Returns [{ name, value, expected }].
 */
function validateValues(merged, values) {
  const warnings = [];
  for (const [name, def] of Object.entries(merged.vars)) {
    const entry = values[name];
    if (!entry || entry.dynamic || entry.value === '') continue;
    const check = TYPE_CHECKS[def.type];
    if (!check) continue;
    const expected = check(entry.value, def);
    if (expected) warnings.push({ name, value: entry.value, expected });
  }
  return warnings;
}

module.exports = { levenshtein, findUnknownKeys, validateValues };
