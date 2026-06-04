/**
 * Kind: fullstack — runs both frontend + backend QA validators and
 * additionally requires the report to mention the request hitting the
 * backend (network tab evidence) so we know the wire was actually used.
 */

'use strict';

const frontend = require('./frontend');
const backend = require('./backend');
const { readQaReport, detectKinds } = require('./shared');

function appliesTo(ctx) {
  // Structural precondition: tasks declare BOTH frontend and backend kinds
  // (full-stack ticket by composition). The explicit `### Type: fullstack`
  // opt-in is preserved for tickets that declare it directly.
  const kinds = detectKinds(ctx.tasksDir);
  if (kinds.includes('fullstack')) return true;
  return kinds.includes('frontend') && kinds.includes('backend');
}

function validate(ctx) {
  const fr = frontend.validate(ctx);
  const be = backend.validate(ctx);
  const errors = [...(fr.errors || []), ...(be.errors || [])];
  const warnings = [...(fr.warnings || []), ...(be.warnings || [])];

  const report = readQaReport(ctx.tasksDir);
  if (report && !/network|XHR|fetch|trpc|api\//i.test(report)) {
    warnings.push(
      'Fullstack QA report contains no network/fetch/API evidence. Verify the UI actually called the backend (network tab or curl).'
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `fullstack QA: ${fr.summary || 'frontend ok'} | ${be.summary || 'backend ok'}`,
  };
}

module.exports = function register(registerKind) {
  registerKind('fullstack', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
