/**
 * Phase: inputs — resolve the PR number and write it into ci-context.json.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { CI_PHASES } = require('../../ci-phase-registry');

const CTX_FILE = 'ci-context.json';

function readContext(tasksDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(tasksDir, CTX_FILE), 'utf8'));
  } catch {
    return null;
  }
}

function resolvePrNumber(worktreeRoot) {
  // Prefer the pr-context.json the pr step recorded.
  try {
    const ctx = JSON.parse(
      fs.readFileSync(path.join(worktreeRoot, '..', 'pr-context.json'), 'utf8')
    );
    if (ctx && ctx.prNumber) return ctx.prNumber;
  } catch {
    /* fall through */
  }
  // Fallback: gh pr view.
  const r = spawnSync('gh', ['pr', 'view', '--json', 'number'], {
    cwd: worktreeRoot,
    encoding: 'utf8',
  });
  if (r.status === 0) {
    try {
      const obj = JSON.parse(r.stdout);
      return obj.number || null;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function validate(ctx) {
  const existing = readContext(ctx.tasksDir);
  if (existing && existing.prNumber) return { ok: true, summary: `PR #${existing.prNumber}` };
  const prNumber = resolvePrNumber(ctx.worktreeRoot);
  if (!prNumber) {
    return {
      ok: false,
      errors: [
        `Could not resolve PR number. Run \`gh pr view --json number\` from ${ctx.worktreeRoot}, or ensure tasks/<ticket>/pr-context.json contains a \`prNumber\` field.`,
      ],
    };
  }
  try {
    fs.writeFileSync(
      path.join(ctx.tasksDir, CTX_FILE),
      JSON.stringify({ prNumber, snapshotAt: new Date().toISOString() }, null, 2)
    );
  } catch {
    /* hook-gated */
  }
  return { ok: true, summary: `PR #${prNumber} recorded` };
}

function instructions(ctx) {
  return [
    `# ci-next — Phase 1 of 7: INPUTS`,
    `Ticket: ${ctx.ticket}`,
    '',
    `Resolves the PR number from \`pr-context.json\` (preferred) or \`gh pr view\`. Writes it to \`${CTX_FILE}\`.`,
    '',
  ].join('\n');
}

module.exports = function register(r) {
  r(CI_PHASES.inputs, {
    next: CI_PHASES.wait,
    validate,
    instructions,
  });
};
module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.CTX_FILE = CTX_FILE;
module.exports.readContext = readContext;
