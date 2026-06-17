'use strict';

/**
 * lib/levenshtein.js — pure, zero-dep Levenshtein distance + top-k nearest
 * suggestion helper. Used by the command-existence dispatcher (GH-590) to
 * produce did-you-mean hints when a `pnpm`/`npm`/`yarn` script is missing
 * from the manifest.
 *
 * Pure: no I/O. Zero runtime deps.
 *
 * The optional `cache` parameter on `nearest()` supports the P2.1 pre-compute
 * pattern: the dispatcher computes manifest-script distances once per
 * validation run and hands the resulting `Map<`${needle} ${candidate}`,
 * number>` in so we do not recompute the DP for every miss.
 */

/**
 * Classic two-row dynamic-programming Levenshtein distance.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} edit distance (insertions + deletions + substitutions)
 */
function _min3(a, b, c) {
  const ab = a < b ? a : b;
  return ab < c ? ab : c;
}

function _initRow(n) {
  const row = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) {
    row[j] = j;
  }
  return row;
}

function _fillRow(prev, curr, a, b, i, n) {
  curr[0] = i;
  const ai = a.charCodeAt(i - 1);
  for (let j = 1; j <= n; j += 1) {
    const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
    curr[j] = _min3(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
  }
}

function distance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = _initRow(n);
  let curr = new Array(n + 1);

  for (let i = 1; i <= m; i += 1) {
    _fillRow(prev, curr, a, b, i, n);
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  return prev[n];
}

/**
 * Look up a precomputed distance via the optional cache. Cache keys are
 * `${needle} ${candidate}` (single space separator). Returns the cached
 * number or `null` when the cache is absent or has no entry.
 *
 * @param {Map<string, number> | undefined} cache
 * @param {string} needle
 * @param {string} candidate
 * @returns {number | null}
 */
function lookupCached(cache, needle, candidate) {
  if (!cache || typeof cache.get !== 'function') {
    return null;
  }
  const key = `${needle} ${candidate}`;
  const v = cache.get(key);
  return typeof v === 'number' ? v : null;
}

/**
 * Return the top-k closest strings from `haystack` to `needle`, ordered by
 * ascending edit distance. Ties broken by the candidate's original index in
 * `haystack` (stable). Returns `[]` when the haystack is empty.
 *
 * @param {string} needle
 * @param {string[]} haystack
 * @param {number} [k=3]
 * @param {{ cache?: Map<string, number> }} [opts]
 * @returns {string[]}
 */
function nearest(needle, haystack, k = 3, opts = {}) {
  if (!Array.isArray(haystack) || haystack.length === 0) {
    return [];
  }
  const limit = Math.max(0, Math.min(k, haystack.length));
  if (limit === 0) {
    return [];
  }

  const cache = opts && opts.cache;
  const scored = haystack.map((candidate, index) => {
    const cached = lookupCached(cache, needle, candidate);
    const d = cached !== null ? cached : distance(needle, candidate);
    return { candidate, index, d };
  });

  scored.sort((x, y) => {
    if (x.d !== y.d) {
      return x.d - y.d;
    }
    return x.index - y.index;
  });

  return scored.slice(0, limit).map((s) => s.candidate);
}

module.exports = {
  distance,
  nearest,
};
