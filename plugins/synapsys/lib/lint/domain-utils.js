'use strict';

/**
 * Shared domain-tag helpers for the lint pair-classification rules.
 *
 * Memories may declare `domain` as a scalar (`domain: releases`), a YAML
 * flow list (`domain: [a, b]`), or omit it entirely. `memory-store` coerces
 * both shapes into the canonical `memory.domain` array, but raw shapes that
 * skipped the parser surface as a string or array under `memory.meta.domain`.
 * `getDomains` reads both and returns a Set of non-empty trimmed strings.
 */

function addDomainValue(value, out) {
  if (typeof value === 'string') {
    const t = value.trim();
    if (t) out.add(t);
    return;
  }
  if (!Array.isArray(value)) return;
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (t) out.add(t);
  }
}

/** Return a Set of domain tags declared on `memory` (possibly empty). */
function getDomains(memory) {
  const out = new Set();
  if (!memory) return out;
  addDomainValue(memory.domain, out);
  if (out.size === 0) addDomainValue(memory.meta && memory.meta.domain, out);
  return out;
}

/** True when the two sets share at least one element. */
function setsIntersect(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/** First element present in both sets, or null. */
function firstShared(a, b) {
  for (const x of a) if (b.has(x)) return x;
  return null;
}

/**
 * Iterate every unordered `(i<j)` memory pair, skipping pairs that don't
 * touch `onlyInvolving` when that filter is supplied. Centralizes the loop
 * pattern shared across pair-scoring rules.
 */
function forEachPair(memories, onlyInvolving, cb) {
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const a = memories[i];
      const b = memories[j];
      if (onlyInvolving && a.name !== onlyInvolving && b.name !== onlyInvolving) continue;
      cb(a, b);
    }
  }
}

module.exports = { getDomains, setsIntersect, firstShared, forEachPair };
