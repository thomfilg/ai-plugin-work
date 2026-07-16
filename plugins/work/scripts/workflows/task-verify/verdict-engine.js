'use strict';

/**
 * task-verify/verdict-engine.js — the PURE three-verdict engine (GH-755,
 * outcome-verification Phase 2; plan §5.2).
 *
 * evaluate(observations, taskKind) folds one task boundary's OBSERVATIONS
 * (the replay-corpus observation shape — diff, deliverables, baseRun,
 * headRun, coverage; produced live by the collectors, or injected verbatim
 * from fixtures) into exactly one verdict:
 *
 *   VERIFIED      all applicable invariants hold → advance.
 *   UNVERIFIED    something could not be checked → advance WITH flags
 *                 (absence of evidence never blocks; flags are consumed by
 *                 task_review and the check step).
 *   CONTRADICTED  positive evidence of a problem → block WITH a typed exit
 *                 (retry | reopen-artifact; escalate is operator-invoked).
 *
 * Design rules the corpus gate enforces (lib/replay-corpus):
 *   - Mechanism failures (unsupported runner, unresolvable scope, base
 *     worktree setup failure) are never contradictions — they degrade to
 *     flags.
 *   - I3 (fail-on-base) NEVER blocks on its own: pass-on-base with real
 *     tests is a tautology FLAG reviewed downstream (plan §5.2 table).
 *   - Exit selection: a promised deliverable missing OUTSIDE the task's own
 *     scope is a planner defect (reopen-artifact); inside scope it is
 *     undone work (retry).
 *
 * The engine is pure and synchronous: no fs, no git, no subprocesses.
 */

const path = require('path');

const { VERDICTS, INVARIANTS, FLAG_KINDS } = require('../lib/outcome-verdicts');
const { fileMatchesScope, TEST_FILE_EXT_RE } = require(
  path.join(__dirname, '..', 'lib', 'task-scope-globs')
);
const { profileFor } = require('./kind-profiles');

/** Coverage % below which an advancing verdict carries a flag (plan §10.2). */
const DEFAULT_COVERAGE_FLAG_THRESHOLD = 80;

/** Head-run outcomes that are positive evidence tests do NOT pass on head. */
const FAILING_HEAD_OUTCOMES = new Set(['fail', 'hang', 'error', 'load-failure']);

function has(applicable, invariant) {
  return applicable.has(invariant);
}

/** I1 — diff exists and is in scope (+ kind-specific test-file requirement). */
function evaluateDiff(ctx) {
  const { diff, profile, applicable } = ctx;
  if (!has(applicable, INVARIANTS.diffInScope)) return;
  if (diff.scopeUnresolved === true) {
    ctx.flags.add(FLAG_KINDS.scopeResolutionFailed);
    return;
  }
  if (diff.empty === true) {
    ctx.violate(INVARIANTS.diffInScope, 'task commits produce an empty diff');
  } else if ((diff.outOfScope || []).length > 0) {
    ctx.violate(
      INVARIANTS.diffInScope,
      `diff touches files outside the task scope: ${diff.outOfScope.join(', ')}`
    );
  } else if (profile.diffMustTouchTests && !(diff.filesChanged || []).some(isTestPath)) {
    ctx.violate(INVARIANTS.diffInScope, 'kind requires the diff to touch test files; none changed');
  }
}

function isTestPath(filePath) {
  return TEST_FILE_EXT_RE.test(String(filePath));
}

/** I2 — promised deliverables exist on head. */
function evaluateDeliverables(ctx) {
  const { deliverables, diff, applicable } = ctx;
  if (!has(applicable, INVARIANTS.deliverablesExist)) return;
  const missing = deliverables.missing || [];
  if (missing.length === 0) return;
  ctx.violate(INVARIANTS.deliverablesExist, `promised deliverables missing: ${missing.join(', ')}`);
  // Planner-defect detection: a deliverable the task's own scope cannot
  // contain is a plan inconsistency, not undone work.
  const scopeGlobs = diff.scopeGlobs || [];
  if (diff.scopeUnresolved !== true && missing.some((m) => !fileMatchesScope(m, scopeGlobs))) {
    ctx.plannerDefect = true;
  }
}

/** I3 — retroactive red: flags only, never a contradiction (plan §5.2). */
function evaluateFailOnBase(ctx) {
  const { baseRun, profile, diff } = ctx;
  if (!profile.failOnBase || diff.scopeUnresolved === true) return;
  if (!baseRun.attempted) return;
  if (!baseRun.supported) {
    ctx.flags.add(FLAG_KINDS.baseSetupFailed);
    return;
  }
  const testsRan = typeof baseRun.testsRan === 'number' ? baseRun.testsRan : null;
  if (baseRun.outcome === 'pass' && testsRan !== null && testsRan > 0) {
    // Tests that already pass on base cannot specify the new behavior —
    // tautology / change-detector suspicion, reviewed by task_review.
    ctx.flags.add(FLAG_KINDS.tautology);
  }
}

