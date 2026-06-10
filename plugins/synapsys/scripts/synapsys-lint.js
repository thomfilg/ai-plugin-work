#!/usr/bin/env node
'use strict';

/**
 * synapsys-lint — static trigger overlap audit (GH-534).
 *
 * Programmatic entry point:
 *   const { lintStore } = require('./synapsys-lint');
 *   const result = lintStore({ cwd, scope, thresholds, onlyInvolving });
 *
 * Implementation is split across `lib/lint/*.js` so this entry point stays
 * under the file-size and per-function complexity caps:
 *   - lib/lint/parse-args.js      — CLI flag parsing
 *   - lib/lint/pair-scoring.js    — Task 4/5 trigger× and body× scoring
 *   - lib/lint/pretool-scoring.js — Task 6 (AC-G5) pretool overlap
 *   - lib/lint/broad-triggers.js  — Task 7 (AC-G4) too-broad rule
 *   - lib/lint/suggestion.js      — R8 advice strings
 *   - lib/lint/formatters.js      — JSON envelope + human renderer
 */

const path = require('node:path');
const { setupCli, listMemories } = require('../lib/script-bootstrap');
const { getDomains, firstShared } = require('../lib/lint/domain-utils');
const { parseArgs } = require('../lib/lint/parse-args');
const {
  scorePair,
  classifyPair: classifyPairRaw,
  computeTriggerPairs: computeTriggerPairsRaw,
  computeBodyPairs: computeBodyPairsRaw,
} = require('../lib/lint/pair-scoring');
const { computePretoolPairs } = require('../lib/lint/pretool-scoring');
const { computeBroadTriggers } = require('../lib/lint/broad-triggers');
const { generateSuggestion } = require('../lib/lint/suggestion');
const { formatJson, formatHuman } = require('../lib/lint/formatters');

// Named exit-code constants — single source of truth.
const EXIT_OK = 0;
const EXIT_HIGH_SEVERITY = 1;
const EXIT_INVALID_ARGS = 2;

const DEFAULT_OVERLAP_HIGH = 0.5;
const DEFAULT_BODY_DENSITY_HIGH = 4;

// `[[link]]` regex — anchored to `[a-z0-9][a-z0-9-]*` per spec §Data Model.
const LINK_RE = /\[\[([a-z0-9][a-z0-9-]*)\]\]/g;

/**
 * Apply scope + disabled/expired filtering to the memory list. When
 * `boundDir` is provided, the clamp only restricts the `worktree` tier —
 * the only tier whose path is discovered via `memory-store.findAncestorStore`
 * (an upward walk that could otherwise leak the author's real ancestor store
 * into a test fixture run). `local` lives at `<cwd>/.claude/...` (always
 * inside cwd), `global` and `shared` live at fixed paths under `$HOME` (which
 * tests isolate via the HOME env var), so clamping those tiers dropped
 * legitimate global/parent-worktree memories from default production runs.
 */
function filterMemories(memories, scope, boundDir) {
  const normalizedBound = boundDir ? path.resolve(boundDir) + path.sep : null;
  return memories.filter((m) => {
    if (m.disabled) return false;
    if (m.expired) return false;
    const kind = m.store && m.store.kind;
    if (normalizedBound && kind === 'worktree') {
      const storeDir = path.resolve(m.store.dir) + path.sep;
      if (!storeDir.startsWith(normalizedBound)) return false;
    }
    if (scope === 'shared') return kind === 'shared';
    if (scope === 'project') return kind !== 'shared';
    return true;
  });
}

function extractLinkRefs(body) {
  if (typeof body !== 'string' || body.length === 0) return new Set();
  const out = new Set();
  const re = new RegExp(LINK_RE.source, 'g');
  let m;
  while ((m = re.exec(body)) !== null) {
    out.add(m[1]);
  }
  return out;
}

function hasMutualLink(a, b) {
  const aLinks = extractLinkRefs(a.body || '');
  const bLinks = extractLinkRefs(b.body || '');
  return aLinks.has(b.name) || bLinks.has(a.name);
}

/**
 * applyIntentionalDowngrades — shared severity cap. Same-domain memories cap
 * at `low` (with `intentional.domain` set); mutual `[[link]]` references also
 * cap at `low` (with `intentional.link = true`).
 */
function applyIntentionalDowngrades(a, b, severity) {
  const aDomains = getDomains(a);
  const bDomains = getDomains(b);
  const shared = firstShared(aDomains, bDomains);
  const intentional = {};
  if (shared) {
    intentional.domain = shared;
    severity = 'low';
  }
  if (hasMutualLink(a, b)) {
    intentional.link = true;
    severity = 'low';
  }
  return { severity, intentional };
}

