/**
 * tdd-enforcement.js
 *
 * TDD protocol text and evidence validation helpers. Used by the transition
 * gate and by the implement step to augment agent prompts.
 */

const fs = require('fs');
const path = require('path');
const { taskSegment } = require('../../lib/allocate-output-folder');

const TDD_PROTOCOL = `
TDD protocol (hook-enforced for this step):

The TDD loop is enforced by hooks — file restrictions are automatic per phase.
Use tdd-phase-state.js CLI for evidence recording and phase transitions.

Initialize TDD state:
  node <TDD_STATE_PATH> init <TICKET_ID> --task <N>

Note: --task <N> is required when working inside a task-scoped workflow (tasks.md exists).
Omit --task when running standalone /work-implement without task context.
All subcommands (init, record-*, transition, exception) support --task when task context exists.

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
- If the change is purely mechanical (config-only, no behavior change):
  node <TDD_STATE_PATH> exception <TICKET_ID> --task <N> --category <category> --reason "<reason>"
  Allowed categories: checkpoint, config-only, file-move, mechanical-refactor
  Exception is BLOCKED when git diff contains new files with exports (use TDD instead).
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
      const { ALLOWED_CATEGORIES } = require('../../work-implement/exception-validator');
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
      return {
        valid: false,
        reason:
          'No cycle has both RED and GREEN evidence. Complete at least one RED → GREEN cycle.',
      };
    }
  }

  return { valid: true, reason: '' };
}

module.exports = { TDD_PROTOCOL, readTddEvidence, validateTddEvidence };
