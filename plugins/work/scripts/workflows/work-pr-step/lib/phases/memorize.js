/**
 * Phase: memorize — persist PR decisions to memory plugin if installed.
 * Sentinel: `<!-- pr-memorized -->` in pr-body.md.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { PR_PHASES } = require('../../pr-phase-registry');

const SENTINEL = '<!-- pr-memorized -->';

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function validate(ctx) {
  if (!ctx.memory) return { ok: true, summary: 'no memory plugin — auto-passing' };
  const body = readFile(path.join(ctx.tasksDir, 'pr-body.md'));
  if (!body) return { ok: false, errors: [`Missing pr-body.md.`] };
  if (!body.includes(SENTINEL)) {
    return {
      ok: false,
      errors: [
        `pr-body.md is missing \`${SENTINEL}\`. After saving PR-creation decisions (PR number, base branch, key trade-offs from the description) via \`${ctx.memory.rememberTool}\`, append \`${SENTINEL}\` to pr-body.md.`,
      ],
    };
  }
  return { ok: true, summary: 'PR decisions memorized' };
}

function instructions(ctx) {
  if (!ctx.memory) {
    return [`# pr-next — Phase 7 of 8: MEMORIZE`, '', 'No memory plugin. Auto-advancing.', ''].join(
      '\n'
    );
  }
  return [
    `# pr-next — Phase 7 of 8: MEMORIZE (${ctx.memory.name})`,
    `Ticket: ${ctx.ticket}`,
    '',
    `Call \`${ctx.memory.rememberTool}\` with the PR number, base branch, and any non-obvious trade-offs documented in pr-body.md. Then append \`${SENTINEL}\` to pr-body.md.`,
    '',
    'Re-invoke me to verify.',
    '',
  ].join('\n');
}

module.exports = function register(r) {
  r(PR_PHASES.memorize, {
    next: PR_PHASES.done,
    validate,
    instructions,
  });
};
module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.SENTINEL = SENTINEL;
