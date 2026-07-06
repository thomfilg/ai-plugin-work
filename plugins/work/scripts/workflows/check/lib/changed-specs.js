/**
 * changed-specs.js — scope the E2E reliability sweep to actually-changed spec
 * files (GH-394, echo-5224 / echo-5790).
 *
 * The consuming repo's reliability gate (`--repeat-each`) historically derived
 * CHANGED_SPECS from the *directory pattern* of touched files, sweeping in
 * every unchanged sibling spec and surfacing their pre-existing flakes against
 * the PR. This module computes the strict set instead:
 *
 *   1. `git diff --name-only origin/<BASE>...HEAD` (+ uncommitted changes),
 *      filtered to spec files (*.spec.{js,ts,jsx,tsx}) that still exist.
 *   2. PLUS unchanged specs that import a changed non-spec helper/fixture —
 *      cheap content-based detection via `git grep -lF <helper basename>`
 *      restricted to spec files. Unchanged-but-required specs stay in.
 *
 * The set is exported to the repo's SCRIPT_RUN_AFFECTED_E2E command as
 * CHANGED_SPECS (newline-separated), alongside E2E_PER_SPEC_TIMEOUT_MS so the
 * per-spec time budget is configurable (CHECK_E2E_SPEC_TIMEOUT_MS, default
 * 60000 — the previous hardcoded 30s is too tight under
 * --repeat-each --workers=1, per echo-5224).
 *
 * Skipped siblings (unchanged specs living in the same directories as changed
 * specs) are computed so reports can note what the old heuristic would have
 * swept in.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SPEC_RE = /\.spec\.[jt]sx?$/;
const DEFAULT_SPEC_TIMEOUT_MS = 60000;

function git(cmd, opts = {}) {
  return execSync(cmd, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    ...opts,
  }).trim();
}

/**
 * Resolve the base ref to diff against: BASE_BRANCH env (via origin/), then
 * origin/{main,master,dev}. Returns null when nothing resolvable (report
 * "baseline unavailable" and fall back to unscoped behavior).
 * @param {string} [cwd] - repo to resolve in (defaults to process cwd)
 * @returns {string|null}
 */
