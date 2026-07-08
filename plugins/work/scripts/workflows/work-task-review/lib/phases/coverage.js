/**
 * Phase: coverage — verify the agent recorded test evidence for this task.
 *
 * Gates on existence of `task-review-tests.md` (produced by task-review-gate
 * executeTaskReview). Soft-block: warns if missing rather than hard-erroring
 * to keep the task_review step advisory per workflow-definition.softSteps.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { TASK_REVIEW_PHASES } = require('../../task-review-phase-registry');

function validate(ctx) {
  const testsArtifact = path.join(ctx.tasksDir, 'task-review-tests.md');
  const codeArtifact = path.join(ctx.tasksDir, 'task-review-code.md');
  const warnings = [];
  if (!fs.existsSync(testsArtifact)) {
    warnings.push(
      '`task-review-tests.md` is missing — record the test run result (PASSED/FAILED + brief).'
    );
  }
  if (!fs.existsSync(codeArtifact)) {
    warnings.push(
      '`task-review-code.md` is missing — record the code review verdict (PASSED/FAILED + brief).'
    );
  }
  return {
    ok: true,
    warnings,
    summary: warnings.length
      ? `${2 - warnings.length}/2 review artifacts present`
      : 'both review artifacts present',
  };
}

function instructions(ctx) {
  return [
    '# task-review-next — Phase 5 of 8: COVERAGE',
    `Ticket: ${ctx.ticket}`,
    '',
    'Confirm `task-review-tests.md` + `task-review-code.md` exist for this task.',
    'These are written by `task-review-gate.executeTaskReview()` — if missing, run the gate or write them by hand.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(TASK_REVIEW_PHASES.coverage, {
    next: TASK_REVIEW_PHASES.report,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
