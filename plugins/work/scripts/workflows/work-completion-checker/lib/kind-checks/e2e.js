/**
 * Kind: e2e — completion check for end-to-end test work.
 *
 * Completion criteria:
 *  - Diff contains at least one Playwright spec under tests/e2e/.
 *  - tasks.md or spec.md references at least one @e2e Gherkin scenario or
 *    journey identifier.
 */

'use strict';

const { readChangedFiles, readSpec, readTasks, isE2eFile, detectKinds } = require('./shared');

function appliesTo(ctx) {
  return detectKinds(ctx.tasksDir).includes('e2e');
}

function validate(ctx) {
  const changed = readChangedFiles(ctx);
  const errors = [];
  const warnings = [];

  const e2eFiles = changed.filter(isE2eFile);
  if (!e2eFiles.length) {
    errors.push(
      'E2E kind detected but diff contains no Playwright spec file under `tests/e2e/`. E2E work must ship a spec.'
    );
  }

  const combined = `${readSpec(ctx.tasksDir)}\n${readTasks(ctx.tasksDir)}`;
  if (!/@e2e\b/i.test(combined)) {
    warnings.push(
      'No `@e2e` tagged scenario found in spec.md / tasks.md. Verify the journey is wired to a tagged Gherkin scenario.'
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${e2eFiles.length} e2e spec file(s) in diff`,
  };
}

module.exports = function register(registerKind) {
  registerKind('e2e', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
