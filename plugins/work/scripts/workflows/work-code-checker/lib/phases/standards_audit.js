/**
 * Phase: standards_audit — deterministic TypeScript safety scan across
 * the entire diff. Blocks on any `as any` / `as unknown as` / `@ts-ignore`
 * / `@ts-expect-error (bare)` / `: any` — these violate non-negotiable
 * standards from agents/code-checker.md and don't need agent judgment.
 *
 * Other smell categories (smells, SOLID, reuse) stay agent-driven and are
 * enforced via the `## Policy Compliance Summary` table in report.js.
 */

'use strict';

const { CODE_PHASES } = require('../../code-phase-registry');
const { readChangedFiles, scanTypeScriptViolations } = require('../kind-checks/shared');

function validate(ctx) {
  const changed = readChangedFiles(ctx);
  const hits = scanTypeScriptViolations(ctx, changed);
  if (!hits.length) return { ok: true, summary: 'no TS safety violations in diff' };

  const critical = hits.filter((h) => /as any|as unknown|@ts-ignore/.test(h.pattern));
  if (critical.length) {
    return {
      ok: false,
      errors: [
        `Critical TS safety violations (${critical.length}): ${critical
          .slice(0, 5)
          .map((h) => `${h.file}:${h.line} (${h.pattern})`)
          .join('; ')}${critical.length > 5 ? '; …' : ''}. Fix or document each justification.`,
      ],
      summary: `${hits.length} ts hit(s), ${critical.length} critical`,
    };
  }

  return {
    ok: true,
    warnings: [
      `Non-critical TS safety hits (${hits.length}): ${hits
        .slice(0, 5)
        .map((h) => `${h.file}:${h.line} (${h.pattern})`)
        .join('; ')}${hits.length > 5 ? '; …' : ''}. Review and reduce where possible.`,
    ],
    summary: `${hits.length} ts hit(s), 0 critical`,
  };
}

function instructions(ctx) {
  return [
    '# code-next — Phase 4 of 8: STANDARDS AUDIT (TS safety)',
    `Ticket: ${ctx.ticket}`,
    '',
    'I deterministically scan the diff for the non-negotiable TS-safety violations from agents/code-checker.md:',
    '- `as any` / `as unknown as` / `@ts-ignore` (critical — block)',
    '- `: any` (warn, fix where possible)',
    '',
    'Other smell categories (SOLID, reuse, naming) are reviewed by you in the report.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(CODE_PHASES.standards_audit, {
    next: CODE_PHASES.kind_checks,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
