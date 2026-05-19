/**
 * Phase: description_draft — agent produces `pr-body.md` with the
 * canonical sections. The agent should use the pr-generator skill/agent to
 * fill this in, but the gate is on the artifact, not the path to it.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { PR_PHASES } = require('../../pr-phase-registry');

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function validate(ctx) {
  const p = path.join(ctx.tasksDir, 'pr-body.md');
  const body = readFile(p);
  if (!body) return { ok: false, errors: [`Missing ${p}. Draft the PR description here.`] };
  if (body.trim().length < 80) {
    return {
      ok: false,
      errors: [`pr-body.md is too short (< 80 chars). Flesh out the description.`],
    };
  }
  return { ok: true, summary: `${body.length} chars` };
}

function instructions(ctx) {
  return [
    `# pr-next — Phase 3 of 8: DESCRIPTION DRAFT`,
    `Ticket: ${ctx.ticket}`,
    '',
    '### What you do',
    `Create or update \`${path.join(ctx.tasksDir, 'pr-body.md')}\` with the PR body.`,
    '',
    'Suggested structure (validate_description phase will enforce):',
    '',
    '```markdown',
    '## Summary',
    '<1-3 bullets — what + why>',
    '',
    '## Test plan',
    '- [ ] <how to verify>',
    '',
    '## Linked tickets',
    '- ECHO-XXXX',
    '```',
    '',
    "Use the pr-generator agent (`Task(work-workflow:pr-generator)`) to draft from the diff if you want — that's the canonical path. Then save its output to `pr-body.md`.",
    '',
  ].join('\n');
}

module.exports = function register(r) {
  r(PR_PHASES.description_draft, {
    next: PR_PHASES.validate_description,
    validate,
    instructions,
  });
};
module.exports.validate = validate;
module.exports.instructions = instructions;
