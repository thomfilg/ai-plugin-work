/**
 * Phase: requirements_extract — confirm that the agent has produced a
 * requirements list to verify against. Reads brief.md P0/P1 bullets and
 * tasks.md Requirement Coverage table, and writes a snapshot into
 * `completion-context.json` for downstream phases.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { COMPLETION_PHASES } = require('../../completion-phase-registry');
const { readBriefRequirements, readRequirementCoverage } = require('../kind-checks/shared');

const CTX_FILE = 'completion-context.json';

function validate(ctx) {
  const reqs = readBriefRequirements(ctx.tasksDir);
  const coverage = readRequirementCoverage(ctx.tasksDir);
  if (!reqs.length && !coverage.length) {
    return {
      ok: false,
      errors: [
        'No requirements found. brief.md has no `## Requirements` / `## Must-have` bullets AND tasks.md has no `## Requirement Coverage` table. Cannot verify completion.',
      ],
    };
  }
  try {
    fs.writeFileSync(
      path.join(ctx.tasksDir, CTX_FILE),
      JSON.stringify(
        { requirements: reqs, coverage, snapshotAt: new Date().toISOString() },
        null,
        2
      )
    );
  } catch {
    /* hook-gated; non-fatal */
  }
  return {
    ok: true,
    summary: `${reqs.length} brief req(s), ${coverage.length} coverage row(s)`,
  };
}

function instructions(ctx) {
  return [
    '# completion-next — Phase 2 of 8: REQUIREMENTS EXTRACT',
    `Ticket: ${ctx.ticket}`,
    '',
    'I read `## Requirements` (or `## Must-have`) bullets from brief.md and the `## Requirement Coverage` table from tasks.md, then snapshot them into `completion-context.json`. Both sources feed downstream coverage checks.',
    '',
    'If both are missing, add at least one of:',
    '- a `## Requirements` section in brief.md with `- P0: …` bullets',
    '- a `## Requirement Coverage` table in tasks.md with columns: ID | Requirement | Status | Evidence',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(COMPLETION_PHASES.requirements_extract, {
    next: COMPLETION_PHASES.diff_scope,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.CTX_FILE = CTX_FILE;
