/**
 * Phase: wait_merge — block ci-step exit until the PR is actually merged.
 *
 * Re-entrant phase (same pattern as `wait`): when the PR is still open,
 * validate returns `{ ok: false, errors: [] }` (no errors → waiting, not
 * blocked), so the orchestrator prints the current instructions and exits
 * WAITING. User re-runs the orchestrator (or ci-next.js directly) after
 * the PR merges.
 *
 * Rationale: ci-step previously passed when CI checks went green, which let
 * the workflow advance to cleanup/reports/complete BEFORE the PR landed on
 * main. That broke "branch fully merged" assumptions downstream. Now the
 * workflow can't move past ci until the merge happens.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { CI_PHASES } = require('../../ci-phase-registry');

const MERGE_STATUS_FILE = 'ci-merge-status.json';

function readContext(tasksDir, file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(tasksDir, file), 'utf8'));
  } catch {
    return null;
  }
}

function fetchPrState(worktreeRoot, prNumber) {
  const { buildChildEnv } = require('../../../work/scripts/gh-exec');
  const r = spawnSync(
    'gh',
    ['pr', 'view', String(prNumber), '--json', 'state,mergedAt,mergeCommit'],
    { cwd: worktreeRoot, encoding: 'utf8', env: buildChildEnv() }
  );
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

function validate(ctx) {
  const c = readContext(ctx.tasksDir, 'ci-context.json');
  if (!c || !c.prNumber) {
    return { ok: false, errors: ['Missing ci-context.json prNumber (re-run inputs).'] };
  }
  // Indirect via module.exports so tests can monkey-patch fetchPrState.
  const state = module.exports.fetchPrState(ctx.worktreeRoot, c.prNumber);
  if (!state) {
    return {
      ok: false,
      errors: [
        `Could not query PR state for #${c.prNumber}. Run \`gh pr view ${c.prNumber} --json state\` manually to diagnose.`,
      ],
    };
  }

  // Persist the latest snapshot so the orchestrator's WAITING render is informative.
  const snapshot = {
    prNumber: c.prNumber,
    state: state.state,
    mergedAt: state.mergedAt || null,
    mergeCommit: state.mergeCommit ? state.mergeCommit.oid || state.mergeCommit : null,
    snapshotAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(path.join(ctx.tasksDir, MERGE_STATUS_FILE), JSON.stringify(snapshot, null, 2));
  } catch {
    /* hook-gated */
  }

  if (state.state === 'MERGED') {
    return { ok: true, summary: `PR #${c.prNumber} merged at ${state.mergedAt || '(unknown)'}` };
  }

  if (state.state === 'CLOSED') {
    return {
      ok: false,
      errors: [
        `PR #${c.prNumber} is CLOSED (not merged). The ci step cannot complete. Re-open the PR and merge, or abort the workflow.`,
      ],
    };
  }

  // OPEN — waiting for merge. No errors, no advance.
  return {
    ok: false,
    errors: [],
    summary: `PR #${c.prNumber} state=${state.state} — waiting for merge`,
  };
}

function instructions(ctx) {
  const snapshot = readContext(ctx.tasksDir, MERGE_STATUS_FILE);
  const lines = ['# ci-next — Phase 6 of 8: WAIT_MERGE', `Ticket: ${ctx.ticket}`, ''];
  if (snapshot) {
    lines.push(`Last snapshot: ${snapshot.snapshotAt}`);
    lines.push(`  PR #${snapshot.prNumber} state: ${snapshot.state}`);
    if (snapshot.mergedAt) lines.push(`  mergedAt: ${snapshot.mergedAt}`);
  }
  lines.push('');
  lines.push(
    'The ci step waits for the PR to be MERGED into the base branch before allowing the workflow to advance to cleanup/reports/complete.'
  );
  lines.push('');
  lines.push(
    'Sleep / hand off to the user, then re-invoke me. I advance to MEMORIZE as soon as `gh pr view --json state` reports `MERGED`.'
  );
  lines.push('');
  return lines.join('\n');
}

module.exports = function register(r) {
  r(CI_PHASES.wait_merge, {
    next: CI_PHASES.memorize,
    validate,
    instructions,
  });
};
module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.fetchPrState = fetchPrState;
module.exports.MERGE_STATUS_FILE = MERGE_STATUS_FILE;
