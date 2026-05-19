/**
 * Kind: e2e — Playwright / journey tests.
 */

'use strict';

const path = require('node:path');
const {
  readSpec,
  filesInFilesToModify,
  isE2eFile,
  sliceSection,
  detectKinds,
} = require('./shared');

function appliesTo(ctx) {
  return detectKinds(ctx.tasksDir).includes('e2e');
}

function validate(ctx) {
  const spec = readSpec(ctx.tasksDir);
  const files = filesInFilesToModify(spec);
  const errors = [];
  const warnings = [];

  if (!files.some(isE2eFile)) {
    errors.push(
      'e2e kind but no `tests/e2e/**/*.spec.(ts|tsx)` file listed in `## Files to Create/Modify`.'
    );
  }

  // Look for the Gherkin section / scenarios with @e2e tag — gherkin.feature
  // is a sibling artifact under tasksDir.
  const fs = require('node:fs');
  const gherkin = (() => {
    try {
      return fs.readFileSync(path.join(ctx.tasksDir, 'gherkin.feature'), 'utf8');
    } catch {
      return '';
    }
  })();
  if (gherkin && !/@e2e\b/.test(gherkin)) {
    errors.push('e2e kind but `gherkin.feature` has no scenario tagged `@e2e`.');
  } else if (!gherkin) {
    warnings.push(
      'No gherkin.feature file present — Gherkin coverage will be checked by spec_gate separately.'
    );
  }

  if (!/journey|page[-\s]?object/i.test(spec)) {
    warnings.push(
      'spec.md does not mention "journey" or "page object" — confirm reusable helpers are used.'
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${files.filter(isE2eFile).length} e2e file(s) listed`,
  };
}

module.exports = function register(registerKind) {
  registerKind('e2e', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
