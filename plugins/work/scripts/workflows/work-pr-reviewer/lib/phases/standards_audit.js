/**
 * Phase: standards_audit — deterministic TS-safety scan across the PR diff.
 * Same logic as code-checker but applied to the PR's files (reviewing
 * someone else's diff, not your own).
 */

'use strict';

const { PR_REVIEW_PHASES } = require('../../pr-review-phase-registry');
const { readChangedFiles, scanTypeScriptViolations } = require('../kind-checks/shared');

function validate(ctx) {
  const changed = readChangedFiles(ctx);
  const hits = scanTypeScriptViolations(ctx, changed);
  if (!hits.length) return { ok: true, summary: 'no TS safety violations in PR diff' };

  const critical = hits.filter((h) => /as any|as unknown|@ts-ignore/.test(h.pattern));
  if (critical.length) {
    return {
      ok: false,
      errors: [
        `Critical TS safety violations in PR (${critical.length}): ${critical
          .slice(0, 5)
          .map((h) => `${h.file}:${h.line} (${h.pattern})`)
          .join('; ')}${critical.length > 5 ? '; …' : ''}. Request changes — these block approval.`,
      ],
      summary: `${hits.length} ts hit(s), ${critical.length} critical`,
    };
  }
  return {
    ok: true,
    warnings: [
      `Non-critical TS hits (${hits.length}): ${hits
        .slice(0, 5)
        .map((h) => `${h.file}:${h.line} (${h.pattern})`)
        .join('; ')}${hits.length > 5 ? '; …' : ''}. Note in review.`,
    ],
    summary: `${hits.length} ts hit(s), 0 critical`,
  };
}

function instructions(ctx) {
  return [
    '# pr-review-next — Phase 4 of 8: STANDARDS AUDIT',
    `Ticket: ${ctx.ticket}`,
    '',
    'I scan the PR diff for non-negotiable TS safety violations: `as any`, `as unknown as`, `@ts-ignore` (block), and `: any` (warn).',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(PR_REVIEW_PHASES.standards_audit, {
    next: PR_REVIEW_PHASES.kind_checks,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
