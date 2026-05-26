/**
 * Kind: fullstack — completion check that runs both frontend + backend
 * validators AND verifies frontend changes have matching backend changes
 * (no "UI without API" or "API without UI" drift).
 */

'use strict';

const frontend = require('./frontend');
const backend = require('./backend');
const { readChangedFiles, isFrontendFile, isBackendFile, detectKinds } = require('./shared');

function appliesTo(ctx) {
  return detectKinds(ctx.tasksDir).includes('fullstack');
}

function validate(ctx) {
  const fr = frontend.validate(ctx);
  const be = backend.validate(ctx);

  const errors = [...(fr.errors || []), ...(be.errors || [])];
  const warnings = [...(fr.warnings || []), ...(be.warnings || [])];

  const changed = readChangedFiles(ctx);
  const hasFrontend = changed.some(isFrontendFile);
  const hasBackend = changed.some(isBackendFile);
  if (hasFrontend && !hasBackend) {
    warnings.push(
      'Fullstack kind but diff has frontend changes only — verify the matching backend work shipped (or is intentionally deferred).'
    );
  } else if (hasBackend && !hasFrontend) {
    warnings.push(
      'Fullstack kind but diff has backend changes only — verify the matching frontend work shipped (or is intentionally deferred).'
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `fullstack: ${fr.summary || 'frontend ok'} | ${be.summary || 'backend ok'}`,
  };
}

module.exports = function register(registerKind) {
  registerKind('fullstack', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
