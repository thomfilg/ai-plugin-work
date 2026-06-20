'use strict';

/**
 * Pretool-overlap scoring (Task 6 / AC-G5).
 *
 * Split out of `scripts/synapsys-lint.js` (GH-534) for file-size and per-
 * function complexity caps. Public surface:
 *   - expandArgSamples(argSrc)
 *   - scoreToolOverlap(aSet, bSet)
 *   - computePretoolPairs(memories, onlyInvolving, applyIntentionalDowngrades)
 */

const { pretoolArgSets } = require('../shared/trigger-tokens');

const SAMPLE_CAP = 16;

/**
 * Parse an arg-source into a sequence of `{kind:'literal'|'alt'}` parts. Used
 * by `expandArgSamples` to keep that function under the complexity cap.
 */
function parseArgParts(base) {
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
  return parts;
}

/**
 * Expand `samples` by one alternation group, respecting the SAMPLE_CAP. Pulled
 * out of `expandArgSamples` to reduce its nesting depth (was 5, max 4).
 */
function expandAlt(samples, options) {
  const next = [];
  for (const s of samples) {
    if (appendOptions(next, s, options)) break;
  }
  return next;
}

/**
 * Append `s + opt` for each option to `next`. Returns true when SAMPLE_CAP
 * is reached so the caller can break early.
 */
function appendOptions(next, s, options) {
  for (const opt of options) {
    next.push(s + opt);
    if (next.length >= SAMPLE_CAP) return true;
  }
  return false;
}

/**
 * Generate a small set of concrete sample strings for a `trigger_pretool`
 * arg-regex source. Replaces common whitespace metas (`\s+`, `\s*`, `\s`) with
 * a single space and expands every `(a|b|c)` alternation as a cross-product
 * over literal alternatives. Non-literal alternatives (e.g. nested groups,
 * character classes) fall back to the raw source — sample generation is
 * best-effort; pair scoring still works as a string literal compare.
 *
 * Returns an empty array on malformed input. Caps the expansion at 16 samples
 * to keep the matrix bounded.
 */
function expandArgSamples(argSrc) {
  if (typeof argSrc !== 'string' || argSrc.length === 0) return [];
  const base = argSrc.replace(/\\s[+*]?/g, ' ');
  const parts = parseArgParts(base);
  let samples = [''];
  for (const part of parts) {
    if (part.kind === 'literal') {
      samples = samples.map((s) => s + part.text);
    } else {
      samples = expandAlt(samples, part.options);
    }
  }
  return samples;
}

/**
 * Compile an arg-regex source into a RegExp. Returns null on parse error
 * (memory is skipped — fail-closed).
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
 * True iff some pair (x ∈ aArgs, y ∈ bArgs) has a non-empty semantic
 * intersection. Extracted so `scoreToolOverlap` stays under the complexity
 * cap.
 */
function hasArgsIntersection(aArgs, bArgs) {
  for (const x of aArgs) {
    for (const y of bArgs) {
      if (argsIntersect(x, y)) return true;
    }
  }
  return false;
}

/**
 * Textual Jaccard over two arg-source Sets. Used as the deterministic-
 * ordering score for pretool pairs.
 */
function textualJaccard(aSet, bSet) {
  let interCount = 0;
  for (const x of aSet) if (bSet.has(x)) interCount++;
  const union = aSet.size + bSet.size - interCount;
  return union === 0 ? 0 : interCount / union;
}

/**
 * Score a single-tool arg-regex Set pair (A vs B).
 *
 * Returns `null` when the two sets have no semantic intersection (no pair).
 * Otherwise returns `{ baseSeverity, score }` where:
 *   - baseSeverity is `high` when A ⊆ B or B ⊆ A (equal or strict-subset),
 *     `medium` otherwise (non-empty intersection with disjoint extras).
 *   - score is the textual Jaccard of the raw arg-source sets.
 */
function scoreToolOverlap(aSet, bSet) {
  const aArgs = Array.from(aSet);
  const bArgs = Array.from(bSet);
  if (aArgs.length === 0 || bArgs.length === 0) return null;
  if (!hasArgsIntersection(aArgs, bArgs)) return null;

  const aCoveredByB = aArgs.every((x) => bArgs.some((y) => argSubsetOf(x, y)));
  const bCoveredByA = bArgs.every((y) => aArgs.some((x) => argSubsetOf(y, x)));
  const baseSeverity = aCoveredByB || bCoveredByA ? 'high' : 'medium';
  const score = textualJaccard(aSet, bSet);
  return { baseSeverity, score };
}

/**
 * Compute the pretool-overlap pairs for one ordered (i,j) memory pair, across
 * all shared tools. Pushes into `out`. Pulled out of `computePretoolPairs` to
 * keep that loop body under the complexity cap.
 */
function computePairForMemories(a, b, out, applyIntentionalDowngrades) {
  const aByTool = pretoolArgSets(a.triggerPretool || []);
  const bByTool = pretoolArgSets(b.triggerPretool || []);

  for (const tool of Object.keys(aByTool)) {
    const bSet = bByTool[tool];
    if (!bSet) continue;
    const scored = scoreToolOverlap(aByTool[tool], bSet);
    if (!scored) continue;
    const downgraded = applyIntentionalDowngrades(a, b, scored.baseSeverity);
    out.push({
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

/**
 * computePretoolPairs — Task 6 (AC-G5).
 *
 * For each `(i<j)` memory pair, group their `trigger_pretool` entries by tool
 * name and, for each shared tool, intersect the arg-regex source sets.
 * Severity policy (spec §Architecture):
 *   - equal sets OR strict-subset → high
 *   - non-empty intersection with disjoint extras on both sides → medium
 *   - empty intersection → not reported
 * Domain + `[[link]]` downgrades are applied via the caller-supplied helper.
 */
function computePretoolPairs(memories, onlyInvolving, applyIntentionalDowngrades) {
  const { forEachPair } = require('./domain-utils');
  const pairs = [];
  forEachPair(memories, onlyInvolving, (a, b) => {
    computePairForMemories(a, b, pairs, applyIntentionalDowngrades);
  });
  return pairs;
}

module.exports = {
  expandArgSamples,
  compileArgRegex,
  argSubsetOf,
  argsIntersect,
  scoreToolOverlap,
  computePretoolPairs,
};
