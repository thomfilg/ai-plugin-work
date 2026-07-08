/**
 * Kind: devops — completion check for infra / CI work.
 *
 * Completion criteria:
 *  - All changed files are devops-shaped (.github/, scripts/, *.yml,
 *    Dockerfile). Any app-source file in the diff is a cross-kind escape.
 *  - At least one devops file must be present (otherwise this kind didn't
 *    actually do anything).
 */

'use strict';

const { readChangedFiles, isDevopsFile, isAppSourceFile, detectKinds } = require('./shared');

function appliesTo(ctx) {
  return detectKinds(ctx.tasksDir).includes('devops');
}

function validate(ctx) {
  const changed = readChangedFiles(ctx);
  const errors = [];
  const warnings = [];

  const devopsFiles = changed.filter(isDevopsFile);
  if (!devopsFiles.length) {
    warnings.push(
      'DevOps kind detected but diff contains no infra file (`.github/`, `scripts/`, `*.yml`, Dockerfile). Verify infra work actually shipped.'
    );
  }

  const appDrift = changed.filter(isAppSourceFile);
  if (appDrift.length) {
    errors.push(
      `DevOps kind but diff contains app-source files: ${appDrift
        .map((f) => `\`${f}\``)
        .join(', ')}. Cross-kind escape — split into a separate ticket or reclassify the work.`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${devopsFiles.length} devops file(s), ${appDrift.length} app-source drift`,
  };
}

module.exports = function register(registerKind) {
  registerKind('devops', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
