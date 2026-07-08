'use strict';

/**
 * cache-miss.js — pure classifier for ci-triage entries.
 *
 * Decides whether a triage entry warrants a FULL `gh run rerun <run-id>`
 * (no `--failed`) because the downstream job's cache miss was caused by
 * something other than the upstream cache-producer's own failure.
 *
 * Pure function: no I/O, no fs/process require, no side effects.
 *
 * @param {object} entry - A ci-triage.json entry.
 * @param {string} entry.category - Triage category (e.g. "cache-miss", "regression").
 * @param {boolean} [entry.upstreamProducerPassed] - Whether the upstream cache
 *   producer job succeeded (required when category === "cache-miss").
 * @returns {{ needsFullRerun: boolean, reason: string }}
 */
function classifyCacheMiss(entry) {
  const e = entry || {};
  if (e.category !== 'cache-miss') {
    return {
      needsFullRerun: false,
      reason: 'entry is not classified as a cache miss; no full rerun routing applies',
    };
  }
  if (e.upstreamProducerPassed === true) {
    return {
      needsFullRerun: true,
      reason:
        'upstream cache-producer passed; the downstream cache miss is transient — ' +
        'run a full `gh run rerun <run-id>` so the producer reseeds the cache ' +
        'for the dependent jobs (do not use the partial-rerun flag)',
    };
  }
  return {
    needsFullRerun: false,
    reason:
      'upstream cache-producer also failed; rerunning would re-hit the same ' +
      'broken producer — fix the upstream failure before issuing any rerun',
  };
}

module.exports = { classifyCacheMiss };
