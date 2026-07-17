'use strict';

/**
 * task-verify/observe.js — build one task boundary's observations from
 * reality (GH-755; plan §5.2–5.4). Everything is OBSERVED from the task's
 * commits: the diff, the derived test files (diff ∩ test patterns — the
 * planner declares nothing for gating), the head run, the retroactive
 * fail-on-base run in the base worktree, and (v1: unsupported) coverage.
 *
 * Deliverable semantics v1: concrete scope entries (no glob metacharacters,
 * `(NEW)` marker stripped) are the files the task promises; each must exist
 * at head. Glob entries only bound I1.
 *
 * Mechanism failures anywhere degrade to the corresponding UNVERIFIED-grade
 * observation (`supported: false`) — the engine never converts them into
 * blocks.
 */

const path = require('path');

const { fileMatchesScope, TEST_FILE_EXT_RE } = require(
  path.join(__dirname, '..', 'lib', 'task-scope-globs')
);
const { changedFiles, fileExistsAtRef, resolveRef } = require('./collect/git-facts');
const { ensureBaseWorktree, overlayFiles } = require('./collect/base-worktree');
const { detectRunner, runDerivedTests } = require('./collect/runner');
const { resolveAttribution } = require('./collect/attribution');
const { profileFor } = require('./kind-profiles');

