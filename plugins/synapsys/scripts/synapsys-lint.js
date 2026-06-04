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

const path = require('node:path');
const { setupCli, listMemories } = require('../lib/script-bootstrap');
const {
  extractAlternationTokens,
  jaccard,
  triggerMatchesBody,
  pretoolArgSets,
} = require('../lib/shared/trigger-tokens');
const { STOP_WORDS } = require('../lib/lint-stopwords');

// Named exit-code constants — single source of truth.
const EXIT_OK = 0;
const EXIT_HIGH_SEVERITY = 1;
const EXIT_INVALID_ARGS = 2;

const VALID_SCOPES = new Set(['project', 'shared', 'all']);

// Severity-threshold constants (Task 4 — single source of truth).
const DEFAULT_OVERLAP_HIGH = 0.5; // ≥ → high (cross-domain) / medium (unknown)
const OVERLAP_REPORT_FLOOR = 0.25; // < → not reported as a trigger-overlap pair

// Body-density thresholds (Task 5 / spec §Architecture):
//   matchCount >= bodyDensityHigh   → high
//   matchCount >= BODY_DENSITY_FLOOR (and < high) → medium
//   matchCount <  BODY_DENSITY_FLOOR → not reported (noise)
const DEFAULT_BODY_DENSITY_HIGH = 4;
const BODY_DENSITY_FLOOR = 2;

// `[[link]]` regex — anchored to `[a-z0-9][a-z0-9-]*` per spec §Data Model.
const LINK_RE = /\[\[([a-z0-9][a-z0-9-]*)\]\]/g;

// Task 7: too-broad-trigger thresholds.
// A trigger is "too broad" when it is a single alternation group whose tokens
// are all ≤ TOO_BROAD_MAX_TOKEN_LEN chars OR all entirely STOP_WORDS.
const TOO_BROAD_MAX_TOKEN_LEN = 4;

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
 * `listMemories(cwd)`. When `boundDir` is provided, only memories whose
 * store directory is at-or-below that directory are kept — this confines
 * `--cwd=<fixture>` invocations to the requested subtree so that
 * `memory-store.findAncestorStore` (which walks toward the filesystem root)
 * cannot leak the author's real worktree-tier memories into a test fixture
 * run.
 */
