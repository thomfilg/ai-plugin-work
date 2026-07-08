/**
 * verify-gherkin-coverage.js — static Gherkin-to-test coverage verification
 * (GH-274).
 *
 * The spec_gate guarantees scenarios EXIST in spec.md and the 4b scope check
 * guarantees the declared scope matches the diff — but nothing verifies each
 * scenario actually maps to a test. This module closes that gap statically:
 *
 *   1. Parse spec.md scenarios via the existing, well-tested
 *      workflows/work/lib/parse-gherkin.js ({ name, tags, steps } each).
 *   2. Read the TEST files of the ticket's committed diff (worktree/base
 *      resolution reused from lib/gherkin-scope.js) and extract every
 *      `it('...')` / `test('...')` / `describe('...')` description.
 *   3. Fuzzy-match: extract 2-3 significant keywords per scenario name (stop
 *      words dropped, longest-first) and require ALL of them to appear
 *      (case-insensitive) within a single test description.
 *
 * Manual override for legitimately unmatchable names:
 *   <!-- gherkin-covered: scenario name → test-file.js:line -->
 * (a plain `->` arrow is also accepted).
 *
 * Missing spec.md or zero scenarios → { skipped: true } (no noise). Gating
 * (warn vs strict vs off, CHECK_GHERKIN_COVERAGE) lives in steps/gherkin-scope.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const parseGherkin = require(path.join(__dirname, '..', '..', 'work', 'lib', 'parse-gherkin'));
const { resolveBaseRef } = require('./changed-specs');
const { resolveWorktreeRoot, committedChangedFiles, isTestFile } = require('./gherkin-scope');

// ─── Keyword extraction ─────────────────────────────────────────────────────

// Gherkin scenario names are prose; these carry no matching signal.
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'when', 'given',
  'with', 'without', 'for', 'from', 'to', 'of', 'in', 'on', 'at', 'by',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this',
  'that', 'these', 'those', 'as', 'can', 'cannot', 'not', 'no', 'do',
  'does', 'did', 'should', 'shall', 'will', 'would', 'could', 'must',
  'may', 'has', 'have', 'had', 'after', 'before', 'into', 'onto', 'over',
  'under', 'via', 'per', 'all', 'any', 'each', 'only', 'than', 'so',
  'up', 'down', 'out', 'off', 'we', 'i', 'you', 'they', 'them', 'their',
]);

const MAX_KEYWORDS = 3;

/**
 * Extract up to 3 significant keywords from a scenario name: lowercase,
 * tokenize on non-alphanumerics, drop stop words + 1-char noise, dedupe,
 * then keep the longest tokens (longer ≈ more distinctive), preserving the
 * original order among the winners.
 * @param {string} name
 * @returns {string[]} lowercase keywords (may be < 3; empty for all-stop-word names)
 */
function extractKeywords(name) {
  const tokens = String(name || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
  const unique = [...new Set(tokens)];
  if (unique.length <= MAX_KEYWORDS) return unique;
  const winners = new Set(
    [...unique].sort((a, b) => b.length - a.length).slice(0, MAX_KEYWORDS)
  );
  return unique.filter((t) => winners.has(t));
}

// ─── Test description extraction ────────────────────────────────────────────

// it('...') / test("...") / describe(`...`) — including modifiers such as
// it.only / test.skip / describe.each(...)(' — first string arg only.
const TEST_DESC_RE =
  /\b(?:it|test|describe)(?:\s*\.\s*\w+(?:\s*\([^)]*\))?)*\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

/**
 * Extract test/suite descriptions with 1-based line numbers from a test
 * file's source text.
 * @param {string} content
 * @returns {Array<{ description: string, line: number }>}
 */
function extractTestDescriptions(content) {
  const out = [];
  const text = String(content || '');
  TEST_DESC_RE.lastIndex = 0;
  let m;
  while ((m = TEST_DESC_RE.exec(text)) !== null) {
    const line = text.slice(0, m.index).split('\n').length;
    out.push({ description: m[2], line });
  }
  return out;
}

// ─── Manual overrides ───────────────────────────────────────────────────────

const OVERRIDE_RE = /<!--\s*gherkin-covered:\s*(.+?)\s*(?:→|->)\s*(.+?)\s*-->/g;

/**
 * Parse `<!-- gherkin-covered: name → file:line -->` annotations from spec.md
 * (plain `->` also accepted; `:line` optional).
 * @param {string|null|undefined} specText
 * @returns {Map<string, { file: string, line: number|null }>} keyed by lowercased scenario name
 */
function parseCoverageOverrides(specText) {
  const overrides = new Map();
  const text = typeof specText === 'string' ? specText : '';
  OVERRIDE_RE.lastIndex = 0;
  let m;
  while ((m = OVERRIDE_RE.exec(text)) !== null) {
    const target = m[2];
    const lineMatch = target.match(/^(.*?):(\d+)$/);
    overrides.set(m[1].toLowerCase(), {
      file: lineMatch ? lineMatch[1] : target,
      line: lineMatch ? Number(lineMatch[2]) : null,
    });
  }
  return overrides;
}

// ─── Matching (pure logic) ──────────────────────────────────────────────────

