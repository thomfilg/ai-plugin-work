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
const { gateContractFor } = require('../../../skills/split-in-tasks/lib/task-types');

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

// Signals in a task's deliverables/gherkin that it authors tests: an explicit
// RED phase or language about writing/adding failing tests.
const _TEST_AUTHORING_RE =
  /\*\*RED:\*\*|\bRED phase\b|\b(?:add|write|writing|author)(?:ing)?\b[^\n]*\b(?:failing\s+)?(?:unit\s+|integration\s+|e2e\s+)?tests?\b|\bfailing\s+(?:unit\s+|integration\s+|e2e\s+)?tests?\b/i;

/**
 * Returns true when the implement-time RED gate would actually require a
 * `*.test.*` / `*.spec.*` file to exist for this task — i.e. the task's Type
 * has `redRequiresTestFiles === true` in the central `gateContractFor`
 * contract (only `tdd-code`, plus the unknown/freeform fail-closed fallback).
 *
 * This is the single source of truth shared with the implement-time gate
 * (task-next.js / tdd-phase-state.js). Types the contract exempts from
 * RED test-file discovery (`tests-only`, `docs`, `config`, `ci`,
 * `mechanical-refactor`, `file-move`, `checkpoint`) commonly use a `**RED:**`
 * line for verification commands without authoring a test file, so the
 * authoring-time guard MUST NOT flag them — RED would not deadlock there.
 *
 * @param {object} task
 * @returns {boolean}
 */
function _redRequiresTestFile(task) {
  return gateContractFor(task.type).redRequiresTestFiles === true;
}

// Mirrors task-next.js `isVisualOnlyTask`: a task whose `### Files in scope`
// consists exclusively of `.stories.[jt]sx?` entries is a visual-only Storybook
// task. Story files have no executable assertions, so the implement-time RED
// gate exempts them from `*.test.*` authorship discovery (see split-in-tasks
// SKILL.md Rule 10). The authoring-time guard MUST honour the same exemption or
// a stories-only task passes `task-next.js` RED but fails tasks-gate.
function _isVisualOnlyScope(task) {
  const scope = Array.isArray(task.filesInScope) ? task.filesInScope : [];
  if (scope.length === 0) return false;
  return scope.every((p) => typeof p === 'string' && /\.stories\.[jt]sx?$/i.test(p));
}

/**
 * Returns true when this task's deliverables imply it authors test files
 * (so the RED gate will expect a `*.test.*` / `*.spec.*` to exist).
 *
 * @param {object} task
 * @returns {boolean}
 */
function _impliesTestAuthorship(task) {
  if (!_redRequiresTestFile(task)) return false;
  if (_isVisualOnlyScope(task)) return false;
  const body = typeof task.rawContent === 'string' ? task.rawContent : '';
  return _TEST_AUTHORING_RE.test(body);
}

// Mirrors task-next.js `findTestFilesInScope` colocation branch: for a concrete
// (non-glob) source file listed in scope, a colocated `<base>.test.<ext>` /
// `<base>.spec.<ext>` sibling that exists ON DISK in the same directory
// satisfies the implement-time RED discovery even when that sibling is not
// itself listed in `### Files in scope`. The authoring-time guard honours the
// same discovery so it is never stricter than the gate it protects. Glob
// entries are skipped (findTestFilesInScope also skips them — a literal
// `fs.existsSync` on a glob string fails). Returns false when `repoRoot` is
// not supplied (hermetic callers keep the conservative explicit-listing check).
//
// @param {string} abs absolute path to a concrete source file
// @returns {boolean} true when a `<base>.test.*` / `<base>.spec.*` sibling exists
function _colocatedSiblingExists(abs) {
  const fs = require('fs');
  const path = require('path');
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const base = path.basename(abs, path.extname(abs));
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const colocatedRe = new RegExp('^' + escaped + '\\.(test|spec)\\.(?:m?[cj]sx?|tsx?)$');
  let entries;
  try {
    entries = fs.readdirSync(path.dirname(abs), { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((e) => e.isFile() && colocatedRe.test(e.name));
}

// @param {string[]} scope
// @param {string|undefined} repoRoot
// @returns {boolean}
function _hasColocatedTestOnDisk(scope, repoRoot) {
  if (!repoRoot || typeof repoRoot !== 'string') return false;
  const path = require('path');
  return scope.some((rel) => {
    if (typeof rel !== 'string' || /[*?[\]{}]/.test(rel)) return false; // skip globs
    if (TEST_FILE_EXT_RE.test(rel)) return false; // explicit test files handled by caller
    return _colocatedSiblingExists(path.join(repoRoot, rel));
  });
}

/**
 * Authoring-time guard (GH-491 R3/R6): a TDD-required task whose gherkin
 * implies test authorship MUST have a `*.test.*` / `*.spec.*` the implement-time
 * RED gate can discover. RED discovers tests either from an explicit entry in
 * `### Files in scope` OR — mirroring `findTestFilesInScope` — from a colocated
 * test sibling on disk next to a source file in scope. The guard fires only when
 * NEITHER is present, so it is never stricter than the gate it protects. Pushes
 * an error naming the task number and instructing the author to add (or colocate)
 * the test file.
 *
 * @param {object} task
 * @param {string[]} errors
 * @param {string|undefined} repoRoot optional repo root for colocation discovery
 */
function _checkTddTaskOwnsTestFile(task, errors, repoRoot) {
  if (!_impliesTestAuthorship(task)) return;
  const scope = Array.isArray(task.filesInScope) ? task.filesInScope : [];
  const hasTestFile = scope.some((p) => typeof p === 'string' && TEST_FILE_EXT_RE.test(p));
  if (hasTestFile) return;
  if (_hasColocatedTestOnDisk(scope, repoRoot)) return;
  errors.push(
    `Task ${task.num ?? '?'} is a TDD task whose deliverables author tests, but its ` +
      '`### Files in scope` lists no test file (no `*.test.*` / `*.spec.*` path) and no ' +
      'source file in scope has a colocated test sibling on disk. The implement-time RED ' +
      'gate discovers the failing test from `### Files in scope` (or a colocated ' +
      '`<name>.test.*` next to a source file in scope), so with neither present the gate ' +
      'has nothing to run and the task deadlocks. Add this task’s own test file to ' +
      '`### Files in scope` (it must own BOTH the test file and the impl file it tests — ' +
      'see split-in-tasks decomposition Rule 10). If this task authors no test of its ' +
      'own, MERGE IT INTO THE CONSUMING TASK (split-in-tasks SKILL.md Rule 4b).'
  );
}

/**
 * Verify the task's Test Command CHANGED_FILES list is fully covered by
 * this task's `### Files in scope` and follows runner naming conventions.
 *
 * @param {object} task
 * @param {string} [repoRoot=process.cwd()] repo root; the own-test guard also
 *   honours colocated test siblings on disk (mirrors the implement-time
 *   `findTestFilesInScope` discovery). Defaults to the process cwd (the repo
 *   root during `/work`); pass `''` for a hermetic explicit-listing-only check.
 * @returns {string[]} validation errors
 */
function validateTaskTestScope(task, repoRoot = process.cwd()) {
  const errors = [];
  if (!task || typeof task !== 'object') return errors;
  if (_isCheckpointTask(task)) return errors;

  _checkTddTaskOwnsTestFile(task, errors, repoRoot);

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
