/**
 * Kind: frontend — completion check for UI/component work.
 *
 * Completion criteria (different from code-checker — focuses on
 * "was the user-facing behavior delivered" not "is the code clean"):
 *  - Changed files contain at least one component / page / hook.
 *  - tasks.md acceptance criteria mention UI states (loading, empty, error)
 *    AND those states appear in the diff (or in test files).
 *  - No backend-schema file in the diff if brief says "no backend changes".
 */

'use strict';

const {
  readBrief,
  readChangedFiles,
  briefForbidsBackend,
  isFrontendFile,
  isBackendFile,
  detectKinds,
  readTasks,
} = require('./shared');

function appliesTo(ctx) {
  const kinds = detectKinds(ctx.tasksDir);
  return kinds.includes('frontend') || kinds.includes('fullstack');
}

const UI_STATE_WORDS = ['loading', 'empty', 'error'];

function validate(ctx) {
  const brief = readBrief(ctx.tasksDir);
  const tasks = readTasks(ctx.tasksDir).toLowerCase();
  const changed = readChangedFiles(ctx);
  const errors = [];
  const warnings = [];

  const frontendFiles = changed.filter(isFrontendFile);
  if (!frontendFiles.length) {
    warnings.push(
      'Frontend kind detected but the diff contains no component / page / hook file. Verify the UI was actually built.'
    );
  }

  for (const w of UI_STATE_WORDS) {
    if (tasks.includes(w)) {
      // Required state — verify diff actually mentions it somewhere.
      // Cheap heuristic: any frontend file path or test file referencing the word.
      const present = changed.some((f) => f.toLowerCase().includes(w));
      if (!present && frontendFiles.length) {
        warnings.push(
          `tasks.md mentions "${w}" state but no changed file name references it — confirm the state is implemented and tested.`
        );
      }
    }
  }

  if (briefForbidsBackend(brief)) {
    const drift = changed.filter(isBackendFile);
    if (drift.length) {
      errors.push(
        `Brief forbids backend changes but the diff contains backend files: ${drift.map((f) => `\`${f}\``).join(', ')}. Sibling-scope escape — BLOCK completion.`
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${changed.length} changed files (${frontendFiles.length} frontend)`,
  };
}

module.exports = function register(registerKind) {
  registerKind('frontend', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
module.exports.UI_STATE_WORDS = UI_STATE_WORDS;
