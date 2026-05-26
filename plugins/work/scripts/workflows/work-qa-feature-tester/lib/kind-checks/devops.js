/**
 * Kind: devops — QA verification for infra / CI work.
 *
 * For devops, the agent should have triggered the workflow / run the
 * deployment / exercised the script. Looks for "### DevOps QA" with
 * either a CI run URL or a local script-run record.
 */

'use strict';

const { readQaReport, hasKindSection, checklistStats, detectKinds } = require('./shared');

function appliesTo(ctx) {
  return detectKinds(ctx.tasksDir).includes('devops');
}

function validate(ctx) {
  const report = readQaReport(ctx.tasksDir);
  const errors = [];
  const warnings = [];
  if (!hasKindSection(report, 'DevOps')) {
    errors.push(
      'qa-feature.check.md missing `### DevOps QA` section. Add it with the workflow trigger / script run + result.'
    );
    return { ok: false, errors, summary: 'no DevOps QA section' };
  }
  const stats = checklistStats(report, 'DevOps');
  if (stats.checked < stats.total) {
    errors.push(`DevOps QA: ${stats.checked}/${stats.total} items checked.`);
  }
  if (!/(github\.com\/.+\/actions\/runs\/\d+|\$\s|exit\s+(code\s+)?0)/i.test(report)) {
    warnings.push(
      'DevOps QA report has no CI run URL nor visible command/exit-code evidence. Confirm the workflow actually executed.'
    );
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `DevOps QA: ${stats.checked}/${stats.total} checked`,
  };
}

module.exports = function register(registerKind) {
  registerKind('devops', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