/** I4 — tests pass on head with a real (structured) test count. */
function evaluatePassOnHead(ctx) {
  const { headRun, profile, applicable, diff } = ctx;
  if (!has(applicable, INVARIANTS.passOnHead) || !profile.requiresTests) return;
  if (diff.scopeUnresolved === true) return;
  if (!headRun.attempted || !headRun.supported) return; // mechanism flags handle it
  if (FAILING_HEAD_OUTCOMES.has(headRun.outcome)) {
    ctx.violate(
      INVARIANTS.passOnHead,
      `tests do not pass on head (${headRun.outcome}${headRun.notes ? `: ${headRun.notes}` : ''})`
    );
    return;
  }
  if (headRun.outcome === 'pass' && headRun.testsRan === 0) {
    ctx.violate(
      INVARIANTS.passOnHead,
      '0 tests ran for a test-requiring kind — an exit-0 with no executed tests is not a pass'
    );
  }
}

/** I5 — diff coverage: contradict only at 0% for test-requiring kinds. */
function evaluateCoverage(ctx) {
  const { coverage, profile, applicable, options } = ctx;
  if (!has(applicable, INVARIANTS.diffCoverage)) return;
  if (!coverage.supported) return;
  const pct = coverage.changedLineCoveragePct;
  if (typeof pct !== 'number') return;
  if (pct === 0 && profile.requiresTests) {
    ctx.violate(INVARIANTS.diffCoverage, 'changed production lines have 0% coverage');
    return;
  }
  const threshold = options.coverageFlagThreshold ?? DEFAULT_COVERAGE_FLAG_THRESHOLD;
  if (pct < threshold) {
    ctx.flags.add(FLAG_KINDS.coverageBelowThreshold);
  }
}

/** Observation-mechanism flags for the head run (any kind). */
function collectRunnerFlags(ctx) {
  const { headRun, diff } = ctx;
  if (diff.scopeUnresolved === true) return; // scope failure is the root cause
  if (headRun.supported === false) {
    ctx.flags.add(FLAG_KINDS.runnerUnknown);
    return;
  }
  if (headRun.attempted && headRun.reporterKind !== 'structured') {
    ctx.flags.add(FLAG_KINDS.noStructuredReporter);
  }
}

/**
 * Evaluate one task boundary.
 *
 * @param {object} observations - replay-corpus observation shape
 *   ({ diff, deliverables, baseRun, headRun, coverage }).
 * @param {string} taskKind - planner kind (unknown → strictest profile).
 * @param {object} [options] - { coverageFlagThreshold }.
 * @returns {{ verdict: string, violatedInvariants: string[], flags: string[],
 *             exit: string|null, reasons: string[] }}
 */
function makeContext(observations, taskKind, options) {
  const obs = observations || {};
  const profile = profileFor(taskKind);
  return {
    diff: obs.diff || {},
    deliverables: obs.deliverables || {},
    baseRun: obs.baseRun || {},
    headRun: obs.headRun || {},
    coverage: obs.coverage || {},
    profile,
    applicable: new Set(profile.invariants),
    options,
    flags: new Set(),
    violations: new Set(),
    reasons: [],
    plannerDefect: false,
    violate(invariant, reason) {
      this.violations.add(invariant);
      this.reasons.push(`${invariant}: ${reason}`);
    },
  };
}

function buildResult(ctx) {
  if (ctx.violations.size > 0) {
    return {
      verdict: VERDICTS.contradicted,
      violatedInvariants: [...ctx.violations].sort(),
      flags: [],
      exit: ctx.plannerDefect ? 'reopen-artifact' : 'retry',
      reasons: ctx.reasons,
    };
  }
  if (ctx.flags.size > 0) {
    return {
      verdict: VERDICTS.unverified,
      violatedInvariants: [],
      flags: [...ctx.flags].sort(),
      exit: null,
      reasons: ctx.reasons,
    };
  }
  return { verdict: VERDICTS.verified, violatedInvariants: [], flags: [], exit: null, reasons: [] };
}

function evaluate(observations, taskKind, options = {}) {
  const ctx = makeContext(observations, taskKind, options);
  evaluateDiff(ctx);
  evaluateDeliverables(ctx);
  evaluateFailOnBase(ctx);
  evaluatePassOnHead(ctx);
  evaluateCoverage(ctx);
  collectRunnerFlags(ctx);
  return buildResult(ctx);
}

module.exports = { evaluate, DEFAULT_COVERAGE_FLAG_THRESHOLD };