/**
 * Find the first test description containing ALL keywords (case-insensitive
 * substring match). Empty keyword lists never match — an all-stop-word
 * scenario name must use the manual override, not match everything.
 * @param {string[]} keywords
 * @param {Array<{ file: string, description: string, line: number }>} descriptions
 * @returns {{ file: string, line: number }|null}
 */
function findKeywordMatch(keywords, descriptions) {
  if (keywords.length === 0) return null;
  for (const d of descriptions) {
    const haystack = d.description.toLowerCase();
    if (keywords.every((k) => haystack.includes(k))) {
      return { file: d.file, line: d.line };
    }
  }
  return null;
}

/**
 * Match every scenario against the pooled test descriptions + overrides.
 *
 * @param {object} input
 * @param {Array<{ name: string }>} input.scenarios - from parse-gherkin
 * @param {Array<{ file: string, description: string, line: number }>} input.descriptions
 * @param {Map<string, { file: string, line: number|null }>} [input.overrides]
 * @returns {{
 *   skipped: false, total: number, coveredCount: number, uncoveredCount: number,
 *   results: Array<{ name: string, covered: boolean, keywords: string[],
 *                    file: string|null, line: number|null, via: 'match'|'override'|null }>,
 * }}
 */
function verifyCoverage({ scenarios, descriptions, overrides = new Map() }) {
  const results = scenarios.map((scenario) => {
    const keywords = extractKeywords(scenario.name);
    const override = overrides.get(scenario.name.toLowerCase());
    if (override) {
      return { name: scenario.name, covered: true, keywords, via: 'override', ...override };
    }
    const match = findKeywordMatch(keywords, descriptions);
    return match
      ? { name: scenario.name, covered: true, keywords, via: 'match', ...match }
      : { name: scenario.name, covered: false, keywords, via: null, file: null, line: null };
  });
  const coveredCount = results.filter((r) => r.covered).length;
  return {
    skipped: false,
    total: results.length,
    coveredCount,
    uncoveredCount: results.length - coveredCount,
    results,
  };
}

/**
 * Render the issue's output shape.
 * @param {ReturnType<typeof verifyCoverage>} coverage
 * @returns {string[]} lines
 */
function renderCoverage(coverage) {
  const lines = [`Gherkin Coverage: ${coverage.coveredCount}/${coverage.total} scenarios covered`];
  for (const r of coverage.results) {
    if (r.covered) {
      const loc = r.line != null ? `${r.file}:${r.line}` : r.file;
      lines.push(`✅ ${r.name} → ${loc}${r.via === 'override' ? ' (manual override)' : ''}`);
    } else {
      lines.push(`❌ ${r.name} → NO MATCH FOUND`);
    }
  }
  if (coverage.uncoveredCount > 0) {
    lines.push(`${coverage.uncoveredCount} scenarios missing test coverage.`);
  }
  return lines;
}

// ─── I/O side: gather scenarios + test descriptions for a ticket ────────────

function specScenarios(specText) {
  return parseGherkin.parse(specText).features.flatMap((f) => f.scenarios);
}

/**
 * Read the diff's test files from the worktree and pool their descriptions.
 * Unreadable files (deleted in the diff, binary) are skipped.
 * @param {string} worktree
 * @param {string[]} files - repo-relative changed files
 */
function collectTestDescriptions(worktree, files) {
  const descriptions = [];
  const testFiles = files.filter((f) => isTestFile(f) && /\.[cm]?[jt]sx?$/i.test(f));
  for (const file of testFiles) {
    let content;
    try {
      content = fs.readFileSync(path.join(worktree, file), 'utf8');
    } catch {
      continue;
    }
    for (const d of extractTestDescriptions(content)) descriptions.push({ file, ...d });
  }
  return { descriptions, testFileCount: testFiles.length };
}

const skipResult = (reason) => ({ skipped: true, reason });

/**
 * Full pipeline: parse spec scenarios, resolve the ticket worktree + base
 * (same conventions as gherkin-scope), read the diff's test files, match.
 * Fail-open: any unresolvable git state skips (never blocks).
 *
 * @param {{ specText: string|null, cwd?: string, ticketId?: string }} input
 * @returns {ReturnType<typeof verifyCoverage> & { worktree?: string, testFileCount?: number }
 *           | { skipped: true, reason: string }}
 */
function runGherkinCoverageCheck({ specText, cwd, ticketId }) {
  if (!specText || !specText.trim()) return skipResult('spec.md absent or empty');
  const scenarios = specScenarios(specText);
  if (scenarios.length === 0) return skipResult('no Gherkin scenarios in spec.md');

  const worktree = resolveWorktreeRoot(cwd, ticketId);
  if (!worktree) return skipResult('worktree unresolvable');
  const baseRef = resolveBaseRef(worktree);
  if (!baseRef) return skipResult('base ref unresolvable');

  const files = committedChangedFiles(worktree, baseRef);
  const { descriptions, testFileCount } = collectTestDescriptions(worktree, files);
  const overrides = parseCoverageOverrides(specText);
  return { ...verifyCoverage({ scenarios, descriptions, overrides }), worktree, testFileCount };
}

module.exports = {
  extractKeywords,
  extractTestDescriptions,
  parseCoverageOverrides,
  findKeywordMatch,
  verifyCoverage,
  renderCoverage,
  runGherkinCoverageCheck,
};
