#!/usr/bin/env node
'use strict';

/**
 * synapsys-lint — static trigger overlap audit (GH-534).
 *
 * Task 3 scaffold: argv parsing, store discovery, scope filter,
 * disabled/expired skip, JSON envelope, exit-code wiring.
 *
 * Task 4 adds trigger×trigger scoring: pairwise Jaccard over alternation-token
 * sets, severity classification (≥overlapThreshold → high cross-domain /
 * medium unknown-domain; 0.25–overlapThreshold → medium/low; <0.25 not
 * reported), and domain / `[[link]]` downgrade rules.
 *
 * Programmatic entry point:
 *   const { lintStore } = require('./synapsys-lint');
 *   const result = lintStore({ cwd, scope, thresholds, onlyInvolving });
 */

const { setupCli, listMemories } = require('../lib/script-bootstrap');
const {
  extractAlternationTokens,
  jaccard,
} = require('../lib/shared/trigger-tokens');

// Named exit-code constants — single source of truth.
const EXIT_OK = 0;
const EXIT_HIGH_SEVERITY = 1;
const EXIT_INVALID_ARGS = 2;

const VALID_SCOPES = new Set(['project', 'shared', 'all']);

// Severity-threshold constants (Task 4 — single source of truth).
const DEFAULT_OVERLAP_HIGH = 0.5; // ≥ → high (cross-domain) / medium (unknown)
const OVERLAP_REPORT_FLOOR = 0.25; // < → not reported as a trigger-overlap pair

// `[[link]]` regex — anchored to `[a-z0-9][a-z0-9-]*` per spec §Data Model.
const LINK_RE = /\[\[([a-z0-9][a-z0-9-]*)\]\]/g;

/**
 * Parse argv flags into a normalized options object. Returns `{ error }` when
 * a flag value is invalid so the CLI can exit with code 2.
 */
function parseArgs(flag) {
  const json = !!flag('json');
  const scopeRaw = flag('scope');
  const scope = scopeRaw === undefined || scopeRaw === true ? 'all' : String(scopeRaw);
  if (!VALID_SCOPES.has(scope)) {
    return { error: `invalid --scope=${scope} (expected project|shared|all)` };
  }

  const overlapRaw = flag('overlap-threshold');
  let overlapThreshold = DEFAULT_OVERLAP_HIGH;
  if (overlapRaw !== undefined && overlapRaw !== true) {
    const n = Number(overlapRaw);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      return { error: `invalid --overlap-threshold=${overlapRaw} (expected float in [0,1])` };
    }
    overlapThreshold = n;
  }

  const bodyRaw = flag('body-density-threshold');
  let bodyDensityThreshold = 4;
  if (bodyRaw !== undefined && bodyRaw !== true) {
    const n = Number(bodyRaw);
    if (!Number.isInteger(n) || n < 1) {
      return { error: `invalid --body-density-threshold=${bodyRaw} (expected positive integer)` };
    }
    bodyDensityThreshold = n;
  }

  const onlyInvolvingRaw = flag('only-involving');
  const onlyInvolving =
    onlyInvolvingRaw === undefined || onlyInvolvingRaw === true
      ? null
      : String(onlyInvolvingRaw);

  return {
    json,
    scope,
    thresholds: { overlap: overlapThreshold, bodyDensity: bodyDensityThreshold },
    onlyInvolving,
  };
}

/**
 * Apply scope + disabled/expired filtering to the memory list returned by
 * `listMemories(cwd)`.
 */
function filterMemories(memories, scope) {
  return memories.filter((m) => {
    if (m.disabled) return false;
    if (m.expired) return false;
    const kind = m.store && m.store.kind;
    if (scope === 'shared') return kind === 'shared';
    if (scope === 'project') return kind !== 'shared';
    return true; // scope === 'all'
  });
}

/**
 * Extract a memory's `domain` frontmatter value (R6, owned by GH-513; no-op
 * when absent). Returns a non-empty string or null.
 */
