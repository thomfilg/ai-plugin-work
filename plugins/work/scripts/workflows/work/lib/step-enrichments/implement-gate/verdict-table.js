'use strict';

/**
 * verdict-table.js — the implement-gate BLOCK verdict table as DATA (GH-754,
 * outcome-verification Phase 1.3).
 *
 * Liveness principle: a gate that cannot name its exit edge may not block.
 * Every BLOCK verdict the implement machinery can produce is enumerated here
 * with its sanctioned outgoing edge(s); the liveness test
 * (__tests__/verdict-table-liveness.test.js) asserts that every entry names
 * at least one exit AND that every named exit's mechanism actually exists in
 * the codebase. Wedges (a block with no legal move — GH-721, GH-722, GH-724,
 * GH-736) thereby become CI failures instead of operator archaeology.
 *
 * The table is deliberately colocated with the gate that produces the
 * verdicts, and the test cross-checks it against gate-rejections.js source so
 * a new rejection kind cannot ship without declaring its exit here.
 *
 * Exit vocabulary (mirrors plan §5.2 typed exits; unified with
 * lib/outcome-verdicts.js when GH-755 lands):
 *   retry            re-dispatch the task through the normal gate loop.
 *   reopen-artifact  planner defect — tasks.md becomes editable (planner hold).
 *   escalate         operator recovery hatch (`work-state.js recover`,
 *                    operator-approved via AskUserQuestion).
 */

const fs = require('fs');
const path = require('path');

/**
 * The sanctioned exit edges. Each edge carries a `verify()` that mechanically
 * proves the mechanism still exists (consumed by the liveness test).
 */
const EXIT_EDGES = Object.freeze({
  retry: {
    mechanism:
      'gate retry loop: planner-hold.persistRetryFailure records the failure and the ' +
      'orchestrator re-dispatches the task with the reason as guidance',
    verify() {
      const plannerHold = require(path.join(__dirname, 'planner-hold'));
      return typeof plannerHold.persistRetryFailure === 'function';
    },
  },
  'reopen-artifact': {
    mechanism:
      'planner hold: planner-hold.resolvePlannerHold / buildPlannerHoldInstruction park the ' +
      'workflow so tasks.md becomes editable, then release on planner edit',
    verify() {
      const plannerHold = require(path.join(__dirname, 'planner-hold'));
      return (
        typeof plannerHold.resolvePlannerHold === 'function' &&
        typeof plannerHold.buildPlannerHoldInstruction === 'function'
      );
    },
  },
  escalate: {
    mechanism:
      'operator recovery: work-state.js recover --action abandon-cycle|resync-meta|reopen-task ' +
      '(operator-approved, audited; GH-753)',
    verify() {
      const { RECOVER_ACTIONS } = require(
        path.join(__dirname, '..', '..', '..', 'work-state', 'recover')
      );
      return ['abandon-cycle', 'resync-meta', 'reopen-task'].every((a) =>
        RECOVER_ACTIONS.includes(a)
      );
    },
  },
});

/**
 * Every BLOCK verdict the implement machinery can produce, with its exits.
 * `source` says which layer emits it:
 *   gate-rejection  audit action written by gate-rejections.js (allow: false)
 *   gate-state      a parked/wedgeable .work-state.json configuration
 *   agent-loop      task-next.js phase evaluation block (agent-facing)
 *   step            task_review step decision
 */
