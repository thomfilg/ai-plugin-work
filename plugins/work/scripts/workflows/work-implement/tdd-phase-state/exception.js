'use strict';

/**
 * tdd-phase-state/exception.js
 *
 * The operator-only `exception` subcommand + its audit helper, extracted from
 * tdd-phase-state.js (GH-610 static-quality refactor). The operator-token gate,
 * category/checkpoint/new-export validations, audit rows (allow=false on every
 * rejection, allow=true on success), and emitted output are byte-for-byte.
 */

const path = require('path');
const { execSync } = require('child_process');
const { resolveTasksBaseWithFallback } = require('../../lib/ticket-validation');
const { safeParseTask, parseCategory, errorExit, successOut } = require('./io');
const { sanitizeId, writeState } = require('./state-path');

function auditException(ticketId, taskNum, category, reason, allow) {
  try {
    const { appendEnforcementAudit } = require('../../work/lib/work-actions');
    appendEnforcementAudit(ticketId, {
      origin: 'ai-subtask',
      task: taskNum || null,
      phase: null,
      action: 'tdd-exception',
      allow,
      reason: (category || 'unknown') + ': ' + (reason || ''),
      outputPath: null,
      meta: { category },
    });
  } catch {
    /* fail-open */
  }
}

/**
 * GH-528: `exception` is an operator-only escape hatch gated behind an env
 * token the agent's environment never carries.
 */
function assertOperatorToken() {
  if (process.env.WORK_OPERATOR_TOKEN !== '1') {
    errorExit(
      'The `exception` subcommand is operator-only and requires WORK_OPERATOR_TOKEN=1. ' +
        'Agents must use the Type taxonomy (docs / tests-only / config / ci / mechanical-refactor / file-move / checkpoint) ' +
        'set by the planner instead. See plugins/work/skills/split-in-tasks/lib/task-types.js.'
    );
  }
}

/** Validate the `checkpoint` category against actual task metadata. */
function validateCheckpoint(ticketId, taskNum, category) {
  if (category !== 'checkpoint') return;
  if (!taskNum) {
    auditException(ticketId, null, category, null, false);
    errorExit('Category "checkpoint" requires --task <N> to identify which task is a checkpoint.');
  }
  const { isCheckpointTask } = require('../exception-validator');
  const resolvedTasksBase = resolveTasksBaseWithFallback();
  const safeId = sanitizeId(ticketId);
  if (!isCheckpointTask(safeId, taskNum, resolvedTasksBase)) {
    auditException(ticketId, taskNum, category, null, false);
    errorExit(
      'Category "checkpoint" is only allowed for checkpoint tasks. Task ' +
        taskNum +
        ' is not a checkpoint task.'
    );
  }
}

/** Parse + validate the required `--reason` argument (audits on rejection). */
function parseExceptionReason(ticketId, taskNum, category, args) {
  const reasonIdx = args.indexOf('--reason');
  if (reasonIdx === -1 || reasonIdx + 1 >= args.length) {
    auditException(ticketId, taskNum, category, null, false);
    errorExit('Missing --reason argument.');
  }
  const reason = args[reasonIdx + 1];
  if (!reason || !reason.trim()) {
    auditException(ticketId, taskNum, category, '', false);
    errorExit('Reason cannot be empty.');
  }
  return reason;
}

/**
 * Heuristic check: detect new exported code (skip for checkpoint and file-move).
 * Audits + errors when git detection fails or new exports are found.
 */
function assertNoNewExports(ticketId, taskNum, category, reason) {
  if (category === 'checkpoint' || category === 'file-move') return;

  let allChanged = [];
  try {
    const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    const gitOpts = { encoding: 'utf8', cwd: repoRoot };
    const diff = execSync('git diff --diff-filter=A --name-only', gitOpts).trim();
    const staged = execSync('git diff --cached --diff-filter=A --name-only', gitOpts).trim();
    const untracked = execSync('git ls-files --others --exclude-standard', gitOpts).trim();
    const relFiles = [
      ...new Set(
        [...diff.split('\n'), ...staged.split('\n'), ...untracked.split('\n')].filter(Boolean)
      ),
    ];
    allChanged = relFiles.map((f) => path.resolve(repoRoot, f));
  } catch {
    auditException(ticketId, taskNum, category, reason, false);
    errorExit(
      'Unable to verify exception eligibility: git repository detection failed. Run this command from within the repository so new-export checks can be enforced.'
    );
  }

  const { checkNewExportedCode } = require('../exception-validator');
  const exportCheck = checkNewExportedCode(allChanged);
  if (exportCheck.hasNewExports) {
    auditException(ticketId, taskNum, category, reason, false);
    errorExit(
      'New exported code detected in: ' +
        exportCheck.files.join(', ') +
        '. TDD is required for new code with exports. Use the RED-GREEN-REFACTOR cycle instead of exception mode.'
    );
  }
}

function cmdException(ticketId, args) {
  if (!ticketId) errorExit('Missing ticket ID.');

  assertOperatorToken();

  // Parse --category (required)
  const category = parseCategory(args);
  const taskNum = safeParseTask(args);
  if (!category) {
    auditException(ticketId, taskNum, null, null, false);
    errorExit(
      'Missing --category argument. Usage: node tdd-phase-state.js exception <TICKET_ID> --category <category> --reason "<reason>"'
    );
  }

  // Validate category
  const { validateExceptionCategory } = require('../exception-validator');
  const catResult = validateExceptionCategory(category);
  if (!catResult.valid) {
    auditException(ticketId, taskNum, category, null, false);
    errorExit('Invalid exception category: ' + catResult.reason);
  }

  validateCheckpoint(ticketId, taskNum, category);

  const reason = parseExceptionReason(ticketId, taskNum, category, args);

  const opts = taskNum ? { taskNum } : undefined;

  assertNoNewExports(ticketId, taskNum, category, reason);

  // Write structured exception
  const state = {
    currentPhase: 'exception',
    exception: { category, reason },
    cycles: [],
  };
  writeState(ticketId, state, opts);

  auditException(ticketId, taskNum, category, reason, true);

  successOut({ ok: true, phase: 'exception', category, reason });
}

module.exports = {
  cmdException,
};