const NEW_MARKER_RE = /\s*\((?:NEW|new)\)\s*$/;
const GLOB_CHARS_RE = /[*?{[]/;

/** Normalize scope entries: strip the `(NEW)` annotation (GH-725 class). */
function normalizeScope(scopeGlobs) {
  return (scopeGlobs || []).map((s) => String(s).replace(NEW_MARKER_RE, '').trim()).filter(Boolean);
}

/** Concrete (non-glob) scope entries are the task's promised deliverables. */
function promisedDeliverables(scopeGlobs) {
  return scopeGlobs.filter((s) => !GLOB_CHARS_RE.test(s));
}

/** Diff-derived test files. */
function deriveTestFiles(files) {
  return files.filter((f) => TEST_FILE_EXT_RE.test(f));
}

/** Assemble the diff observation from an already-resolved file list. */
function diffFromFiles(files, scope) {
  const scopeUnresolved = scope.length === 0;
  return {
    empty: files.length === 0,
    filesChanged: files,
    scopeGlobs: scope,
    outOfScope: scopeUnresolved ? [] : files.filter((f) => !fileMatchesScope(f, scope)),
    ...(scopeUnresolved ? { scopeUnresolved: true } : {}),
  };
}

function buildDiff({ repoDir, baseRef, headRef, scopeGlobs }) {
  const files = changedFiles(repoDir, baseRef, headRef);
  return diffFromFiles(files, normalizeScope(scopeGlobs));
}

/**
 * Resolve the diff for a task, applying attribution when `taskNum` is given.
 *
 * Three rules (spec R8/R9), fail-open throughout:
 *   1. No `Work-Task` trailer anywhere in range (mode 'none') → the legacy
 *      `base..HEAD` diff, unchanged.
 *   2. Foreign-attributed commits present (mode 'trailer') → `filesChanged`
 *      is the union of THIS task's attributed commits ONLY; scope/out-of-scope
 *      recomputed over that set.
 *   3. Collector `supported: false` → legacy diff (never a hard block).
 *
 * Serial callers (no `taskNum`) get the legacy diff and NO `attribution` key,
 * byte-for-byte identical to pre-GH-769 behavior.
 *
 * @returns {{ diff: object, attribution: object|null }}
 */
function resolveDiffWithAttribution({ repoDir, baseRef, headRef, scopeGlobs, taskNum }) {
  const scope = normalizeScope(scopeGlobs);
  if (taskNum === undefined || taskNum === null) {
    return { diff: buildDiff({ repoDir, baseRef, headRef, scopeGlobs }), attribution: null };
  }
  const attribution = resolveAttribution({ repoDir, baseRef, headRef, taskNum });
  // Rule 2 — attributed range with foreign commits: THIS task's files only.
  if (attribution.supported && attribution.mode === 'trailer') {
    return { diff: diffFromFiles(attribution.attributedFiles, scope), attribution };
  }
  // Rules 1 (mode 'none') and 3 (supported:false) — legacy diff kept. When the
  // collector itself could not resolve (supported:false, e.g. an unresolvable
  // base ref), the legacy read is fail-open so a task is never hard-blocked by
  // a broken attribution read (spec R3/R9). The serial path (taskNum omitted,
  // buildDiff) keeps its throw-on-failure semantics unchanged.
  const legacy = attribution.supported ? changedFiles(repoDir, baseRef, headRef) : [];
  return { diff: diffFromFiles(legacy, scope), attribution };
}

function buildDeliverables({ repoDir, headRef, scope }) {
  const promised = promisedDeliverables(scope);
  return {
    promised,
    missing: promised.filter((p) => !fileExistsAtRef(repoDir, headRef, p)),
  };
}

function buildHeadRun({ repoDir, testFiles, profile, runner, timeoutMs }) {
  if (!profile.requiresTests) {
    return {
      attempted: false,
      supported: true,
      outcome: 'not-run',
      testsRan: 0,
      reporterKind: 'none',
    };
  }
  if (testFiles.length === 0) {
    // No test files in the task's diff is NOT the same observation as a real
    // runner reporting 0 tests (GH-749): the task's coverage may live in
    // untouched pre-existing tests. Absence of derived-test evidence flags
    // (no-test-files-in-diff → UNVERIFIED); it never fabricates a "pass".
    return {
      attempted: false,
      supported: true,
      outcome: 'not-run',
      reporterKind: 'none',
      notes: 'no test files derived from the diff',
    };
  }
  return runDerivedTests({ cwd: repoDir, files: testFiles, runner, timeoutMs });
}

function buildBaseRun({
  repoDir,
  baseRef,
  headRef,
  testFiles,
  profile,
  runner,
  baseWorktreeDir,
  timeoutMs,
}) {
  if (!profile.failOnBase || testFiles.length === 0) {
    return { attempted: false, supported: true, outcome: 'not-run' };
  }
  try {
    const { dir } = ensureBaseWorktree({ repoDir, ref: baseRef, dir: baseWorktreeDir });
    overlayFiles({ baseDir: dir, headRef, files: testFiles });
    return runDerivedTests({ cwd: dir, files: testFiles, runner, timeoutMs });
  } catch (err) {
    return {
      attempted: true,
      supported: false,
      outcome: 'not-run',
      notes: `base worktree setup failed: ${err.message}`,
    };
  }
}

/**
 * Build the full observation object for one task boundary.
 *
 * @param {object} input
 * @param {string} input.repoDir - the ticket worktree (git repo).
 * @param {string} input.baseRef - the task's base (last-commit-sha or merge base).
 * @param {string} [input.headRef] - default 'HEAD'.
 * @param {string[]} input.scopeGlobs - the task's Files-in-scope entries
 *   (from the canonical task parser); empty/null → scopeUnresolved.
 * @param {string} input.taskKind - planner kind.
 * @param {number} [input.taskNum] - the task number (GH-769); when provided,
 *   the diff is resolved from THIS task's attributed commits and an additive
 *   `attribution` observation is emitted. Omitted → legacy `base..HEAD` diff,
 *   no `attribution` key (serial backward compatibility).
 * @param {string} input.baseWorktreeDir - where the per-ticket base worktree lives.
 * @param {number} [input.timeoutMs]
 * @returns observations in the replay-corpus shape.
 */
function buildObservations(input) {
  const { repoDir, baseRef, scopeGlobs, taskKind, taskNum, baseWorktreeDir, timeoutMs } = input;
  // Resolve head to a SHA once: symbolic refs like 'HEAD' would re-resolve
  // against the BASE worktree's own HEAD during the overlay checkout.
  const headRef = resolveRef(repoDir, input.headRef || 'HEAD') || input.headRef || 'HEAD';
  const profile = profileFor(taskKind);

  const { diff, attribution } = resolveDiffWithAttribution({
    repoDir,
    baseRef,
    headRef,
    scopeGlobs,
    taskNum,
  });
  const deliverables = buildDeliverables({ repoDir, headRef, scope: diff.scopeGlobs });
  const testFiles = deriveTestFiles(diff.filesChanged);
  const runner = detectRunner(repoDir);

  const headRun = buildHeadRun({ repoDir, testFiles, profile, runner, timeoutMs });
  const baseRun = buildBaseRun({
    repoDir,
    baseRef,
    headRef,
    testFiles,
    profile,
    runner,
    baseWorktreeDir,
    timeoutMs,
  });

  return {
    diff,
    deliverables,
    baseRun,
    headRun,
    coverage: { supported: false, changedLineCoveragePct: null },
    derivedTests: { files: testFiles, runner: runner || 'none' },
    // Additive (GH-769): only present when a taskNum drove attribution.
    ...(attribution ? { attribution } : {}),
  };
}

module.exports = { buildObservations, deriveTestFiles, normalizeScope, promisedDeliverables };
