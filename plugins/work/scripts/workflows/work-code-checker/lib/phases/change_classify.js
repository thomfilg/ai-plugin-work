/**
 * Phase: change_classify — the agent must classify the change type
 * (new feature / bug fix / refactor / rename) before judging. Per
 * agents/code-checker.md: "All TDD, reuse, and scope expectations follow
 * from this classification."
 *
 * Gate is on the agent having written `code-review.check.md` with a
 * `Change Type:` line in the first 80 lines.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { CODE_PHASES } = require('../../code-phase-registry');

const VALID_TYPES = ['new feature', 'bug fix', 'refactor', 'rename', 'formatting', 'comments-only'];

function readHead(p, lines) {
  try {
    return fs.readFileSync(p, 'utf8').split('\n').slice(0, lines).join('\n');
  } catch {
    return null;
  }
}

function validate(ctx) {
  const p = path.join(ctx.tasksDir, 'code-review.check.md');
  const head = readHead(p, 80);
  if (!head) {
    return {
      ok: false,
      errors: [
        `Missing ${p}. Start the report with at least a \`Change Type: <type>\` line and a one-sentence justification.`,
      ],
    };
  }
  const m = head.match(/Change\s*Type\s*:\s*([a-zA-Z ./-]+)/i);
  if (!m) {
    return {
      ok: false,
      errors: [
        'code-review.check.md is missing the `Change Type:` line in its first 80 lines. Add e.g. `Change Type: new feature`.',
      ],
    };
  }
  const classified = m[1].toLowerCase().trim();
  if (!VALID_TYPES.some((t) => classified.includes(t))) {
    return {
      ok: false,
      errors: [`Change Type "${classified}" not recognized. Valid: ${VALID_TYPES.join(', ')}.`],
    };
  }
  return { ok: true, summary: `change type: ${classified}` };
}

function instructions(ctx) {
  return [
    '# code-next — Phase 2 of 8: CHANGE CLASSIFY',
    `Ticket: ${ctx.ticket}`,
    '',
    `Per agents/code-checker.md, classification drives TDD/reuse/scope expectations. Add a line near the top of \`${path.join(ctx.tasksDir, 'code-review.check.md')}\`:`,
    '',
    '```',
    'Change Type: new feature  | bug fix | refactor | rename | formatting | comments-only',
    'Justification: <one sentence>',
    '```',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(CODE_PHASES.change_classify, {
    next: CODE_PHASES.file_coverage,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.VALID_TYPES = VALID_TYPES;
