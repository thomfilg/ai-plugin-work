/**
 * Phase: rerun_check — after fixes/flake-rerun, query CI again. Auto-passes
 * if no failures remain (or all remaining are documented pre-existing).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { CI_PHASES } = require('../../ci-phase-registry');
const wait = require('./wait');

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function validate(ctx) {
  const c = readJson(path.join(ctx.tasksDir, 'ci-context.json'));
  if (!c || !c.prNumber) return { ok: false, errors: ['Missing ci-context.json prNumber.'] };
  const { buildChildEnv } = require('../../../work/scripts/gh-exec');
  const r = spawnSync('gh', ['pr', 'view', String(c.prNumber), '--json', 'statusCheckRollup'], {
    cwd: ctx.worktreeRoot,
    encoding: 'utf8',
    env: buildChildEnv(),
  });
  if (r.status !== 0) {
    return {
      ok: false,
      errors: [`gh pr view failed: ${r.stderr || 'no output'}`],
    };
  }
  let rollup;
  try {
    rollup = JSON.parse(r.stdout);
  } catch {
    return { ok: false, errors: [`Could not parse gh pr view output.`] };
  }
  const status = wait.classifyChecks(rollup);
  if (status.running > 0) {
    return {
      ok: false,
      errors: [],
      summary: `${status.running} check(s) still running after re-run`,
    };
  }
  if (status.failures.length === 0) {
    return { ok: true, summary: `all ${status.total} check(s) green` };
  }
  // Failures remain — every one must be classified as `pre-existing` with documentation.
  const triage = readJson(path.join(ctx.tasksDir, 'ci-triage.json'));
  const byName = Object.fromEntries(
    triage && triage.classifications ? triage.classifications.map((c2) => [c2.name, c2]) : []
  );
  const errors = [];
  for (const f of status.failures) {
    const t = byName[f.name];
    if (!t || t.category !== 'pre-existing' || !t.documentation) {
      errors.push(
        `Check \`${f.name}\` is still failing and is NOT documented as pre-existing. Either fix it (and re-run me) or add a triage entry with category=pre-existing + documentation.`
      );
    }
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    summary: `${status.failures.length} pre-existing documented, rest green`,
  };
}

function instructions(ctx) {
  return [
    `# ci-next — Phase 5 of 8: RE-RUN CHECK`,
    `Ticket: ${ctx.ticket}`,
    '',
    'I re-query CI. If failures remain, every one must be category=pre-existing with `documentation` set.',
    '',
    'If failures are still running, I report WAITING and you re-invoke me later.',
    'If flakes need a rerun, push an empty commit (`git commit --allow-empty -m "ci: rerun"`) or use `gh workflow run`.',
    '',
  ].join('\n');
}

module.exports = function register(r) {
  r(CI_PHASES.rerun_check, {
    next: CI_PHASES.wait_merge,
    validate,
    instructions,
  });
};
module.exports.validate = validate;
module.exports.instructions = instructions;
