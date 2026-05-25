/**
 * Phase: wait — query CI status; advance only when CI is no longer running.
 *
 * - all PASS  → advance to triage (which will auto-pass) then forward.
 * - any FAIL  → advance to triage with the failure list.
 * - still running → WAITING (no errors, no advance) — agent re-invokes.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { CI_PHASES } = require('../../ci-phase-registry');

const STATUS_FILE = 'ci-status.json';

function readContext(tasksDir, file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(tasksDir, file), 'utf8'));
  } catch {
    return null;
  }
}

function fetchChecks(worktreeRoot, prNumber) {
  const { buildChildEnv } = require('../../../work/scripts/gh-exec');
  const r = spawnSync('gh', ['pr', 'view', String(prNumber), '--json', 'statusCheckRollup'], {
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

function classifyChecks(rollup) {
  const checks = (rollup && rollup.statusCheckRollup) || [];
  const failures = [];
  let running = 0;
  let passed = 0;
  for (const c of checks) {
    const state = (c.state || c.status || c.conclusion || '').toString().toUpperCase();
    if (state === 'IN_PROGRESS' || state === 'QUEUED' || state === 'PENDING') {
      running++;
    } else if (
      state === 'FAILURE' ||
      state === 'FAILED' ||
      state === 'ERROR' ||
      state === 'TIMED_OUT' ||
      state === 'ACTION_REQUIRED' ||
      state === 'CANCELLED'
    ) {
      failures.push({ name: c.name || c.context || '(unnamed)', state });
    } else if (
      state === 'SUCCESS' ||
      state === 'COMPLETED' ||
      state === 'NEUTRAL' ||
      state === 'SKIPPED'
    ) {
      passed++;
    } else {
      // Unknown state — treat as running to be conservative.
      running++;
    }
  }
  return { total: checks.length, running, passed, failures };
}

function validate(ctx) {
  const c = readContext(ctx.tasksDir, 'ci-context.json');
  if (!c || !c.prNumber) {
    return { ok: false, errors: ['Missing ci-context.json prNumber (re-run inputs).'] };
  }
  const rollup = fetchChecks(ctx.worktreeRoot, c.prNumber);
  if (!rollup) {
    return {
      ok: false,
      errors: [
        `Could not query CI status for PR #${c.prNumber}. Run \`gh pr view ${c.prNumber}\` manually to diagnose.`,
      ],
    };
  }
  const status = classifyChecks(rollup);
  // Always persist the snapshot so triage can read it.
  try {
    fs.writeFileSync(
      path.join(ctx.tasksDir, STATUS_FILE),
      JSON.stringify({ ...status, snapshotAt: new Date().toISOString() }, null, 2)
    );
  } catch {
    /* hook-gated */
  }
  if (status.running > 0) {
    // Waiting — no errors, no advance.
    return {
      ok: false,
      errors: [],
      summary: `${status.running} check(s) still running (${status.passed} passed, ${status.failures.length} failed so far)`,
    };
  }
  return {
    ok: true,
    summary: `${status.total} check(s): ${status.passed} passed, ${status.failures.length} failed`,
  };
}

function instructions(ctx) {
  const status = readContext(ctx.tasksDir, STATUS_FILE);
  const lines = [`# ci-next — Phase 2 of 8: WAIT`, `Ticket: ${ctx.ticket}`, ''];
  if (status) {
    lines.push(`Last snapshot: ${status.snapshotAt}`);
    lines.push(
      `  running: ${status.running}, passed: ${status.passed}, failed: ${status.failures.length}`
    );
    if (status.failures.length) {
      lines.push('  failures:');
      for (const f of status.failures) lines.push(`    - ${f.name} (${f.state})`);
    }
  }
  lines.push('');
  lines.push('⏳ POLL-ONLY PHASE — do not edit files, do not spawn developer agents.');
  lines.push('There is nothing to implement while CI is running. The ONLY action is to');
  lines.push('re-invoke ci-next.js periodically (or wait for a Monitor task to nudge you).');
  lines.push(
    'CI can take 20+ minutes. I advance to TRIAGE as soon as no checks are still running.'
  );
  lines.push('');
  return lines.join('\n');
}

module.exports = function register(r) {
  r(CI_PHASES.wait, {
    next: CI_PHASES.triage,
    validate,
    instructions,
  });
};
module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.classifyChecks = classifyChecks;
module.exports.STATUS_FILE = STATUS_FILE;
