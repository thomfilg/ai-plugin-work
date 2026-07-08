/**
 * Phase: pr_merged_check — defensive duplicate of ci-step's wait_merge.
 *
 * Hard-blocks (NOT WAITs) if PR is OPEN or CLOSED. The workflow shouldn't
 * reach cleanup at all in those states — if it did, something bypassed the
 * ci gate and we refuse to proceed with destructive cleanup actions.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { CLEANUP_PHASES } = require('../../cleanup-phase-registry');

function readContext(tasksDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(tasksDir, 'cleanup-context.json'), 'utf8'));
  } catch {
    return null;
  }
}

function fetchPrState(worktreeRoot, prNumber) {
  const { buildChildEnv } = require('../../../work/scripts/gh-exec');
  const r = spawnSync('gh', ['pr', 'view', String(prNumber), '--json', 'state,mergedAt'], {
    cwd: worktreeRoot,
    encoding: 'utf8',
    env: buildChildEnv(),
  });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

function validate(ctx) {
  const c = readContext(ctx.tasksDir);
  if (!c || !c.prNumber) {
    return {
      ok: false,
      errors: [
        'Cannot verify PR is merged: cleanup-context.json missing prNumber. Re-run inputs phase first.',
      ],
    };
  }
  const state = module.exports.fetchPrState(c.worktreeRoot || ctx.worktreeRoot, c.prNumber);
  if (!state) {
    return {
      ok: false,
      errors: [
        `Could not query PR #${c.prNumber} state. Run \`gh pr view ${c.prNumber} --json state\` manually.`,
      ],
    };
  }
  if (state.state !== 'MERGED') {
    return {
      ok: false,
      errors: [
        `PR #${c.prNumber} state=${state.state} (expected MERGED). Cleanup refuses to delete branches/worktrees for a non-merged PR. Re-merge the PR or abort the workflow.`,
      ],
    };
  }
  return { ok: true, summary: `PR #${c.prNumber} merged at ${state.mergedAt || '(unknown)'}` };
}

function instructions(ctx) {
  return [
    '# cleanup-next — Phase 2 of 7: PR MERGED CHECK',
    `Ticket: ${ctx.ticket}`,
    '',
    'Defensive double-check: cleanup must only run on MERGED PRs. If this blocks, your ci step exited prematurely (likely missing wait_merge).',
    '',
  ].join('\n');
}

module.exports = function register(r) {
  r(CLEANUP_PHASES.pr_merged_check, {
    next: CLEANUP_PHASES.branch_cleanup,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.fetchPrState = fetchPrState;
