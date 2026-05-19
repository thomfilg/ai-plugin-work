/**
 * Kind: wiring — QA verification for "connect-existing-pieces" tickets.
 *
 * For wiring, the test should verify the integration: data flows end-to-end
 * from the source (sibling API) to the consumer (UI) without breaking
 * either side.
 */

'use strict';

const {
  readQaReport,
  hasKindSection,
  checklistStats,
  briefForbidsBackend,
  readBrief,
  detectKinds,
} = require('./shared');

function appliesTo(ctx) {
  const k = detectKinds(ctx.tasksDir);
  if (k.includes('wiring')) return true;
  const brief = readBrief(ctx.tasksDir);
  return briefForbidsBackend(brief) && k.length === 0;
}

function validate(ctx) {
  const report = readQaReport(ctx.tasksDir);
  const errors = [];
  if (!hasKindSection(report, 'Wiring')) {
    errors.push(
      'qa-feature.check.md missing `### Wiring QA` section. Add checklist items verifying data flows end-to-end (sibling API → consumer UI) without modifying sibling-owned code.'
    );
    return { ok: false, errors, summary: 'no Wiring QA section' };
  }
  const stats = checklistStats(report, 'Wiring');
  if (stats.checked < stats.total) {
    errors.push(
      `Wiring QA: ${stats.checked}/${stats.total} items checked. Confirm each integration point in the browser/network tab.`
    );
  }
  return {
    ok: errors.length === 0,
    errors,
    summary: `Wiring QA: ${stats.checked}/${stats.total} checked`,
  };
}

module.exports = function register(registerKind) {
  registerKind('wiring', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
