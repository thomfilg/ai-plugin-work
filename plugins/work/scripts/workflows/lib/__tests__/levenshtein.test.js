const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// Deferred require — the module may not exist yet in RED. We probe for it
// behaviorally so the failure surface is "wrong answer", not "load error".
const MODULE_PATH = path.join(__dirname, '..', 'levenshtein.js');

function loadModule() {
  if (!fs.existsSync(MODULE_PATH)) {
    return { nearest: () => null, distance: () => null, __missing: true };
  }
  return require(MODULE_PATH);
}

describe('lib/levenshtein.js', () => {
  describe('nearest()', () => {
    it('returns top-3 closest strings by edit distance (typo / 1-edit)', () => {
      const { nearest } = loadModule();
      const haystack = ['dev:check', 'dev:typecheck', 'dev:test', 'build', 'lint'];
      const result = nearest('dev:typcheck', haystack); // 1-edit from dev:typecheck
      assert.ok(Array.isArray(result), 'nearest() must return an array');
      assert.equal(result.length, 3);
      assert.equal(result[0], 'dev:typecheck');
    });

    it('handles transposition (2-edit distance)', () => {
      const { nearest } = loadModule();
      const haystack = ['test', 'build', 'lint', 'format'];
      // 'tset' -> 'test' is a transposition: 2 edits under standard Levenshtein.
      const result = nearest('tset', haystack, 1);
      assert.ok(Array.isArray(result));
      assert.equal(result.length, 1);
      assert.equal(result[0], 'test');
    });

    it('returns [] when haystack is empty', () => {
      const { nearest } = loadModule();
      assert.deepEqual(nearest('anything', []), []);
    });

    it('honors k=1', () => {
      const { nearest } = loadModule();
      const haystack = ['dev:check', 'dev:typecheck', 'dev:test'];
      const result = nearest('dev:typcheck', haystack, 1);
      assert.ok(Array.isArray(result));
      assert.equal(result.length, 1);
      assert.equal(result[0], 'dev:typecheck');
    });

    it('returns the exact match first when the needle exists in haystack', () => {
      const { nearest } = loadModule();
      const haystack = ['build', 'test', 'lint'];
      const result = nearest('test', haystack, 3);
      assert.ok(Array.isArray(result));
      assert.equal(result[0], 'test');
    });

    it('returns fewer than k entries when haystack is smaller than k', () => {
      const { nearest } = loadModule();
      const haystack = ['only'];
      const result = nearest('only', haystack, 3);
      assert.ok(Array.isArray(result));
      assert.equal(result.length, 1);
      assert.equal(result[0], 'only');
    });

    it('is pure — does not mutate the haystack', () => {
      const { nearest } = loadModule();
      const haystack = ['b', 'a', 'c'];
      const snapshot = [...haystack];
      nearest('a', haystack, 3);
      assert.deepEqual(haystack, snapshot);
    });

    it('accepts a precomputed-distance cache and uses it instead of recomputing', () => {
      const { nearest } = loadModule();
      const haystack = ['alpha', 'beta', 'gamma'];
      // Cache shape: Map<`${needle} ${candidate}`, number> — dispatcher will
      // hand this in to reuse a per-validation-run cache (P2.1).
      const cache = new Map();
      cache.set('zzz alpha', 0); // claim 'alpha' has distance 0
      cache.set('zzz beta', 99);
      cache.set('zzz gamma', 99);
      const result = nearest('zzz', haystack, 1, { cache });
      assert.ok(Array.isArray(result));
      assert.equal(result[0], 'alpha');
    });
  });

  describe('distance()', () => {
    it('exports a Levenshtein distance helper (used to populate the cache)', () => {
      const { distance } = loadModule();
      assert.equal(typeof distance, 'function');
      assert.equal(distance('kitten', 'sitting'), 3);
      assert.equal(distance('', ''), 0);
      assert.equal(distance('abc', ''), 3);
      assert.equal(distance('', 'abc'), 3);
    });
  });
});
