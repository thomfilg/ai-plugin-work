/**
 * Phase: inputs — branch is pushed to a remote, base branch is identified,
 * tasks.md/spec.md exist for downstream description-draft fodder.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { PR_PHASES } = require('../../pr-phase-registry');

function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return { code: r.status ?? -1, out: (r.stdout || '').trim() };
}

function detectPushed() {
  const cur = git(['branch', '--show-current']);
  if (cur.code !== 0 || !cur.out) return { branch: null, pushed: false };
  const r = git(['ls-remote', '--exit-code', '--heads', 'origin', cur.out]);
  return { branch: cur.out, pushed: r.code === 0 };
}

function validateArtifacts(tasksDir) {
  const errors = [];
  const { branch, pushed } = detectPushed();
  if (!branch) {
    errors.push('Cannot resolve current branch.');
    return errors;
  }
  if (!pushed) {
    errors.push(
      `Branch \`${branch}\` is not pushed to origin. Run \`git push -u origin ${branch}\` first.`
    );
  }
  if (!fs.existsSync(path.join(tasksDir, 'tasks.md'))) {
    errors.push(`Missing tasks.md — the description draft phase needs it as fodder.`);
  }
  return errors;
}

function validate(ctx) {
  const errors = validateArtifacts(ctx.tasksDir);
  if (errors.length) return { ok: false, errors };
  return { ok: true, summary: 'branch pushed, tasks.md present' };
}

function instructions(ctx) {
  return [
    `# pr-next — Phase 1 of 8: INPUTS`,
    `Ticket: ${ctx.ticket}`,
    '',
    '### What I check',
    '- Current branch resolves',
    '- Branch is pushed to `origin`',
    '- `tasks.md` exists (so the description-draft phase has source material)',
    '',
    'If branch is not pushed, run `git push -u origin <branch>` and re-invoke me.',
    '',
  ].join('\n');
}

module.exports = function register(r) {
  r(PR_PHASES.inputs, {
    next: PR_PHASES.diff_audit,
    validate,
    instructions,
  });
};
module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.validateArtifacts = validateArtifacts;
module.exports.detectPushed = detectPushed;
