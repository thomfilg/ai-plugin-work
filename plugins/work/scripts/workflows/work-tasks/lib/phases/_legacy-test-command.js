'use strict';

/**
 * Detect whether a parsed task still carries the legacy `### Test Command`
 * block (instead of the new `### Test Strategy`). Used by draft-test-strategy
 * to emit a clear migration error when WORK_TEST_STRATEGY_VALIDATOR=1 but a
 * task hasn't been migrated yet.
 */
function hasLegacyTestCommand(task) {
  if (!task) return false;
  if (typeof task.testCommand === 'string' && task.testCommand.trim().length > 0) return true;
  return (
    typeof task.rawContent === 'string' && /(?:^|\n)###\s+Test Command\b/.test(task.rawContent)
  );
}

module.exports = { hasLegacyTestCommand };
