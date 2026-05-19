/**
 * Phase: inputs — record context (ticket, worktree root, branch, PR number).
 * Persists `cleanup-context.json` for downstream phases.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { CLEANUP_PHASES } = require('../../cleanup-phase-registry');

function currentBranch(cwd) {
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function detectPrNumber(cwd, branch) {
  if (!branch) return null;
  const r = spawnSync('gh', ['pr', 'view', branch, '--json', 'number'], {
    cwd,
    encoding: 'utf8',
  });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout).number || null;
  } catch {
    return null;
  }
}

function validate(ctx) {
  const root = ctx.worktreeRoot || process.cwd();
  const branch = currentBranch(root);
  const prNumber = branch ? detectPrNumber(root, branch) : null;
  const payload = {
    ticket: ctx.ticket,
    worktreeRoot: root,
    branch,
    prNumber,
    capturedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(
      path.join(ctx.tasksDir, 'cleanup-context.json'),
      JSON.stringify(payload, null, 2)
    );
  } catch {
    /* hook-gated */
  }
  const warnings = [];
  if (!branch) warnings.push('Could not resolve current git branch.');
  if (!prNumber)
    warnings.push('Could not resolve PR number from branch — pr_merged_check will fail.');
  return {
    ok: true,
    warnings,
    summary: `branch=${branch || '(unknown)'} pr=${prNumber || '(unknown)'}`,
  };
}

function instructions(ctx) {
  return [
    '# cleanup-next — Phase 1 of 7: INPUTS',
    `Ticket: ${ctx.ticket}`,
    '',
    'I record the current branch + PR number into `cleanup-context.json` for downstream phases.',
    '',
    `Memory plugin: ${ctx.memory ? ctx.memory.name : '(none detected)'}`,
    '',
  ].join('\n');
}

module.exports = function register(r) {
  r(CLEANUP_PHASES.inputs, {
    next: CLEANUP_PHASES.pr_merged_check,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.currentBranch = currentBranch;
module.exports.detectPrNumber = detectPrNumber;