// Bind `applyIntentionalDowngrades` so callers (incl. exported API) match the
// pre-refactor signatures.
function classifyPair(a, b, score, overlapThreshold) {
  return classifyPairRaw(a, b, score, overlapThreshold, applyIntentionalDowngrades);
}
function computeTriggerPairs(memories, overlapThreshold, onlyInvolving) {
  return computeTriggerPairsRaw(
    memories,
    overlapThreshold,
    onlyInvolving,
    applyIntentionalDowngrades
  );
}
function computeBodyPairs(memories, bodyDensityHigh, onlyInvolving) {
  return computeBodyPairsRaw(memories, bodyDensityHigh, onlyInvolving, applyIntentionalDowngrades);
}

/**
 * Normalize the `opts` bag passed to `lintStore` into concrete values.
 */
function normalizeLintOpts(opts) {
  const o = opts || {};
  const thresholds = o.thresholds || {};
  return {
    cwd: o.cwd || process.cwd(),
    scope: o.scope || 'all',
    overlapThreshold:
      typeof thresholds.overlap === 'number' ? thresholds.overlap : DEFAULT_OVERLAP_HIGH,
    bodyDensityHigh:
      typeof thresholds.bodyDensity === 'number'
        ? thresholds.bodyDensity
        : DEFAULT_BODY_DENSITY_HIGH,
    onlyInvolving: o.onlyInvolving || null,
  };
}

/**
 * Programmatic entry point.
 */
function lintStore(opts) {
  const { cwd, scope, overlapThreshold, bodyDensityHigh, onlyInvolving } = normalizeLintOpts(opts);

  const memories = filterMemories(listMemories(cwd), scope, cwd);

  const triggerPairs = computeTriggerPairs(memories, overlapThreshold, onlyInvolving);
  const bodyPairs = computeBodyPairs(memories, bodyDensityHigh, onlyInvolving);
  const pretoolPairs = computePretoolPairs(memories, onlyInvolving, applyIntentionalDowngrades);
  const broadTriggers = computeBroadTriggers(memories, onlyInvolving);
  const broadNames = new Set(broadTriggers.map((e) => e.name));
  // Drop low/medium pairs whose endpoint is also flagged by `too-broad-trigger`
  // — that pair is noise duplicated by the broad-trigger entry. High-severity
  // pairs are ALWAYS preserved: a real collision involving a too-broad memory
  // must still surface (and trip the exit-code gate), not be masked by the
  // adjacent rule firing.
  const pairs = triggerPairs
    .concat(bodyPairs)
    .concat(pretoolPairs)
    .filter((p) => p.severity === 'high' || (!broadNames.has(p.a) && !broadNames.has(p.b)));

  for (const p of pairs) {
    p.suggestion = generateSuggestion(p, memories);
  }
  pairs.sort(compareBySeverityThenScore);

  const hasHigh = pairs.some((p) => p.severity === 'high');
  const exitCode = hasHigh ? EXIT_HIGH_SEVERITY : EXIT_OK;

  return {
    pairs,
    broadTriggers,
    warnings: [],
    errors: [],
    memories,
    exitCode,
  };
}

const SEVERITY_RANK = { high: 3, medium: 2, low: 1 };

/**
 * compareBySeverityThenScore — R9 ordering for the `pairs` array. Sort key:
 * severity desc, then `score` desc, then deterministic name+rule tiebreaker.
 */
function compareBySeverityThenScore(p, q) {
  const ps = SEVERITY_RANK[p.severity] || 0;
  const qs = SEVERITY_RANK[q.severity] || 0;
  if (ps !== qs) return qs - ps;
  const pScore = typeof p.score === 'number' ? p.score : 0;
  const qScore = typeof q.score === 'number' ? q.score : 0;
  if (pScore !== qScore) return qScore - pScore;
  const pKey = `${p.a}|${p.b}|${p.rule}`;
  const qKey = `${q.a}|${q.b}|${q.rule}`;
  if (pKey < qKey) return -1;
  if (pKey > qKey) return 1;
  return 0;
}

function main() {
  const { flag, cwd } = setupCli();
  const parsed = parseArgs(flag);
  if (parsed.error) {
    process.stderr.write(`synapsys-lint: ${parsed.error}\n`);
    process.exit(EXIT_INVALID_ARGS);
  }

  const result = lintStore({
    cwd,
    scope: parsed.scope,
    thresholds: parsed.thresholds,
    onlyInvolving: parsed.onlyInvolving,
  });

  if (parsed.json) {
    process.stdout.write(`${formatJson(result)}\n`);
  } else {
    process.stdout.write(`${formatHuman(result)}\n`);
  }

  process.exit(result.exitCode);
}

if (require.main === module) {
  main();
}

module.exports = {
  lintStore,
  scorePair,
  classifyPair,
  formatHuman,
  formatJson,
  parseArgs,
  generateSuggestion,
  compareBySeverityThenScore,
  EXIT_OK,
  EXIT_HIGH_SEVERITY,
  EXIT_INVALID_ARGS,
};