const BLOCK_VERDICTS = Object.freeze([
  // ── gate-rejections.js audit actions (allow: false) ──────────────────────
  {
    id: 'tdd-red-hang-rejected',
    source: 'gate-rejection',
    exits: ['retry', 'escalate'],
    notes: 'test command timed out during RED capture (W5); retry with a fixed command',
  },
  {
    id: 'tdd-green-hang-rejected',
    source: 'gate-rejection',
    exits: ['retry', 'escalate'],
    notes: 'test command timed out during GREEN capture',
  },
  {
    id: 'tdd-red-load-failure-rejected',
    source: 'gate-rejection',
    exits: ['retry', 'escalate'],
    notes: 'test file structurally broken at load (GH-532 class); retry rewrites the test',
  },
  {
    id: 'tdd-green-empty-rejected',
    source: 'gate-rejection',
    exits: ['retry', 'reopen-artifact', 'escalate'],
    notes: 'exit-0 with zero output (GH-466 RC-D trap); planner defect when command is wrong',
  },
  {
    id: 'tdd-green-tests-only-unchanged-rejected',
    source: 'gate-rejection',
    exits: ['retry', 'escalate'],
    notes: 'tests-only task with no changed test files (GH-694)',
  },
  {
    id: 'tdd-green-tests-only-scope-unresolved-rejected',
    source: 'gate-rejection',
    exits: ['reopen-artifact', 'escalate'],
    notes: 'scope unparseable for a tests-only task (PR #717) — a plan defect, not a work defect',
  },
  // ── parked / wedgeable state configurations ──────────────────────────────
  {
    id: 'planner-hold-parked',
    source: 'gate-state',
    exits: ['reopen-artifact'],
    notes: '_tddRetryPlannerDefect parked — tasks.md must change before re-dispatch',
  },
  {
    id: 'tasks-meta-desynced',
    source: 'gate-state',
    exits: ['escalate'],
    notes: 'tasksMeta no longer matches tasks.md (GH-736) — recover resync-meta',
  },
  {
    id: 'completed-task-carries-defect',
    source: 'gate-state',
    exits: ['escalate'],
    notes: 'a completed task must be re-run (GH-724/GH-721) — recover reopen-task',
  },
  {
    id: 'stuck-cycle-no-legal-phase',
    source: 'gate-state',
    exits: ['escalate'],
    notes: 'in-flight cycle state deadlocked (GH-721/GH-722) — recover abandon-cycle',
  },
  // ── agent-facing phase blocks ────────────────────────────────────────────
  {
    id: 'phase-evaluation-blocked',
    source: 'agent-loop',
    exits: ['retry', 'escalate'],
    notes: 'task-next.js RED/GREEN/REFACTOR evaluation returned blocked — agent iterates in-loop',
  },
  // ── task_review step ─────────────────────────────────────────────────────
  {
    id: 'task-review-fix-rounds-exhausted',
    source: 'step',
    exits: ['escalate'],
    notes: 'task N fix rounds exhausted — escalates to the operator',
  },
]);

/**
 * Pure liveness checker: every verdict must name >= 1 exit and every named
 * exit must be a known edge. Returns human-readable violations (empty = live).
 */
function findLivenessViolations(table = BLOCK_VERDICTS, edges = EXIT_EDGES) {
  const violations = [];
  for (const verdict of table) {
    if (!Array.isArray(verdict.exits) || verdict.exits.length === 0) {
      violations.push(
        `${verdict.id}: BLOCK verdict with NO exit edge — this is a wedge by construction`
      );
      continue;
    }
    for (const exit of verdict.exits) {
      if (!edges[exit]) {
        violations.push(`${verdict.id}: names unknown exit edge "${exit}"`);
      }
    }
  }
  return violations;
}

/**
 * Extract the gate-rejection action ids actually present in
 * gate-rejections.js source, so the table cannot silently drift from the
 * code that emits the verdicts. `tdd-e2e-skip-stub` is allow:true (not a
 * block) and is excluded.
 */
function gateRejectionActionsFromSource() {
  const sourcePath = path.join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'work-implement',
    'tdd-phase-state',
    'gate-rejections.js'
  );
  const source = fs.readFileSync(sourcePath, 'utf8');
  const literal = source.match(/tdd-[a-z-]+-rejected/g) || [];
  // Phase-templated actions (`tdd-${p.phase}-hang-rejected`) expand over the
  // phases the gate captures for.
  const templated = [];
  for (const m of source.match(/tdd-\$\{[^}]+\}-([a-z-]+-rejected)/g) || []) {
    const suffix = m.replace(/^tdd-\$\{[^}]+\}-/, '');
    templated.push(`tdd-red-${suffix}`, `tdd-green-${suffix}`);
  }
  return [...new Set([...literal, ...templated])];
}

module.exports = {
  BLOCK_VERDICTS,
  EXIT_EDGES,
  findLivenessViolations,
  gateRejectionActionsFromSource,
};
