/**
 * task-scope-test-validator.js
 *
 * `validateTaskTestScope` and its private helpers, extracted from
 * task-scope-validators.js to keep both files under the max-lines threshold.
 *
 * Behavior preserved exactly.
 */

'use strict';

const {
  fileMatchesScope,
  TEST_FILE_EXT_RE,
  isIntegrationTestPath,
  isE2eTestPath,
  usesIntegrationRunner,
  usesUnitRunner,
  usesE2eRunner,
  usesRecognisedRunner,
  detectNonTestCommand,
  extractChangedFilesFromTestCommand,
  extractEvalScopePairs,
} = require('./task-scope-globs');

function _isCheckpointTask(task) {
  const taskType = typeof task.type === 'string' ? task.type.toLowerCase().trim() : null;
  return taskType === 'checkpoint' || task.isCheckpoint === true;
}

function _checkNonTestCommand(task, errors) {
  const nonTest = detectNonTestCommand(task.testCommand);
  if (!nonTest) return false;
  errors.push(
    `Task ${task.num ?? '?'} \`### Test Command\` is a ${nonTest} command, not a test runner: ` +
      `${JSON.stringify(String(task.testCommand || '').slice(0, 120))}. ` +
      "A task's gate must execute tests that assert behavior. Use $TEST_UNIT_COMMAND / " +
      '$TEST_INTEGRATION_COMMAND / $TEST_E2E_COMMAND with a real test file in CHANGED_FILES. ' +
      'If this task has no testable behavior in isolation (e.g. a helper consumed only by ' +
      'another task), MERGE IT INTO THE CONSUMING TASK — see split-in-tasks SKILL.md Rule 4b.'
  );
  return true;
}

function _checkUnscopedEvals(task, evalPairs, errors) {
  if (evalPairs.length <= 1) return false;
  const unscoped = evalPairs.filter((p) => p.changedFiles === null);
  if (unscoped.length === 0) return false;
  const carryValue = evalPairs.find((p) => p.changedFiles !== null)?.changedFiles || '<files>';
  const suggested = evalPairs
    .map((p) => `CHANGED_FILES="${p.changedFiles ?? carryValue}" eval "${p.eval}"`)
    .join(' && ');
  for (const u of unscoped) {
    errors.push(
      `Task ${task.num ?? '?'} \`### Test Command\` has an unscoped \`eval "${u.eval}"\` — ` +
        'every eval in a chained Test Command must be preceded by its own `CHANGED_FILES=...` ' +
        'assignment in the same segment, or the runner will execute the entire repo and the ' +
        'per-task gate is defeated. Corrected form: ' +
        `\`${suggested}\`.`
    );
  }
  return true;
}

function _collectChangedFiles(task, evalPairs) {
  if (evalPairs.length > 1) {
    return Array.from(
      new Set(
        evalPairs
          .filter((p) => typeof p.changedFiles === 'string' && p.changedFiles)
          .flatMap((p) => p.changedFiles.split(/\s+/).filter(Boolean))
      )
    );
  }
  return extractChangedFilesFromTestCommand(task.testCommand);
}

function _checkHelperOnlyPattern(task, changed, errors) {
  if (
    usesRecognisedRunner(task.testCommand) &&
    changed.length > 0 &&
    !changed.some((p) => TEST_FILE_EXT_RE.test(p))
  ) {
    errors.push(
      `Task ${task.num ?? '?'} \`### Test Command\` lists CHANGED_FILES with NO test files ` +
        `(no .test.* / .spec.* path). The runner will report "No test files found" and the ` +
        'gate will loop forever. This is the helper-only task pattern — the task ships code ' +
        "used by another task's tests but has no test of its own. MERGE IT INTO THE CONSUMING " +
        "TASK (split-in-tasks SKILL.md Rule 4b), or add this task's own test file to CHANGED_FILES."
    );
    return true;
  }
  return false;
}

function _checkScopeMembership(task, changed, errors) {
  const scope =
    Array.isArray(task.filesInScope) && task.filesInScope.length > 0 ? task.filesInScope : null;
  if (!scope) return;
  const offenders = changed.filter((p) => !fileMatchesScope(p, scope));
  if (offenders.length === 0) return;
  errors.push(
    `Task ${task.num ?? '?'} \`### Test Command\` references files not in its \`### Files in scope\`: ` +
      offenders.map((p) => `"${p}"`).join(', ') +
      '. The gate will execute the test against code owned by sibling tasks, which cannot pass until ' +
      'those siblings are also complete (deadlock). Fix by either: (a) narrowing the Test Command to a ' +
      "unit test of files this task actually ships, or (b) widening this task's Files in scope to include " +
      'the referenced files (only if this task should own them).'
  );
}

function _runnerMatchesFile(p, runners) {
  if (runners.e2e && isE2eTestPath(p)) return true;
  if (runners.integration && isIntegrationTestPath(p)) return true;
  if (runners.unit && !isIntegrationTestPath(p) && !isE2eTestPath(p)) return true;
  return false;
}

function _checkRunnerNamingConsistency(task, changed, errors) {
  const testFiles = changed.filter((p) => TEST_FILE_EXT_RE.test(p));
  if (testFiles.length === 0) return;
  const runners = {
    unit: usesUnitRunner(task.testCommand),
    integration: usesIntegrationRunner(task.testCommand),
    e2e: usesE2eRunner(task.testCommand),
  };
  const orphans = testFiles.filter((p) => !_runnerMatchesFile(p, runners));
  if (orphans.length === 0) return;
  const declared = Object.entries(runners)
    .filter(([, on]) => on)
    .map(([k]) => `$TEST_${k.toUpperCase()}_COMMAND`)
    .join(' + ');
  errors.push(
    `Task ${task.num ?? '?'} \`### Test Command\` declares ${declared || '(no known runner)'} ` +
      `but CHANGED_FILES includes test files no declared runner will pick up: ` +
      orphans.map((p) => `"${p}"`).join(', ') +
      '. Integration tests MUST match `**/*.integration.(test|spec).<ext>` OR live under ' +
      '`**/integration/**/`. E2E tests MUST match `**/*.e2e.(test|spec).<ext>` OR live under ' +
      '`**/e2e/**/`. Unit tests must do NEITHER. Either rename the test file or add the matching ' +
      'runner to the chain (e.g. append ` && eval "$TEST_INTEGRATION_COMMAND"`).'
  );
}

/**
 * Verify the task's Test Command CHANGED_FILES list is fully covered by
 * this task's `### Files in scope` and follows runner naming conventions.
 *
 * @param {object} task
 * @returns {string[]} validation errors
 */
function validateTaskTestScope(task) {
  const errors = [];
  if (!task || typeof task !== 'object') return errors;
  if (_isCheckpointTask(task)) return errors;

  if (_checkNonTestCommand(task, errors)) return errors;

  const evalPairs = extractEvalScopePairs(task.testCommand);
  if (_checkUnscopedEvals(task, evalPairs, errors)) return errors;

  const changed = _collectChangedFiles(task, evalPairs);
  if (_checkHelperOnlyPattern(task, changed, errors)) return errors;
  if (changed.length === 0) return errors;

  _checkScopeMembership(task, changed, errors);
  _checkRunnerNamingConsistency(task, changed, errors);
  return errors;
}

module.exports = {
  validateTaskTestScope,
};
