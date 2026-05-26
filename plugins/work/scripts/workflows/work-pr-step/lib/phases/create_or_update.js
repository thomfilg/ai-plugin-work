/**
 * Phase: create_or_update — agent runs `gh pr create` or `gh pr edit` with
 * pr-body.md. Gate checks that `pr-context.json` records a `prNumber`.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { PR_PHASES } = require('../../pr-phase-registry');

function readContext(tasksDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(tasksDir, 'pr-context.json'), 'utf8'));
  } catch {
    return null;
  }
}

function validate(ctx) {
  const pctx = readContext(ctx.tasksDir);
  if (!pctx) return { ok: false, errors: [`Missing pr-context.json (re-run diff_audit).`] };
  if (!pctx.prNumber || typeof pctx.prNumber !== 'number') {
    return {
      ok: false,
      errors: [
        `pr-context.json has no \`prNumber\`. After running \`gh pr create -F pr-body.md\` (or \`gh pr edit\` if it already exists), update pr-context.json with the returned PR number.`,
      ],
    };
  }
  return { ok: true, summary: `PR #${pctx.prNumber} recorded` };
}

function instructions(ctx) {
  return [
    `# pr-next — Phase 5 of 8: CREATE OR UPDATE`,
    `Ticket: ${ctx.ticket}`,
    '',
    '### What you do',
    `1. Read pr-body.md from ${path.join(ctx.tasksDir, 'pr-body.md')}.`,
    '2. Determine create vs update: `gh pr view --json number 2>/dev/null | jq -r .number` returns the existing PR number if any.',
    `3. Create: \`gh pr create --title "..." --body-file ${path.join(ctx.tasksDir, 'pr-body.md')}\``,
    `   OR update: \`gh pr edit <NUMBER> --body-file ${path.join(ctx.tasksDir, 'pr-body.md')}\``,
    '4. Patch pr-context.json with `{ "prNumber": <number>, "url": "<gh url>" }`.',
    '',
    'Re-invoke me to verify the prNumber was recorded.',
    '',
  ].join('\n');
}

module.exports = function register(r) {
  r(PR_PHASES.create_or_update, {
    next: PR_PHASES.attachments,
    validate,
    instructions,
  });
};
module.exports.validate = validate;
module.exports.instructions = instructions;
