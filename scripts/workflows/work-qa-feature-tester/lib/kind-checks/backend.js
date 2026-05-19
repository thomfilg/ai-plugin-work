/**
 * Kind: backend — QA verification for API / data-layer work.
 *
 * Looks for "### Backend QA" section with happy-path + error-path tests,
 * each citing the API endpoint and the HTTP response status.
 */

'use strict';

const { readQaReport, hasKindSection, checklistStats, detectKinds } = require('./shared');

function appliesTo(ctx) {
  const k = detectKinds(ctx.tasksDir);
  return k.includes('backend') || k.includes('fullstack');
}

function validate(ctx) {
  const report = readQaReport(ctx.tasksDir);
  const errors = [];
  const warnings = [];
  if (!hasKindSection(report, 'Backend')) {
    errors.push(
      'qa-feature.check.md missing `### Backend QA` section. Add checklist items for happy path + at least one error response, with the curl command and HTTP status code cited.'
    );
    return {
      ok: false,
      errors,
      summary: 'no Backend QA section',
    };
  }
  const stats = checklistStats(report, 'Backend');
  if (stats.checked < stats.total) {
    errors.push(
      `Backend QA: ${stats.checked}/${stats.total} items checked. Run each curl/request and confirm the response.`
    );
  }
  // Cheap signal: at least one HTTP status code mentioned (2xx/4xx/5xx).
  if (!/\b[2345]\d{2}\b/.test(report)) {
    warnings.push(
      'Backend QA report mentions no HTTP status codes (2xx/4xx/5xx). Verify responses were actually inspected.'
    );
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `Backend QA: ${stats.checked}/${stats.total} checked`,
  };
}

module.exports = function register(registerKind) {
  registerKind('backend', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
