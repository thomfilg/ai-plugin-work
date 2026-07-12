'use strict';

/**
 * phase-ledger.js — the ONE shared "inner phase ledger is terminal" predicate
 * (GH-696).
 *
 * The brief/spec/tasks steps run self-paced inner phase drivers that record
 * their progress in `<step>-phase.json` ledgers. On GH-689 the outer driver
 * closed step artifact windows while those drivers were still mid-flight
 * (brief advanced at `draft`, spec_gate satisfied at `surface_audit`),
 * silently skipping the remaining validate/memorize/kind_checks phases.
 *
 * Step verifiers, gate verifiers, and inspect.js all consume THIS predicate
 * so they cannot drift; the map is data-driven so pr/task_review ledgers can
 * join later without touching the verifiers.
 *
 * Contract:
 *   - step without a registered ledger → not blocked
 *   - absent ledger file               → not blocked (legacy/pre-phase-driver
 *     tickets advance exactly as today)
 *   - currentPhase === terminal        → not blocked
 *   - currentPhase non-terminal        → blocked (writer agent mid-flight —
 *     the plan matrix re-dispatches it; its runner resumes from currentPhase)
 *   - unreadable/corrupt/phase-less    → blocked, currentPhase UNPARSEABLE_PHASE
 *     (fail closed — refusal to vouch, per the checkpoints.js precedent).
 *     Re-dispatching the writer CANNOT repair this one: its runner reads the
 *     same corrupt file and dies at `init` (create-phase-state-cli.js
 *     readState → JSON.parse throw), so the plan matrix routes it to an
 *     AskUserQuestion operator escalation naming the corrupt file and the
 *     repair (delete the ledger to accept the artifact pre-ledger-style, or
 *     restore valid JSON so the runner resumes) — see
 *     steps/lib/unparseable-ledger-escalation.js (PR #718).
 */

const fs = require('fs');
const path = require('path');

const { BRIEF_TERMINAL_PHASE } = require(
  path.join(__dirname, '..', '..', 'work-brief', 'brief-phase-registry')
);
const { SPEC_TERMINAL_PHASE } = require(
  path.join(__dirname, '..', '..', 'work-spec', 'spec-phase-registry')
);
const { TASKS_TERMINAL_PHASE } = require(
  path.join(__dirname, '..', '..', 'work-tasks', 'tasks-phase-registry')
);

// Sentinel currentPhase for a ledger that exists but cannot be trusted
// (unreadable, corrupt JSON, or no string currentPhase). Deliberately not a
// real registry phase: runners can never reach it, and the plan matrix keys
// the operator-escalation branch on it.
const UNPARSEABLE_PHASE = 'unparseable';

// File names match each runner's phase-state writer (see
// `stateFileName` in *-phase-state.js).
const STEP_LEDGERS = Object.freeze({
  brief: Object.freeze({ file: 'brief-phase.json', terminal: BRIEF_TERMINAL_PHASE }),
  spec: Object.freeze({ file: 'spec-phase.json', terminal: SPEC_TERMINAL_PHASE }),
  tasks: Object.freeze({ file: 'tasks-phase.json', terminal: TASKS_TERMINAL_PHASE }),
});

/**
 * @param {string} ticketDir - absolute path to the ticket's tasks dir
 * @param {string} step - workflow step name ('brief' | 'spec' | 'tasks' | …)
 * @returns {{ blocked: boolean, currentPhase: string|null }}
 */
function phaseLedgerBlocked(ticketDir, step) {
  const ledger = STEP_LEDGERS[step];
  if (!ledger) return { blocked: false, currentPhase: null };
  const file = path.join(ticketDir, ledger.file);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { blocked: false, currentPhase: null };
    return { blocked: true, currentPhase: UNPARSEABLE_PHASE }; // unreadable — refuse to vouch
  }
  let currentPhase;
  try {
    currentPhase = JSON.parse(raw)?.currentPhase;
  } catch {
    return { blocked: true, currentPhase: UNPARSEABLE_PHASE };
  }
  if (typeof currentPhase !== 'string' || currentPhase === '') {
    return { blocked: true, currentPhase: UNPARSEABLE_PHASE };
  }
  return { blocked: currentPhase !== ledger.terminal, currentPhase };
}

module.exports = { STEP_LEDGERS, UNPARSEABLE_PHASE, phaseLedgerBlocked };
