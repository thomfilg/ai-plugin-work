/**
 * Kind: e2e — QA verification for end-to-end Playwright work.
 *
 * For e2e, the QA agent should have RUN the playwright spec (not just
 * read it). Looks for "### E2E QA" section with a passing test run
 * record (e.g. "1 passed" / "tests passed" / exit code).
 */

'use strict';

const { readQaReport, hasKindSection, checklistStats, detectKinds } = require('./shared');

function appliesTo(ctx) {
  return detectKinds(ctx.tasksDir).includes('e2e');
}

function validate(ctx) {
  const report = readQaReport(ctx.tasksDir);
  const errors = [];
  const warnings = [];
  if (!hasKindSection(report, 'E2E')) {
    errors.push(
      'qa-feature.check.md missing `### E2E QA` section. Add it with the playwright command run + passing-test confirmation.'
    );
    return { ok: false, errors, summary: 'no E2E QA section' };
  }
  const stats = checklistStats(report, 'E2E');
  if (stats.checked < stats.total) {
    errors.push(`E2E QA: ${stats.checked}/${stats.total} items checked.`);
  }
  if (!/passed|✓|pass\b/i.test(report)) {
    warnings.push(
      'E2E QA report contains no "passed" / "✓" evidence. Confirm the playwright run actually succeeded.'
    );
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `E2E QA: ${stats.checked}/${stats.total} checked`,
  };
}

module.exports = function register(registerKind) {
  registerKind('e2e', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
