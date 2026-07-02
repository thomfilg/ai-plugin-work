'use strict';

/**
 * Detect whether a parsed task still carries the legacy `### Test Command`
 * block (instead of the canonical `### Test Strategy`). Used by
 * draft-test-strategy to emit a clear migration error — the legacy block is
 * always rejected at the draft gate.
 */
function hasLegacyTestCommand(task) {
  if (!task) return false;
  if (typeof task.testCommand === 'string' && task.testCommand.trim().length > 0) return true;
  return (
    typeof task.rawContent === 'string' && /(?:^|\n)###\s+Test Command\b/.test(task.rawContent)
  );
}

function isCheckpointTask(task) {
  if (!task) return false;
  if (task.isCheckpoint === true) return true;
  return typeof task.type === 'string' && task.type.trim().toLowerCase() === 'checkpoint';
}

/**
 * Error message for a task with NO resolvable Test Strategy, or null when the
 * task is fine. Two shapes:
 *  - legacy `### Test Command` present → migration error;
 *  - neither block present on a non-checkpoint task → missing-verification
 *    error (#606 defense: with no declared verification the implement gate
 *    falls back to `node --test $CHANGED_FILES`; for prose/config scopes the
 *    test-file filter empties CHANGED_FILES, `node --test` exits with
 *    MODULE_NOT_FOUND, the RED recorder rejects it as structurally broken,
 *    and the task loops at RED forever — catch it at authoring time, where
 *    tasks.md is still editable).
 */
function noStrategyError(task, heading) {
  if (hasLegacyTestCommand(task)) {
    return `${heading}: flag on but task still uses legacy \`### Test Command\`. Convert to \`### Test Strategy\` (kind: unit|integration|e2e|custom|verified-by|wiring-citation). See skills/split-in-tasks/docs/test-strategy.md.`;
  }
  if (isCheckpointTask(task)) return null;
  return `${heading}: has neither \`### Test Strategy\` nor legacy \`### Test Command\`. Every non-checkpoint task must declare its verification (kind: unit|integration|e2e|custom|verified-by|wiring-citation). For docs/config tasks use \`kind: custom\` with a command that FAILS before the change lands and PASSES after (e.g. a grep asserting the new content). See skills/split-in-tasks/docs/test-strategy.md.`;
}

module.exports = { hasLegacyTestCommand, isCheckpointTask, noStrategyError };