function getDomain(memory) {
  const d = memory && memory.meta && memory.meta.domain;
  if (typeof d !== 'string') return null;
  const trimmed = d.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Extract all `[[link]]` references from a memory body. Returns a Set of
 * referenced names (lowercased per the anchored regex character class).
 */
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

/**
 * True when either memory's body `[[link]]`-references the other by `name`.
 */
function hasMutualLink(a, b) {
  const aLinks = extractLinkRefs(a.body || '');
  const bLinks = extractLinkRefs(b.body || '');
  return aLinks.has(b.name) || bLinks.has(a.name);
}

/**
 * scorePair — compute raw Jaccard overlap of two memories' alternation-token
 * sets. Returns `{ score }` (numeric in [0,1]).
 */
function scorePair(a, b) {
  const aTokens = new Set(extractAlternationTokens(a.triggerPrompt || ''));
  const bTokens = new Set(extractAlternationTokens(b.triggerPrompt || ''));
  const score = jaccard(aTokens, bTokens);
  return { score, aTokens, bTokens };
}

/**
 * classifyPair — apply severity policy + downgrade rules.
 *
 * Severity policy (Task 4 / spec §Architecture):
 *   - score >= overlapThreshold  → `high`  (cross-domain) / `medium` (unknown domain)
 *   - score in [0.25, threshold) → `medium` (cross-domain) / `low` (unknown)
 *   - score <  0.25              → null (not reported)
 *
 * Downgrade rules:
 *   - both memories share a non-empty `meta.domain` → severity capped at `low`,
 *     pair carries `intentional.domain = "<domain>"`.
 *   - either body `[[link]]`-references the other → severity capped at `low`,
 *     pair carries `intentional.link = true`.
 *
 * @returns {{severity: 'high'|'medium'|'low'|null, intentional: object}}
 */
function classifyPair(a, b, score, overlapThreshold) {
  if (score < OVERLAP_REPORT_FLOOR) return { severity: null, intentional: {} };

  const aDomain = getDomain(a);
  const bDomain = getDomain(b);
  const sameDomain = aDomain && bDomain && aDomain === bDomain;
  const eitherDomainKnown = !!(aDomain || bDomain);

  let severity;
  if (score >= overlapThreshold) {
    severity = eitherDomainKnown ? 'high' : 'medium';
  } else {
    // 0.25 <= score < overlapThreshold
    severity = eitherDomainKnown ? 'medium' : 'low';
  }

  const intentional = {};
  if (sameDomain) {
    intentional.domain = aDomain;
    severity = 'low';
  }
  if (hasMutualLink(a, b)) {
    intentional.link = true;
    severity = 'low';
  }

  return { severity, intentional };
}

/**
 * Build the trigger-overlap pair array over all `(i<j)` memory pairs.
 */
function computeTriggerPairs(memories, overlapThreshold, onlyInvolving) {
  const pairs = [];
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const a = memories[i];
      const b = memories[j];
      if (onlyInvolving && a.name !== onlyInvolving && b.name !== onlyInvolving) continue;

      const { score } = scorePair(a, b);
      const { severity, intentional } = classifyPair(a, b, score, overlapThreshold);
      if (severity === null) continue;

      pairs.push({
        rule: 'trigger-overlap',
        a: a.name,
        b: b.name,
        severity,
        score,
        suggestion: null, // populated by Task 8
        intentional,
      });
    }
  }
  return pairs;
}

/**
 * Programmatic entry point.
 *
 * @param {object} opts
 * @param {string} [opts.cwd]
 * @param {'project'|'shared'|'all'} [opts.scope='all']
 * @param {{overlap?:number,bodyDensity?:number}} [opts.thresholds]
 * @param {string|null} [opts.onlyInvolving]
 */
function lintStore(opts) {
  const cwd = (opts && opts.cwd) || process.cwd();
  const scope = (opts && opts.scope) || 'all';
  const thresholds = (opts && opts.thresholds) || {};
  const overlapThreshold =
    typeof thresholds.overlap === 'number' ? thresholds.overlap : DEFAULT_OVERLAP_HIGH;
  const onlyInvolving = (opts && opts.onlyInvolving) || null;

  const memories = filterMemories(listMemories(cwd), scope);

  const pairs = computeTriggerPairs(memories, overlapThreshold, onlyInvolving);
  const broadTriggers = []; // populated by Task 7

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

function formatJson(result) {
  return JSON.stringify({
    warnings: result.warnings,
    errors: result.errors,
    pairs: result.pairs,
    broadTriggers: result.broadTriggers,
  });
}

function formatHuman(result) {
  // Task-3 scaffold stub — Task 8 reimplements with full pair-header layout.
  const lines = [];
  lines.push(`pairs: ${result.pairs.length}`);
  lines.push(`broadTriggers: ${result.broadTriggers.length}`);
  return lines.join('\n');
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
  // Exit-code constants exported for tests / downstream callers.
  EXIT_OK,
  EXIT_HIGH_SEVERITY,
  EXIT_INVALID_ARGS,
};