function resolveBaseRef(cwd) {
  const opts = cwd ? { cwd } : {};
  const candidates = [];
  if (process.env.BASE_BRANCH) candidates.push(`origin/${process.env.BASE_BRANCH}`);
  candidates.push('origin/main', 'origin/master', 'origin/dev');
  for (const ref of candidates) {
    try {
      git(`git rev-parse --verify --quiet "${ref}"`, opts);
      return ref;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * All files changed vs baseRef (three-dot merge-base diff) plus uncommitted
 * working-tree changes. Deduplicated, repo-relative paths.
 * @param {string} baseRef
 * @param {string} [cwd] - repo to diff in (defaults to process cwd)
 * @returns {string[]}
 */
function changedFiles(baseRef, cwd) {
  const opts = cwd ? { cwd } : {};
  const out = new Set();
  try {
    for (const f of git(`git diff --name-only "${baseRef}...HEAD"`, opts).split('\n')) {
      if (f) out.add(f);
    }
  } catch {
    return [];
  }
  try {
    // Uncommitted (staged + unstaged + untracked) changes count too.
    // NOTE: parse via regex, not fixed slice — the trimmed exec output loses
    // the leading status-column space of the first line.
    for (const line of git('git status --porcelain', opts).split('\n')) {
      const m = line.match(/^\s*[A-Z?!]{1,2}\s+(.+)$/i);
      if (!m) continue;
      const f = m[1].trim();
      if (f) out.add(f.includes(' -> ') ? f.split(' -> ')[1] : f);
    }
  } catch {
    /* best-effort */
  }
  return [...out];
}

/**
 * Specs that import a changed helper — content-based keep for
 * unchanged-but-required siblings. Cheap: one `git grep -lF <basename>` per
 * changed non-spec source file, restricted to spec files.
 * @param {string[]} changedNonSpecs
 * @returns {string[]}
 */
function specsImportingHelpers(changedNonSpecs) {
  const importers = new Set();
  for (const helper of changedNonSpecs) {
    // Only source files can be imported; skip lockfiles, configs, docs.
    if (!/\.[jt]sx?$/.test(helper)) continue;
    const stem = path.basename(helper).replace(/\.[jt]sx?$/, '');
    if (!stem) continue;
    try {
      const hits = git(
        `git grep -lF ${JSON.stringify(stem)} -- "*.spec.ts" "*.spec.js" "*.spec.tsx" "*.spec.jsx"`
      );
      for (const f of hits.split('\n')) {
        if (f) importers.add(f);
      }
    } catch {
      /* no hits — git grep exits 1 */
    }
  }
  return [...importers];
}

/**
 * Compute the scoped spec set.
 * @returns {{
 *   baseRef: string|null,
 *   specs: string[],              // changed specs + unchanged importers of changed helpers
 *   changedSpecs: string[],       // strictly-changed spec files
 *   keptImporters: string[],      // unchanged specs kept because they import a changed helper
 *   skippedSiblings: string[],    // unchanged same-directory siblings the old heuristic would sweep
 * }}
 */
function computeChangedSpecs() {
  const baseRef = resolveBaseRef();
  if (!baseRef) {
    return { baseRef: null, specs: [], changedSpecs: [], keptImporters: [], skippedSiblings: [] };
  }

  const all = changedFiles(baseRef);
  const changedSpecs = all.filter((f) => SPEC_RE.test(f) && fs.existsSync(f));
  const changedNonSpecs = all.filter((f) => !SPEC_RE.test(f));

  const changedSet = new Set(changedSpecs);
  const keptImporters = specsImportingHelpers(changedNonSpecs).filter(
    (f) => !changedSet.has(f) && fs.existsSync(f)
  );

  const specs = [...changedSpecs, ...keptImporters];
  const specSet = new Set(specs);

  // Siblings the old directory-pattern heuristic would have swept in.
  const skippedSiblings = [];
  const seenDirs = new Set();
  for (const spec of changedSpecs) {
    const dir = path.dirname(spec);
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = path.join(dir, entry);
      if (SPEC_RE.test(entry) && !specSet.has(rel)) skippedSiblings.push(rel);
    }
  }

  return { baseRef, specs, changedSpecs, keptImporters, skippedSiblings };
}

/**
 * Env additions for the repo's affected-e2e command: the scoped CHANGED_SPECS
 * list (newline-separated) and the configurable per-spec budget.
 * @param {ReturnType<typeof computeChangedSpecs>} scoped
 * @returns {Object<string,string>}
 */
function buildE2eEnv(scoped) {
  const timeoutMs = parseInt(process.env.CHECK_E2E_SPEC_TIMEOUT_MS, 10) || DEFAULT_SPEC_TIMEOUT_MS;
  const env = { E2E_PER_SPEC_TIMEOUT_MS: String(timeoutMs) };
  if (scoped && scoped.baseRef && scoped.specs.length > 0) {
    env.CHANGED_SPECS = scoped.specs.join('\n');
    env.CHANGED_SPECS_BASE = scoped.baseRef;
  }
  return env;
}

// ─── Impact-aware unit-test selection (echo-5820-3) ─────────────────────────
//
// check's affected-tests tier runs changed-files-only, so an API-contract
// change (e.g. a tRPC procedure rename) passes locally while every consumer
// test that mocks the old contract breaks in full CI. Full impact analysis is
// app-repo-specific; this is the pragmatic one-hop version: test files that
// IMPORT any changed source file (cheap `git grep -lF <basename stem>` across
// the worktree's test files, bounded) are exported to the repo's
// SCRIPT_RUN_AFFECTED_UNIT command as IMPACT_TEST_FILES so the suite can add
// them to its run set. Default ON; CHECK_IMPACT_TESTS=0 disables.

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const SOURCE_FILE_RE = /\.[cm]?[jt]sx?$/;
const TEST_PATHSPECS = [
  '*.test.js',
  '*.test.jsx',
  '*.test.ts',
  '*.test.tsx',
  '*.spec.js',
  '*.spec.jsx',
  '*.spec.ts',
  '*.spec.tsx',
];
// Bound the grep fan-out — beyond this many changed sources the change is
// repo-wide anyway and the full suite is the right tool, not this heuristic.
const MAX_IMPACT_SOURCES = 50;
// Basenames too generic to be a useful import-specifier signal — grepping for
// them would sweep in most of the test suite.
const GENERIC_STEMS = new Set(['index', 'main', 'types', 'constants', 'utils', 'helpers']);

/** Impact selection is ON unless explicitly disabled via CHECK_IMPACT_TESTS=0. */
function impactTestsEnabled() {
  return process.env.CHECK_IMPACT_TESTS !== '0';
}

/**
 * One-hop impact set: test files that reference the basename stem of any
 * changed source file (import specifiers end in the stem, so `git grep -lF`
 * on the stem is a cheap superset of "imports the changed file").
 * Over-inclusion is safe — it only means a few extra tests run.
 *
 * @param {string} [cwd] - worktree to scan (defaults to process cwd)
 * @returns {{
 *   enabled: boolean,
 *   baseRef: string|null,
 *   impactTests: string[],    // test files importing a changed source (not themselves changed)
 *   scannedSources: string[], // changed source files that were grepped
 * }}
 */
function greppableStem(src) {
  const stem = path.basename(src).replace(SOURCE_FILE_RE, '');
  if (!stem || stem.length < 3 || GENERIC_STEMS.has(stem.toLowerCase())) return null;
  return stem;
}

function collectImporters(scannedSources, changedSet, opts) {
  const importers = new Set();
  const pathspecs = TEST_PATHSPECS.map((s) => JSON.stringify(s)).join(' ');
  for (const src of scannedSources) {
    const stem = greppableStem(src);
    if (!stem) continue;
    try {
      const hits = git(`git grep -lF ${JSON.stringify(stem)} -- ${pathspecs}`, opts);
      for (const f of hits.split('\n')) {
        // Already-changed test files are in the affected set by definition.
        if (f && !changedSet.has(f)) importers.add(f);
      }
    } catch {
      /* no hits — git grep exits 1 */
    }
  }
  return importers;
}

function computeImpactTests(cwd) {
  if (!impactTestsEnabled()) {
    return { enabled: false, baseRef: null, impactTests: [], scannedSources: [] };
  }
  const baseRef = resolveBaseRef(cwd);
  if (!baseRef) {
    return { enabled: true, baseRef: null, impactTests: [], scannedSources: [] };
  }

  const all = changedFiles(baseRef, cwd);
  const changedSet = new Set(all);
  const scannedSources = all
    .filter((f) => SOURCE_FILE_RE.test(f) && !TEST_FILE_RE.test(f))
    .slice(0, MAX_IMPACT_SOURCES);

  const importers = collectImporters(scannedSources, changedSet, cwd ? { cwd } : {});
  const impactTests = [...importers].filter((f) => fs.existsSync(cwd ? path.join(cwd, f) : f));
  return { enabled: true, baseRef, impactTests, scannedSources };
}

/**
 * Env additions for the repo's SCRIPT_RUN_AFFECTED_UNIT command. Returns
 * undefined when there is nothing to add (disabled, no base, or empty set),
 * so the suite runs exactly as before.
 * @param {ReturnType<typeof computeImpactTests>} impact
 * @returns {Object<string,string>|undefined}
 */
function buildUnitEnv(impact) {
  if (!impact || !impact.enabled || !impact.baseRef || impact.impactTests.length === 0) {
    return undefined;
  }
  return {
    IMPACT_TEST_FILES: impact.impactTests.join('\n'),
    IMPACT_TEST_FILES_BASE: impact.baseRef,
  };
}

module.exports = {
  SPEC_RE,
  DEFAULT_SPEC_TIMEOUT_MS,
  resolveBaseRef,
  changedFiles,
  specsImportingHelpers,
  computeChangedSpecs,
  buildE2eEnv,
  impactTestsEnabled,
  computeImpactTests,
  buildUnitEnv,
};
