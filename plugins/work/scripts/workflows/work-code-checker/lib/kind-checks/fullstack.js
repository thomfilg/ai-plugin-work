/**
 * Kind: fullstack — runs both frontend + backend code-quality checks.
 */

'use strict';

const frontend = require('./frontend');
const backend = require('./backend');
const { detectKinds, readChangedFiles, isFrontendFile, isBackendFile } = require('./shared');

function appliesTo(ctx) {
  // Structural precondition: the diff contains BOTH frontend and backend
  // files. Not gated purely on `### Type: fullstack`, which conflicts
  // with the per-task model where authors declare frontend + backend
  // separately. Also fires when both kinds are explicitly declared.
  const kinds = detectKinds(ctx.tasksDir);
  if (kinds.includes('fullstack')) return true;
  if (kinds.includes('frontend') && kinds.includes('backend')) return true;
  const changed = readChangedFiles(ctx);
  return changed.some(isFrontendFile) && changed.some(isBackendFile);
}

function validate(ctx) {
  const fr = frontend.validate(ctx);
  const be = backend.validate(ctx);
  const errors = [...(fr.errors || []), ...(be.errors || [])];
  const warnings = [...(fr.warnings || []), ...(be.warnings || [])];
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
