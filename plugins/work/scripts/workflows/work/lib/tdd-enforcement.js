/**
 * tdd-enforcement.js
 *
 * TDD protocol text and evidence validation helpers. Used by the transition
 * gate and by the implement step to augment agent prompts.
 */

const fs = require('fs');
const path = require('path');
const { taskSegment } = require('../../lib/allocate-output-folder');
// Shared citation-kind set (verified-by / wiring-citation) — same module the
// strategy synthesis/validation path uses, so the kind list never forks.
const { CITATION_KIND_SET } = require('../../lib/test-strategy');
// Exception categories — single source (aligned with the `### Type` enum via
// task-types.js TDD_EXEMPT_TYPES) so the protocol text can never drift from
// what validateExceptionCategory actually accepts.
const { ALLOWED_CATEGORIES } = require('../../work-implement/exception-validator');
// Closed `### Type` enum — the SAME taxonomy the planner wrote and the
// implement gate consumes (skills/split-in-tasks/lib/task-types.js).
const { isTddExempt } = require(
  path.join(__dirname, '..', '..', '..', '..', 'skills', 'split-in-tasks', 'lib', 'task-types')
);

const TDD_PROTOCOL = `
TDD protocol (hook-enforced for this step):

The TDD loop is enforced by hooks — file restrictions are automatic per phase.
Use tdd-phase-state.js CLI for evidence recording and phase transitions.

Initialize TDD state:
  node <TDD_STATE_PATH> init <TICKET_ID> --task <N>

Note: --task <N> is required when working inside a task-scoped workflow (tasks.md exists).
Omit --task when running standalone /work-implement without task context.
All subcommands (init, record-*, transition) support --task when task context exists.

For each behavior change, cycle through RED → GREEN → REFACTOR.
Each phase has hook-enforced file restrictions.
RED Phase (write failing tests — hook enforced):
- Hook BLOCKS Write/Edit to any non .test/.spec file
- Write focused tests (1-3) that express expected behavior
- Record evidence and transition:
  node <TDD_STATE_PATH> record-red <TICKET_ID> --task <N> --cmd "<targeted test command>"
  node <TDD_STATE_PATH> transition <TICKET_ID> green --task <N>

GREEN Phase (make tests pass):
- Hook BLOCKS Write/Edit to .test/.spec files (prevents cheating)
- Test helpers allowed: __mocks__/, __fixtures__/, test-utils, *.mock.*, *.fixture.*
- Write minimum production code to make tests pass
- Record evidence and transition:
  node <TDD_STATE_PATH> record-green <TICKET_ID> --task <N> --cmd "<same test command>"
  node <TDD_STATE_PATH> transition <TICKET_ID> refactor --task <N>

REFACTOR Phase (clean up):
- No file restrictions
- Refactor both test and production code
- Record evidence:
  node <TDD_STATE_PATH> record-refactor <TICKET_ID> --task <N> --cmd "<broader test command>"
  node <TDD_STATE_PATH> transition <TICKET_ID> red --task <N>  (if more behaviors)

Rules:
- Evidence is recorded by the SCRIPT — it runs git diff and test commands itself.
- Do NOT make local git commits during the cycle — the commit step handles that.
- TDD exemptions come ONLY from the planner's \`### Type\` line in tasks.md
  (tests-only, docs, config, ci, mechanical-refactor, file-move, checkpoint).
  The \`exception\` subcommand is OPERATOR-ONLY (WORK_OPERATOR_TOKEN-gated) —
  do not invoke it; agent invocations are rejected. If the change genuinely
  cannot be test-driven and its Type does not exempt it, STOP and report
  \`BLOCKED (planner-defect): <one-line reason>\` back to the orchestrator.
`.trim();

/**
 * Reads TDD phase evidence from the on-disk state file.
 * @param {string} tasksBase - TASKS_BASE root directory
 * @param {string} ticketId
 * @param {string} stepId - unused (reserved for multi-step enforcement)
 * @param {number} [taskNum] - 1-indexed task number; when provided, reads from per-task path
 * @returns {{exists: boolean, parseError: boolean, evidence: object|null}}
 */
function readTddEvidence(tasksBase, ticketId, stepId, taskNum) {
  // taskSegment() validates taskNum internally (throws on non-positive-integer)
  const phasePath =
    taskNum != null
      ? path.join(tasksBase, ticketId, taskSegment(taskNum), 'tdd-phase.json')
      : path.join(tasksBase, ticketId, 'tdd-phase.json'); // root fallback for non-task flows
  try {
    if (!fs.existsSync(phasePath)) return { exists: false, parseError: false, evidence: null };
  } catch {
    return { exists: false, parseError: false, evidence: null };
  }
  try {
    const state = JSON.parse(fs.readFileSync(phasePath, 'utf-8'));
    return { exists: true, parseError: false, evidence: state };
  } catch {
    return { exists: true, parseError: true, evidence: null };
  }
}

/**
 * Validates that TDD evidence is well-formed and shows at least one
 * completed RED → GREEN cycle (or an exception).
 * @param {object|null} evidence
 * @returns {{valid: boolean, reason: string}}
 */
function validateTddEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') {
    return { valid: false, reason: 'Evidence is null or not an object' };
  }

  // Exception handling: accept both legacy string and structured { category, reason }
  if (evidence.exception != null) {
    // Legacy format: bare string (backward compat)
    if (typeof evidence.exception === 'string' && evidence.exception.trim() !== '') {
      return { valid: true, reason: '' };
    }
    // Structured format: { category, reason }
    if (typeof evidence.exception === 'object' && evidence.exception !== null) {
      const cat = evidence.exception.category;
      if (typeof cat === 'string' && ALLOWED_CATEGORIES.includes(cat)) {
        // GH-258: validated against exception-validator.ALLOWED_CATEGORIES
        const reason = evidence.exception.reason;
        if (typeof reason !== 'string' || !reason.trim()) {
          return {
            valid: false,
            reason: 'Exception reason is required and must be a non-empty string.',
          };
        }
        return { valid: true, reason: '' };
      }
      return {
        valid: false,
        reason:
          'Invalid exception category: "' +
          cat +
          '". Allowed: ' +
          ALLOWED_CATEGORIES.join(', ') +
          '.',
      };
    }
    // exception exists but is neither string nor valid object
    return { valid: false, reason: 'Exception field has invalid format' };
  }

  const cycles = evidence.cycles;
  if (!Array.isArray(cycles) || cycles.length === 0) {
    return {
      valid: false,
      reason:
        'No TDD cycles found. Run at least one RED → GREEN cycle (REFACTOR is recommended but optional).',
    };
  }

  const completeCycle = cycles.find((c) => c.red && c.green && c.refactor);
  if (!completeCycle) {
    const partialCycle = cycles.find((c) => c.red && c.green);
    if (!partialCycle) {
      const citation = validateCitationCycle(cycles);
      if (citation) return citation;
      return {
        valid: false,
        reason:
          'No cycle has both RED and GREEN evidence. Complete at least one RED → GREEN cycle.',
      };
    }
  }

  return { valid: true, reason: '' };
}

/**
 * GH-509 permanent-retry fix — a GREEN-only cycle recorded by peer citation
 * (strategy.js recordCitationEvidence: { kind: 'verified-by'|'wiring-citation',
 * peer, peerSha, scopeOverlap, recordedAt }) IS a complete cycle: citation
 * kinds have no runnable command, so no RED can ever exist for them.
 *
 * Integrity: `peerSha` must be present (non-empty string) — it stamps which
 * peer evidence state the citation was validated against. Citation evidence
 * without it is rejected rather than treated as a normal incomplete cycle.
 *
 * @param {object[]} cycles
 * @returns {{valid: boolean, reason: string}|null} null when no cycle carries
 *   citation-kind GREEN evidence (caller falls through to the generic reject)
 */
function validateCitationCycle(cycles) {
  const cited = cycles.find(
    (c) => c && c.green && typeof c.green === 'object' && CITATION_KIND_SET.has(c.green.kind)
  );
  if (!cited) return null;
  const peerSha = cited.green.peerSha;
  if (typeof peerSha !== 'string' || peerSha.trim() === '') {
    return {
      valid: false,
      reason:
        `Citation evidence (kind "${cited.green.kind}") is missing peerSha. ` +
        'Re-record via tdd-phase-state.js record-green so peer provenance is stamped.',
    };
  }
  return { valid: true, reason: '' };
}

/**
 * The ONE contract-aware evidence-acceptance function (unification invariant:
 * ONE VALIDATOR IMPLEMENTATION, SHARED BY BOTH PHASES). Every consumer that
 * knows the task's `### Type` MUST call this instead of the strict
 * `validateTddEvidence`, so the implement gate, the SubagentStop hook, and the
 * downstream check/complete validators all apply the SAME acceptance rule to
 * the same tdd-phase.json:
 *
 *   - TDD-exempt Types (task-types.js TDD_EXEMPT_TYPES): red-only OR
 *     green-only evidence (stub or real) is a complete record — the gate's
 *     pre-test skip stub legitimately writes a red-only entry, and citation /
 *     docs paths record green-only. Validating those with the strict rule
 *     produced infinite retries at the gate (echo-4552 #2) and dead-ends at
 *     check/complete after the gate advanced.
 *   - TDD-required Types (and unknown/missing Types — fail closed): the
 *     strict rule (complete RED→GREEN cycle, a recorded exception, or
 *     citation-kind GREEN with peerSha).
 *
 * Exception evidence and citation cycles are accepted for exempt types too
 * (superset via the strict fallback).
 *
 * @param {object|null} evidence
 * @param {string|null} taskType - the task's `### Type` (null/unknown → strict)
 * @returns {{valid: boolean, reason: string}}
 */
function validateTddEvidenceForType(evidence, taskType) {
  if (!isTddExempt(taskType)) return validateTddEvidence(evidence);
  if (!evidence || typeof evidence !== 'object') {
    return { valid: false, reason: 'Evidence is null or not an object' };
  }
  const hasPhaseEvidence =
    Array.isArray(evidence.cycles) && evidence.cycles.some((c) => c && (c.red || c.green));
  if (hasPhaseEvidence) return { valid: true, reason: '' };
  // No phase evidence — fall back to the strict rule so exception evidence
  // (and any other strictly-valid shape) still passes for exempt types.
  const strict = validateTddEvidence(evidence);
  if (strict.valid) return strict;
  return {
    valid: false,
    reason:
      `TDD-exempt task type "${taskType}" has no recorded phase evidence ` +
      '(RED or GREEN, stub or real) and no valid exception.',
  };
}

module.exports = {
  TDD_PROTOCOL,
  readTddEvidence,
  validateTddEvidence,
  validateTddEvidenceForType,
};
