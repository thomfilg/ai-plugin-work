/**
 * Kind: fullstack — per-task convenience runner: frontend + backend.
 */

'use strict';

const frontend = require('./frontend');
const backend = require('./backend');
const { detectKinds, readChangedFiles, isFrontendFile, isBackendFile } = require('./shared');

function appliesTo(ctx) {
  if (detectKinds(ctx.tasksDir).includes('fullstack')) return true;
  const changed = readChangedFiles(ctx);
  return changed.some(isFrontendFile) && changed.some(isBackendFile);
}

function validate(ctx) {
  const fe = frontend.validate(ctx);
  const be = backend.validate(ctx);
  const errors = [...(fe.errors || []), ...(be.errors || [])];
  const warnings = [...(fe.warnings || []), ...(be.warnings || [])];
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `fullstack — fe: ${fe.summary}; be: ${be.summary}`,
  };
}

module.exports = function register(registerKind) {
  registerKind('fullstack', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
