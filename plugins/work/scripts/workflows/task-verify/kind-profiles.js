'use strict';

/**
 * task-verify/kind-profiles.js — per-kind verification profiles as DATA
 * (GH-755, outcome-verification Phase 2; plan §5.4).
 *
 * A profile says which of the five invariants apply to a task kind and how —
 * expressed as data, not control flow, so adding a kind is a table edit that
 * the corpus gate immediately exercises. The kind vocabulary mirrors the
 * planner's (split-in-tasks kind_assign / outcome-verdicts.TASK_KINDS).
 *
 * Unknown kinds fall back to the STRICTEST profile (tdd-code) — the same
 * fail-closed posture as the legacy gateContractFor.
 */

const { INVARIANTS } = require('../lib/outcome-verdicts');

const { diffInScope, deliverablesExist, failOnBase, passOnHead, diffCoverage } = INVARIANTS;

/** Deliverable-only kinds: the artifact IS the work; no test requirements. */
const DELIVERABLE_ONLY = Object.freeze({
  invariants: Object.freeze([deliverablesExist]),
  requiresTests: false,
  failOnBase: false,
  diffMustTouchTests: false,
});

const KIND_PROFILES = Object.freeze({
  'tdd-code': Object.freeze({
    invariants: Object.freeze([
      diffInScope,
      deliverablesExist,
      failOnBase,
      passOnHead,
      diffCoverage,
    ]),
    requiresTests: true,
    failOnBase: true,
    diffMustTouchTests: false,
  }),
  'tests-only': Object.freeze({
    // The tests ARE the deliverable: they may legitimately pass on base
    // (testing existing behavior), but the diff must touch test files.
    invariants: Object.freeze([diffInScope, deliverablesExist, passOnHead]),
    requiresTests: true,
    failOnBase: false,
    diffMustTouchTests: true,
  }),
  'mechanical-refactor': Object.freeze({
    // Behavior-preserving: fail-on-base is exempt; verified by pass-on-head
    // plus coverage-maintained instead.
    invariants: Object.freeze([diffInScope, deliverablesExist, passOnHead, diffCoverage]),
    requiresTests: true,
    failOnBase: false,
    diffMustTouchTests: false,
  }),
  docs: DELIVERABLE_ONLY,
  config: DELIVERABLE_ONLY,
  ci: DELIVERABLE_ONLY,
  'file-move': DELIVERABLE_ONLY,
  checkpoint: DELIVERABLE_ONLY,
  'verified-by': DELIVERABLE_ONLY,
  'wiring-citation': DELIVERABLE_ONLY,
});

/** Resolve the profile for a kind; unknown kinds get the strictest profile. */
function profileFor(taskKind) {
  return KIND_PROFILES[taskKind] || KIND_PROFILES['tdd-code'];
}

module.exports = { KIND_PROFILES, DELIVERABLE_ONLY, profileFor };
