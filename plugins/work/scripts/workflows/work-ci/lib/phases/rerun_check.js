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

/**
 * A triage entry is "addressed" if it represents a state that should not
 * keep the rerun_check loop open. Two shapes qualify:
 *   - pre-existing failures that are documented;
 *   - cache-miss failures that captured a valid rerunRunId (digits, ≥6 chars).
 */
function isAddressed(t) {
  if (!t) return false;
  if (t.category === 'pre-existing' && t.documentation) return true;
  if (t.category === 'cache-miss' && typeof t.rerunRunId === 'string' && /^\d{6,}$/.test(t.rerunRunId)) {
    return true;
  }
  return false;
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
    if (!isAddressed(t)) {
      errors.push(
        `Check \`${f.name}\` is still failing and is NOT documented as pre-existing. Either fix it (and re-run me) or add a triage entry with category=pre-existing + documentation, or category=cache-miss with a valid rerunRunId.`
      );
    }
  }
  if (errors.length) return { ok: false, errors };
  // Build an accurate summary that distinguishes pre-existing from cache-miss.
  let preExisting = 0;
  let cacheMiss = 0;
  for (const f of status.failures) {
    const t = byName[f.name];
    if (t && t.category === 'pre-existing') preExisting += 1;
    else if (t && t.category === 'cache-miss') cacheMiss += 1;
  }
  const parts = [];
  if (preExisting > 0) parts.push(`${preExisting} pre-existing documented`);
  if (cacheMiss > 0) parts.push(`${cacheMiss} cache-miss rerun(s) recorded`);
  parts.push('rest green');
  return {
    ok: true,
    summary: parts.join(', '),
  };
}

function instructions(ctx) {
  return [
    `# ci-next — Phase 5 of 8: RE-RUN CHECK`,
    `Ticket: ${ctx.ticket}`,
    '',
    'I re-query CI. If failures remain, every one must be addressed by either:',
    '- category=`pre-existing` with `documentation` set, or',
    '- category=`cache-miss` with a valid `rerunRunId` (numeric, ≥ 6 digits).',
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
