/**
 * phase-registry.js
 *
 * Per-phase rules for the /work workflow orchestrate.
 *
 * For each phase the registry declares:
 *   - budgetMin     : how long the phase may stay current before action
 *   - reNudgeMin    : minutes between consecutive nudges on the same phase
 *                     (defaults to clamp(budgetMin/2, 2, 20))
 *   - maxNudges     : nudges before escalating to a maestro alert
 *   - detectors     : ordered list of detector keys to apply during this phase
 *   - exempts(ctx)  : optional fn that returns true to suppress nudges
 *                     (e.g., long-running e2e tests, hardware-bound work).
 *
 * Registry is the single source of truth — add a new phase by adding a row.
 *
 * Usage:
 *   const { phaseFor, escalationFor } = require('./phase-registry');
 */

// Base profile every phase inherits unless overridden.
// 'silence' runs in every phase — it watches for fully-dead panes and
// auto-restarts -work sessions (ported from maestro-conduct.sh).
const BASE = Object.freeze({
  maxNudges: 3,
  detectors: ['question', 'silence', 'spinner', 'phaseStall'],
  exempts: () => false,
});

// Per-phase overrides — keep one row per phase, terse.
const PHASES = Object.freeze({
  bootstrap: { budgetMin: 5, detectors: ['silence', 'spinner', 'phaseStall'] },
  ticket: { budgetMin: 2 },
  brief: { budgetMin: 10 },
  brief_gate: { budgetMin: 5 },
  spec: { budgetMin: 10 },
  spec_gate: { budgetMin: 5 },
  tasks: { budgetMin: 10 },
  tasks_gate: { budgetMin: 5 },
  implement: {
    budgetMin: 60,
    detectors: ['question', 'silence', 'spinner', 'phaseStall', 'commitStall'],
  },
  commit: { budgetMin: 5 },
  task_review: { budgetMin: 30 },
  check: { budgetMin: 15 },
  pr: { budgetMin: 10 },
  ready: { budgetMin: 5 },
  follow_up: {
    budgetMin: 60,
    detectors: ['question', 'silence', 'spinner', 'phaseStall', 'prComments'],
  },
  ci: { budgetMin: 30 },
  cleanup: { budgetMin: 5 },
  reports: { budgetMin: 5 },
  complete: { budgetMin: 1 },
});

const UNKNOWN = Object.freeze({ budgetMin: 30 });

/**
 * Resolve a fully-populated phase profile (BASE + override + derived fields).
 * @param {string} phase
 * @returns {{budgetMin:number, reNudgeMin:number, maxNudges:number, detectors:string[], exempts:Function, name:string}}
 */
function phaseFor(phase) {
  const override = PHASES[phase] || UNKNOWN;
  const merged = { ...BASE, ...override, name: phase || 'unknown' };
  // Derive re-nudge cadence from budget if not set: half budget, clamp 2..20.
  if (typeof merged.reNudgeMin !== 'number') {
    merged.reNudgeMin = Math.min(20, Math.max(2, Math.floor(merged.budgetMin / 2)));
  }
  return Object.freeze(merged);
}

/**
 * Compute the action for the Nth nudge.
 * 1st nudge → soft (just message)
 * 2nd+      → interrupt (Esc, then message) — agent ignored the soft one
 * After maxNudges → escalate to maestro alert
 */
function escalationFor(phase, nudgeCount) {
  const p = phaseFor(phase);
  if (nudgeCount >= p.maxNudges) return 'alert';
  if (nudgeCount >= 1) return 'interrupt';
  return 'soft';
}

module.exports = {
  PHASES,
  phaseFor,
  escalationFor,
};
