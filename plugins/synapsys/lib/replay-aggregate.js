'use strict';

/**
 * synapsys-replay — per-memory aggregation + tightening heuristic. Extracted
 * to keep the CLI entrypoint under the 400-line quality cap.
 *
 * Public surface (re-exported by scripts/synapsys-replay.js):
 *   - splitTopLevelAlternation(triggerPrompt)
 *   - fpRate(relevant, irrelevant)
 *   - aggregateReport(tuples, judgments)
 *   - suggestTightening(memory, agg)
 */

// Re-export the runtime matcher's splitTopLevelAlternation so the tightening
// heuristic analyzes the same arms the matcher actually splits at runtime.
// Single source of truth — see plugins/synapsys/lib/matcher.js.
const { splitTopLevelAlternation } = require('./matcher');

/**
 * fp_rate = 1 - relevant / (relevant + irrelevant). judge_failed excluded.
 */
function fpRate(relevant, irrelevant) {
  const denom = relevant + irrelevant;
  if (denom <= 0) return null;
  return 1 - relevant / denom;
}

function newReportEntry() {
  return {
    fires: 0,
    relevant: 0,
    irrelevant: 0,
    judge_failed: 0,
    fp_rate: null,
    sample_matches: [],
    _hasUps: false,
    _hasPtu: false,
  };
}

function recordFire(entry, bucket, t) {
  entry.fires += 1;
  bucket.events.add(t.event);
  if (t.event === 'UserPromptSubmit') entry._hasUps = true;
  if (t.event === 'PreToolUse') entry._hasPtu = true;
  if (t.matched_substring) {
    bucket.subs.set(t.matched_substring, (bucket.subs.get(t.matched_substring) || 0) + 1);
  }
}

function applyJudgmentToEntry(entry, j) {
  if (j && entry._hasUps) {
    entry.relevant = j.relevant || 0;
    entry.irrelevant = j.irrelevant || 0;
    entry.judge_failed = j.judge_failed || 0;
    entry.fp_rate = fpRate(entry.relevant, entry.irrelevant);
  } else {
    // PTU-only memories, and UPS memories that received no judgment
    // (e.g. excluded by --max-judges sampling), are reported as
    // "not judged" rather than "zero relevant".
    entry.relevant = null;
    entry.irrelevant = null;
    entry.fp_rate = null;
  }
}

function topSampleMatches(subs) {
  return Array.from(subs.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([s]) => s);
}

/**
 * Aggregate per-memory metrics from replay tuples + judge results.
 * PTU-only memories report `relevant=null` / `fp_rate=null` (spec §Decision).
 * `sample_matches` is the top-3 most-frequent distinct matched substrings.
 */
function aggregateReport(tuples, judgments) {
  const report = {};
  const fireBuckets = {};
  for (const t of tuples) {
    if (!report[t.memory_name]) {
      report[t.memory_name] = newReportEntry();
      fireBuckets[t.memory_name] = { events: new Set(), subs: new Map() };
    }
    if (t.fired) recordFire(report[t.memory_name], fireBuckets[t.memory_name], t);
  }
  for (const name of Object.keys(report)) {
    const entry = report[name];
    applyJudgmentToEntry(entry, judgments && judgments[name]);
    entry.sample_matches = topSampleMatches(fireBuckets[name].subs);
    delete entry._hasUps;
    delete entry._hasPtu;
  }
  return report;
}

/**
 * Peel a single outermost `\b?(...)\b?` wrapper so heuristic-detection works on
 * realistic triggers like `\b(push|fetch|deploy)\b`. The matcher itself does
 * NOT need this peeling — its `splitTopLevelAlternation` runs against the raw
 * regex — but the tightening heuristic only sees short bare words.
 */
function peelGroupWrapper(source) {
  const m = /^\\b?\((.*)\)\\b?$/s.exec(source);
  if (!m) return source;
  const inner = m[1];
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) return source;
    }
  }
  return depth === 0 ? inner : source;
}

/**
 * Heuristic R8 — emit advisory when `fp_rate > 0.70` AND `trigger_prompt`
 * contains short (<=5 chars) single-word alternation arms. Peels a single
 * `\b(...)\b` wrapper before splitting so wrapped triggers are inspected.
 */
function suggestTightening(memory, agg) {
  if (!memory || !agg) return null;
  if (agg.fp_rate === null || agg.fp_rate === undefined) return null;
  if (!(agg.fp_rate > 0.7)) return null;
  const arms = splitTopLevelAlternation(peelGroupWrapper(memory.triggerPrompt || ''));
  const candidates = arms.filter((a) => {
    const trimmed = a.trim();
    return trimmed.length > 0 && trimmed.length <= 5 && /^[A-Za-z0-9_-]+$/.test(trimmed);
  });
  if (candidates.length === 0) return null;
  return { memory: memory.name, candidates };
}

module.exports = {
  splitTopLevelAlternation,
  fpRate,
  aggregateReport,
  suggestTightening,
};
