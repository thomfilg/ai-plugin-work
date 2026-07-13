/**
 * Kind: fullstack — runs both frontend + backend PR review validators.
 */

'use strict';

const frontend = require('./frontend');
const backend = require('./backend');
const { detectKinds, readChangedFiles, isFrontendFile, isBackendFile } = require('./shared');

function appliesTo(ctx) {
  // Structural precondition: PR diff contains BOTH frontend and backend
  // files. Per-task model authors declare frontend + backend separately
  // (not `### Type: fullstack`), so file-mix is the reliable signal.
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
    summary: `fullstack PR: ${fr.summary || 'frontend ok'} | ${be.summary || 'backend ok'}`,
  };
}

module.exports = function register(registerKind) {
  registerKind('fullstack', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
