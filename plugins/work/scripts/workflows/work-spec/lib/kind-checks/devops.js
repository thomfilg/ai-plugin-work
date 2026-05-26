/**
 * Kind: devops — infra / CI / scripts only.
 *
 * Verifies the spec touches only `.github/`, `scripts/`, infra config files.
 * Any `app/`, `lib/`, or `components/` change is flagged as a cross-kind
 * escape (devops tickets should not silently change app source).
 */

'use strict';

const {
  readSpec,
  filesInFilesToModify,
  isDevopsFile,
  isAppSourceFile,
  detectKinds,
} = require('./shared');

function appliesTo(ctx) {
  return detectKinds(ctx.tasksDir).includes('devops');
}

function validate(ctx) {
  const spec = readSpec(ctx.tasksDir);
  const files = filesInFilesToModify(spec);
  const errors = [];
  const warnings = [];

  const appDrift = files.filter(isAppSourceFile);
  if (appDrift.length) {
    errors.push(
      `devops kind but spec lists app-source files: ${appDrift.map((f) => `\`${f}\``).join(', ')}. Either split the ticket or remove the cross-kind escape.`
    );
  }
  if (!files.some(isDevopsFile)) {
    warnings.push(
      'devops kind but no infra file (`.github/`, `scripts/`, `*.yml`, `Dockerfile`) listed.'
    );
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${files.filter(isDevopsFile).length} infra file(s) / ${appDrift.length} app-drift`,
  };
}

module.exports = function register(registerKind) {
  registerKind('devops', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