function filterMemories(memories, scope, boundDir) {
  const normalizedBound = boundDir ? path.resolve(boundDir) + path.sep : null;
  return memories.filter((m) => {
    if (m.disabled) return false;
    if (m.expired) return false;
    const kind = m.store && m.store.kind;
    if (normalizedBound && kind !== 'shared') {
      const storeDir = path.resolve(m.store.dir) + path.sep;
      // Keep memories whose store is at-or-below the bound directory. The
      // `shared` tier lives outside the project tree by design and is
      // governed by the scope flag, not the bound.
      if (!storeDir.startsWith(normalizedBound)) return false;
    }
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
 * applyIntentionalDowngrades — shared severity cap used by both the
 * trigger×trigger (Task 4) and trigger×body (Task 5) classifiers. If both
 * memories share a non-empty `meta.domain`, severity is capped at `low`
 * and the returned `intentional.domain` records the shared domain. If
 * either body `[[link]]`-references the other, severity is again capped
 * at `low` and `intentional.link` is set.
 */
function applyIntentionalDowngrades(a, b, severity) {
  const aDomain = getDomain(a);
  const bDomain = getDomain(b);
  const sameDomain = aDomain && bDomain && aDomain === bDomain;
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
  const eitherDomainKnown = !!(aDomain || bDomain);

  let severity;
  if (score >= overlapThreshold) {
    severity = eitherDomainKnown ? 'high' : 'medium';
  } else {
    // 0.25 <= score < overlapThreshold
    severity = eitherDomainKnown ? 'medium' : 'low';
  }

  return applyIntentionalDowngrades(a, b, severity);
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
 * classifyBodyPair — severity for trigger×body match-density (Task 5).
 *
 * Severity policy (spec §Architecture):
 *   - matchCount >= bodyDensityHigh  → high
 *   - matchCount >= BODY_DENSITY_FLOOR (and < high) → medium
 *   - matchCount <  BODY_DENSITY_FLOOR → null (not reported as a pair)
 *
 * Domain + `[[link]]` downgrades from Task 4 apply identically here.
 */
function classifyBodyPair(a, b, matchCount, bodyDensityHigh) {
  if (matchCount < BODY_DENSITY_FLOOR) return { severity: null, intentional: {} };
  const severity = matchCount >= bodyDensityHigh ? 'high' : 'medium';
  return applyIntentionalDowngrades(a, b, severity);
}

/**
 * Build the trigger-body-overlap pair array.
 *
 * For each ordered pair (A → B) (both directions), evaluate whether B's
 * `trigger_prompt` regex matches inside A's body. A matchCount >= floor
 * surfaces as a pair carrying `matchedTokens` for downstream suggestion
 * generation (Task 8).
 */
function computeBodyPairs(memories, bodyDensityHigh, onlyInvolving) {
  const pairs = [];
  for (let i = 0; i < memories.length; i++) {
    for (let j = 0; j < memories.length; j++) {
      if (i === j) continue;
      const a = memories[i];
      const b = memories[j];
      if (onlyInvolving && a.name !== onlyInvolving && b.name !== onlyInvolving) continue;

      const { matchCount, matchedTokens } = triggerMatchesBody(
        b.triggerPrompt || '',
        a.body || ''
      );
      const { severity, intentional } = classifyBodyPair(
        a,
        b,
        matchCount,
        bodyDensityHigh
      );
      if (severity === null) continue;

      pairs.push({
        rule: 'trigger-body-overlap',
        a: a.name,
        b: b.name,
        severity,
        score: matchCount,
        matchedTokens,
        intentional,
      });
    }
  }
  return pairs;
}

/**
 * Generate a small set of concrete sample strings for a `trigger_pretool`
 * arg-regex source. Replaces common whitespace metas (`\s+`, `\s*`, `\s`) with
 * a single space and expands every `(a|b|c)` alternation as a cross-product
 * over literal alternatives. Non-literal alternatives (e.g. nested groups,
 * character classes) cause that alternation to fall back to the raw source
 * (sample generation is best-effort — pair scoring still works because the
 * fallback compares as a string literal).
 *
 * Returns an empty array on malformed input. Caps the expansion at 16 samples
 * to keep the matrix bounded.
 *
 * @param {string} argSrc
 * @returns {string[]}
 */
function expandArgSamples(argSrc) {
  if (typeof argSrc !== 'string' || argSrc.length === 0) return [];
  // Normalize whitespace metas to a single space so the sample matches itself.
  let base = argSrc.replace(/\\s[+*]?/g, ' ');
  // Split base into a sequence of literal chunks and alternation groups.
  const groupRe = /\(([^()]+)\)/g;
  const parts = [];
  let last = 0;
  let m;
  while ((m = groupRe.exec(base)) !== null) {
    if (m.index > last) parts.push({ kind: 'literal', text: base.slice(last, m.index) });
    const inner = m[1];
    if (inner.includes('|') && /^[A-Za-z0-9_| -]+$/.test(inner)) {
      parts.push({ kind: 'alt', options: inner.split('|') });
    } else {
      parts.push({ kind: 'literal', text: m[0] });
    }
    last = groupRe.lastIndex;
  }
  if (last < base.length) parts.push({ kind: 'literal', text: base.slice(last) });

  // Cross-product expansion, capped at 16 samples.
  let samples = [''];
  for (const part of parts) {
    if (part.kind === 'literal') {
      samples = samples.map((s) => s + part.text);
    } else {
      const next = [];
      for (const s of samples) {
        for (const opt of part.options) {
          next.push(s + opt);
          if (next.length >= 16) break;
        }
        if (next.length >= 16) break;
      }
      samples = next;
    }
  }
  return samples;
}

/**
 * Compile an arg-regex source into a RegExp, anchored as a substring matcher.
 * Returns null on parse error (memory is skipped — fail-closed).
 */
function compileArgRegex(argSrc) {
  try {
    return new RegExp(argSrc);
  } catch (_) {
    return null;
  }
}

/**
 * True when every sample of `subSrc` is matched by `superSrc`'s compiled
 * regex. Used to decide strict-subset / equal containment for severity.
 */
function argSubsetOf(subSrc, superSrc) {
  const samples = expandArgSamples(subSrc);
  if (samples.length === 0) return false;
  const re = compileArgRegex(superSrc);
  if (!re) return false;
  return samples.every((s) => re.test(s));
}

/**
 * True when at least one sample of either arg-regex is matched by the other.
 */
function argsIntersect(aSrc, bSrc) {
  const aSamples = expandArgSamples(aSrc);
  const bSamples = expandArgSamples(bSrc);
  const aRe = compileArgRegex(aSrc);
  const bRe = compileArgRegex(bSrc);
  if (!aRe || !bRe) return false;
  return aSamples.some((s) => bRe.test(s)) || bSamples.some((s) => aRe.test(s));
}

/**
 * Score a single-tool arg-regex Set pair (A vs B).
 *
 * Returns `null` when the two sets have no semantic intersection (no pair).
 * Otherwise returns `{ baseSeverity, score }` where:
 *   - baseSeverity is `high` when A ⊆ B or B ⊆ A (equal or strict-subset),
 *     `medium` otherwise (non-empty intersection with disjoint extras).
 *   - score is the textual Jaccard of the raw arg-source sets, useful for
 *     deterministic ordering and downstream suggestion generation.
 *
 * @param {Set<string>} aSet
 * @param {Set<string>} bSet
 * @returns {{baseSeverity:'high'|'medium', score:number} | null}
 */
function scoreToolOverlap(aSet, bSet) {
  const aArgs = Array.from(aSet);
  const bArgs = Array.from(bSet);
  if (aArgs.length === 0 || bArgs.length === 0) return null;

  let hasIntersection = false;
  for (const x of aArgs) {
    for (const y of bArgs) {
      if (argsIntersect(x, y)) { hasIntersection = true; break; }
    }
    if (hasIntersection) break;
  }
  if (!hasIntersection) return null;

  const aCoveredByB = aArgs.every((x) => bArgs.some((y) => argSubsetOf(x, y)));
  const bCoveredByA = bArgs.every((y) => aArgs.some((x) => argSubsetOf(y, x)));
  const baseSeverity = aCoveredByB || bCoveredByA ? 'high' : 'medium';

  let interCount = 0;
  for (const x of aSet) if (bSet.has(x)) interCount++;
  const union = aSet.size + bSet.size - interCount;
  const score = union === 0 ? 0 : interCount / union;

  return { baseSeverity, score };
}

/**
 * computePretoolPairs — Task 6 (AC-G5).
 *
 * For each `(i<j)` memory pair, group their `trigger_pretool` entries by tool
 * name (via `pretoolArgSets`) and, for each shared tool, intersect the
 * arg-regex source sets. Severity policy (spec §Architecture):
 *   - equal sets OR strict-subset (one fully contained in the other) → high
 *   - non-empty intersection with disjoint extras on both sides     → medium
 *   - empty intersection                                            → not reported
 * Domain + `[[link]]` downgrades from Task 4 apply.
 */
function computePretoolPairs(memories, onlyInvolving) {
  const pairs = [];
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const a = memories[i];
      const b = memories[j];
      if (onlyInvolving && a.name !== onlyInvolving && b.name !== onlyInvolving) continue;

      const aByTool = pretoolArgSets(a.triggerPretool || []);
      const bByTool = pretoolArgSets(b.triggerPretool || []);

      for (const tool of Object.keys(aByTool)) {
        const bSet = bByTool[tool];
        if (!bSet) continue;
        const scored = scoreToolOverlap(aByTool[tool], bSet);
        if (!scored) continue;
        const downgraded = applyIntentionalDowngrades(a, b, scored.baseSeverity);
        pairs.push({
          rule: 'pretool-overlap',
          a: a.name,
          b: b.name,
          tool,
          severity: downgraded.severity,
          score: scored.score,
          intentional: downgraded.intentional,
        });
      }
    }
  }
  return pairs;
}

/**
 * extractGroupTokens — collect lowercased word-ish tokens from every
 * parenthesised group in a regex source, INCLUDING single-token groups
 * (unlike `extractAlternationTokens` which skips them).
 *
 * Used by the too-broad-trigger predicate so that `\b(ci)\b` (one short
 * token, no pipe) still counts as "trivially short" per R7 spec.
 *
 * @param {string} src
 * @returns {string[]}
 */
function extractGroupTokens(src) {
  if (typeof src !== 'string' || src.length === 0) return [];
  const tokens = [];
  const groupRe = /\(([^()]+)\)/g;
  let m;
  while ((m = groupRe.exec(src)) !== null) {
    for (const raw of m[1].split('|')) {
      const t = raw.trim();
      if (/^[A-Za-z0-9_-]+$/.test(t)) tokens.push(t.toLowerCase());
    }
  }
  return tokens;
}

/**
 * isTooBroadTrigger — Task 7 (AC-G4 / R7).
 *
 * Predicate: a `trigger_prompt` is "too broad" when its group-token set
 * is non-empty AND either
 *   (a) every token is ≤ TOO_BROAD_MAX_TOKEN_LEN chars, OR
 *   (b) every token (case-insensitively) is in STOP_WORDS.
 *
 * Returns `{ broad: false }` or `{ broad: true, reason: string }`.
 */
function isTooBroadTrigger(triggerSource) {
  if (typeof triggerSource !== 'string' || triggerSource.length === 0) {
    return { broad: false };
  }
  const tokens = extractGroupTokens(triggerSource);
  if (!tokens || tokens.length === 0) return { broad: false };

  const allShort = tokens.every((t) => t.length <= TOO_BROAD_MAX_TOKEN_LEN);
  if (allShort) {
    return {
      broad: true,
      reason: `all alternation tokens are ≤${TOO_BROAD_MAX_TOKEN_LEN} chars: [${tokens.join(', ')}]`,
    };
  }

  const allStop = tokens.every((t) => STOP_WORDS.has(t));
  if (allStop) {
    return {
      broad: true,
      reason: `all alternation tokens are STOP_WORDS: [${tokens.join(', ')}]`,
    };
  }

  return { broad: false };
}

/**
 * computeBroadTriggers — walk each memory once and surface any with a
 * trivially short / stop-word-only `trigger_prompt`. Per R7, these entries
 * are reported under a distinct rule key (`too-broad-trigger`) and NOT
 * emitted as a pair. Severity is always `medium` (AC-G4: never high).
 */
function computeBroadTriggers(memories, onlyInvolving) {
  const out = [];
  for (const m of memories) {
    if (onlyInvolving && m.name !== onlyInvolving) continue;
    const { broad, reason } = isTooBroadTrigger(m.triggerPrompt || '');
    if (!broad) continue;
    out.push({
      name: m.name,
      rule: 'too-broad-trigger',
      severity: 'medium',
      reason,
    });
  }
  return out;
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
  const bodyDensityHigh =
    typeof thresholds.bodyDensity === 'number'
      ? thresholds.bodyDensity
      : DEFAULT_BODY_DENSITY_HIGH;
  const onlyInvolving = (opts && opts.onlyInvolving) || null;

  // Bind memory discovery to the requested cwd subtree so test fixtures
  // (and explicit `--cwd=<dir>` invocations) cannot inherit worktree-tier
  // memories from a parent directory via `memory-store.findAncestorStore`.
  const memories = filterMemories(listMemories(cwd), scope, cwd);

  const triggerPairs = computeTriggerPairs(memories, overlapThreshold, onlyInvolving);
  const bodyPairs = computeBodyPairs(memories, bodyDensityHigh, onlyInvolving);
  const pretoolPairs = computePretoolPairs(memories, onlyInvolving);
  // Task 7: exclude broad-trigger memories from pairwise reporting (R7).
  const broadTriggers = computeBroadTriggers(memories, onlyInvolving);
  const broadNames = new Set(broadTriggers.map((e) => e.name));
  const pairs = triggerPairs
    .concat(bodyPairs)
    .concat(pretoolPairs)
    .filter((p) => !broadNames.has(p.a) && !broadNames.has(p.b));

  // Task 8: populate suggestion strings (R8) and order by severity desc → score desc (R9).
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

// Severity rank used by the pair comparator.
const SEVERITY_RANK = { high: 3, medium: 2, low: 1 };

/**
 * compareBySeverityThenScore — R9 ordering for the `pairs` array.
 *
 * Sort key: severity descending (high > medium > low), then `score`
 * descending. Stable for the small N typical of a memory store; falls back
 * to (a,b) name tuple as a deterministic tiebreaker.
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

/**
 * pickPairMemories — locate the two memory records matching pair.a / pair.b
 * within the discovered memory list. Returns `{ aMem, bMem }` (either may be
 * null if not found — suggestion generation degrades gracefully).
 */
function pickPairMemories(memories, pair) {
  const byName = new Map(memories.map((m) => [m.name, m]));
  return { aMem: byName.get(pair.a) || null, bMem: byName.get(pair.b) || null };
}

/**
 * generateSuggestion — R8: produce a non-empty advice string that references
 * a literal token from one of the pair's memories.
 *
 * Strategy per rule:
 *   - trigger-body-overlap: name a matchedToken (from the bodyPair record);
 *     suggest tightening the receiving memory's trigger to exclude that
 *     token, or scoping it via context. Pick the first matched token so the
 *     output is deterministic.
 *   - trigger-overlap: compute token-set difference (A's alternation tokens
 *     minus B's, and vice versa) and recommend adding/removing a concrete
 *     token. Falls back to the shared-token intersection when one side is
 *     a strict subset.
 *   - pretool-overlap: name the shared tool + a literal arg-source token.
 */
function generateSuggestion(pair, memories) {
  const { aMem, bMem } = pickPairMemories(memories, pair);

  if (pair.rule === 'trigger-body-overlap') {
    const matched = Array.isArray(pair.matchedTokens) ? pair.matchedTokens : [];
    const token = matched[0];
    if (token) {
      return `Tighten ${pair.b}.trigger_prompt to exclude the literal token \`${token}\` (matched ${pair.score}× in ${pair.a}'s body), or move the body reference into a [[${pair.b}]] link.`;
    }
    return `Tighten ${pair.b}.trigger_prompt — its tokens appear ${pair.score}× inside ${pair.a}'s body.`;
  }

  if (pair.rule === 'trigger-overlap') {
    const aTokens = aMem
      ? new Set(extractAlternationTokens(aMem.triggerPrompt || ''))
      : new Set();
    const bTokens = bMem
      ? new Set(extractAlternationTokens(bMem.triggerPrompt || ''))
      : new Set();
    const aOnly = [...aTokens].filter((t) => !bTokens.has(t));
    const bOnly = [...bTokens].filter((t) => !aTokens.has(t));
    const shared = [...aTokens].filter((t) => bTokens.has(t));
    if (aOnly.length > 0 && bOnly.length === 0 && shared.length > 0) {
      // A is a strict superset → recommend removing a shared token from A.
      return `Remove the token \`${shared[0]}\` from ${pair.a}.trigger_prompt to disambiguate it from ${pair.b}.`;
    }
    if (bOnly.length > 0 && aOnly.length === 0 && shared.length > 0) {
      return `Remove the token \`${shared[0]}\` from ${pair.b}.trigger_prompt to disambiguate it from ${pair.a}.`;
    }
    if (shared.length > 0) {
      const distinctive = aOnly[0] || bOnly[0] || shared[0];
      return `Trigger sets share \`${shared[0]}\` — tighten ${pair.a} or ${pair.b} by anchoring on \`${distinctive}\` (or removing the shared token).`;
    }
    return `Reduce overlap between ${pair.a} and ${pair.b}.trigger_prompt.`;
  }

  if (pair.rule === 'pretool-overlap') {
    const aPretool = (aMem && aMem.triggerPretool) || [];
    const bPretool = (bMem && bMem.triggerPretool) || [];
    function firstArgFor(list, tool) {
      for (const ent of list) {
        if (ent && ent.tool === tool && typeof ent.arg === 'string') return ent.arg;
        if (typeof ent === 'string' && ent.startsWith(`${tool}:`)) return ent.slice(tool.length + 1);
      }
      return null;
    }
    const aArg = firstArgFor(aPretool, pair.tool);
    const bArg = firstArgFor(bPretool, pair.tool);
    const sample = aArg || bArg;
    if (sample) {
      return `Narrow ${pair.a} or ${pair.b}.trigger_pretool[${pair.tool}] — their arg-patterns overlap on \`${sample}\`.`;
    }
    return `Narrow ${pair.a} or ${pair.b}.trigger_pretool[${pair.tool}] to avoid overlap.`;
  }

  return `Reduce overlap between ${pair.a} and ${pair.b}.`;
}

function formatJson(result) {
  return JSON.stringify({
    warnings: result.warnings,
    errors: result.errors,
    pairs: result.pairs,
    broadTriggers: result.broadTriggers,
  });
}

/**
 * formatRate — canonical numeric formatter for human-readable overlap rates.
 * Integer scores (Task-5 body match counts) render as-is; jaccard fractions
 * render to two decimal places. Centralized so `humanCauseLine` and the
 * overlap-rate line in `formatHuman` stay consistent.
 */
function formatRate(score) {
  if (typeof score !== 'number') return String(score);
  return Number.isInteger(score) ? String(score) : score.toFixed(2);
}

/**
 * humanCauseLine — one-line summary of why the pair was flagged. Uses the
 * rule key plus a numeric signal so the cause is self-explanatory.
 */
function humanCauseLine(pair) {
  if (pair.rule === 'trigger-body-overlap') {
    const matched = Array.isArray(pair.matchedTokens) ? pair.matchedTokens.join(', ') : '';
    return `cause: trigger-body-overlap — ${pair.b}'s trigger matched ${pair.score}× in ${pair.a}'s body${matched ? ` (tokens: ${matched})` : ''}`;
  }
  if (pair.rule === 'pretool-overlap') {
    return `cause: pretool-overlap on tool \`${pair.tool}\` (jaccard=${formatRate(pair.score)})`;
  }
  // trigger-overlap (default)
  return `cause: trigger-overlap (jaccard=${formatRate(pair.score)})`;
}

/**
 * formatHuman — AC-G10: for each pair, emit four lines in order:
 *   1. pair header `A ⇄ B`
 *   2. cause line
 *   3. suggestion line
 *   4. overlap rate + `[severity: <tier>]` tag (single line)
 *
 * Broad-trigger entries follow the pair blocks under a separate heading.
 */
function formatHuman(result) {
  const lines = [];
  if (result.pairs.length === 0 && result.broadTriggers.length === 0) {
    lines.push('synapsys-lint: no overlap pairs or broad triggers reported.');
    return lines.join('\n');
  }
  for (const p of result.pairs) {
    lines.push(`${p.a} ⇄ ${p.b}`);
    lines.push(`  ${humanCauseLine(p)}`);
    lines.push(`  suggestion: ${p.suggestion || ''}`);
    lines.push(`  overlap=${formatRate(p.score)} [severity: ${p.severity}]`);
    lines.push('');
  }
  if (result.broadTriggers.length > 0) {
    lines.push('broad triggers:');
    for (const e of result.broadTriggers) {
      lines.push(`  - ${e.name}: ${e.reason} [severity: ${e.severity}]`);
    }
  }
  return lines.join('\n').replace(/\n+$/, '');
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
  // Exit-code constants exported for tests / downstream callers.
  EXIT_OK,
  EXIT_HIGH_SEVERITY,
  EXIT_INVALID_ARGS,
};
