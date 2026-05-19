/**
 * Kind: fullstack — runs both frontend + backend code-quality checks.
 */

'use strict';

const frontend = require('./frontend');
const backend = require('./backend');
const { detectKinds } = require('./shared');

function appliesTo(ctx) {
  return detectKinds(ctx.tasksDir).includes('fullstack');
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
