/**
 * Kind: frontend — QA verification for UI work.
 *
 * Verifies the report has a "### Frontend QA" section with completed
 * checklist items covering UI states (loading / empty / error / success).
 */

'use strict';

const { readQaReport, hasKindSection, checklistStats, detectKinds } = require('./shared');

const REQUIRED_STATES = ['loading', 'empty', 'error', 'success'];

function appliesTo(ctx) {
  const k = detectKinds(ctx.tasksDir);
  return k.includes('frontend') || k.includes('fullstack');
}

function validate(ctx) {
  const report = readQaReport(ctx.tasksDir);
  const errors = [];
  const warnings = [];
  if (!hasKindSection(report, 'Frontend')) {
    errors.push(
      'qa-feature.check.md missing `### Frontend QA` section. Add it with checklist items for loading/empty/error/success states.'
    );
    return {
      ok: false,
      errors,
      summary: 'no Frontend QA section',
    };
  }
  const stats = checklistStats(report, 'Frontend');
  if (stats.total < REQUIRED_STATES.length) {
    warnings.push(
      `Frontend QA section has only ${stats.total} checklist item(s); expected at least ${REQUIRED_STATES.length} (one per UI state).`
    );
  }
  if (stats.checked < stats.total) {
    errors.push(
      `Frontend QA: ${stats.checked}/${stats.total} items checked. Drive each state in the browser and check the box.`
    );
  }
  const reportLower = report.toLowerCase();
  for (const s of REQUIRED_STATES) {
    if (!reportLower.includes(s)) {
      warnings.push(`Frontend QA report does not mention "${s}" state — verify it was exercised.`);
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `Frontend QA: ${stats.checked}/${stats.total} checked`,
  };
}

module.exports = function register(registerKind) {
  registerKind('frontend', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
module.exports.REQUIRED_STATES = REQUIRED_STATES;
