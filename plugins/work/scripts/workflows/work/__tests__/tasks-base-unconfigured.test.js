/**
 * tasks-base-unconfigured.test.js
 *
 * `config.TASKS_BASE` is null when nothing configured it (the derivation from
 * WORKTREES_BASE is gone). Removing a guess only helps if the consumers then
 * degrade well: previously every one of them received a plausible path and
 * carried on, which is exactly how a wrong tasks dir travelled far from its
 * cause.
 *
 * Two failure shapes matter here and they pull in opposite directions:
 *   - hooks must FAIL OPEN — never block against a directory they could not
 *     locate (the shape #791 fixed in enforce-screenshot-requirement.js);
 *   - state path builders must REFUSE LOUDLY — `path.join(null, …)` throws a
 *     bare "Path must be a string" that names nothing the operator can act on.
 *
 * enforce-screenshot-gate.js gets the same one-line guard but is NOT asserted
 * here: reaching its tasks-dir line needs a repo with UI changes AND a
 * resolvable base branch, and every fixture short of a remote-bearing clone
 * exits earlier — so the assertion could not fail and would be worse than none.
 * Its guard is parity with enforce-screenshot-requirement.js, which IS covered
 * (lib/__tests__/enforce-screenshot-dir.test.js).
 *
 * Uses node:test + node:assert/strict.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WORKFLOWS = path.join(__dirname, '..', '..');
const HOOK_ENFORCE_STEPS = path.join(WORKFLOWS, 'work', 'hooks', 'work-enforce-steps.js');

/** Env with a resolvable WORKTREES_BASE but NO TASKS_BASE — the guess's old home. */
function envWithoutTasksBase(extra = {}) {
  const env = { ...process.env, WORKTREES_BASE: '/srv/worktrees', ...extra };
  delete env.TASKS_BASE;
  return env;
}

/** Run a hook with a payload on stdin; returns { code, stderr }. */
function runHook(hookPath, payload, extraEnv = {}) {
  const r = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 20000,
    env: envWithoutTasksBase(extraEnv),
  });
  return { code: r.status, stderr: String(r.stderr || '') };
}

describe('hooks fail open when TASKS_BASE is unconfigured', () => {
  it('work-enforce-steps skips explicitly rather than crashing into its process guard', () => {
    // `skill` must be work/work-pr or the hook exits long before it resolves a
    // tasks dir. Exit 0 alone proves nothing here: installProcessGuards already
    // converts the `path.join(null, …)` TypeError into a silent exit 0, so the
    // observable difference is whether the skip is DELIBERATE and logged.
    const r = runHook(
      HOOK_ENFORCE_STEPS,
      { tool_name: 'Skill', tool_input: { skill: 'work', args: 'PROJ-123' } },
      { CLAUDE_HOOK_TYPE: 'PreToolUse' }
    );
    assert.equal(r.code, 0, `hook must not block; stderr: ${r.stderr}`);
    assert.match(
      r.stderr,
      /TASKS_BASE not configured/,
      'an unconfigured tasks root must be reported, not swallowed as a crash'
    );
  });
});

describe('state path builders refuse loudly when TASKS_BASE is unconfigured', () => {
  it('work-state getStatePath names TASKS_BASE instead of throwing from path.join', () => {
    // Loaded in a child so the null config cannot leak into other suites.
    const script = `
      process.env.WORKTREES_BASE = '/srv/worktrees';
      delete process.env.TASKS_BASE;
      try {
        const ws = require(${JSON.stringify(path.join(WORKFLOWS, 'work', 'work-state'))});
        ws.loadState('GH-1');
        process.stdout.write('NO_THROW');
      } catch (e) {
        process.stdout.write(e.message);
      }`;
    const out = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 20000,
      env: envWithoutTasksBase(),
    });

    assert.match(out, /TASKS_BASE/, `the error must name the key to set, got: ${out}`);
    assert.equal(
      /Path must be a string/.test(out),
      false,
      'a bare path.join TypeError names nothing the operator can act on'
    );
  });
});

describe('a configured TASKS_BASE is unaffected', () => {
  it('work-state resolves normally when TASKS_BASE is set', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-base-ok-'));
    try {
      const script = `
        const ws = require(${JSON.stringify(path.join(WORKFLOWS, 'work', 'work-state'))});
        process.stdout.write(String(ws.loadState('GH-1')));`;
      const out = execFileSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
        timeout: 20000,
        env: { ...process.env, WORKTREES_BASE: '/srv/worktrees', TASKS_BASE: base },
      });
      assert.equal(out, 'null', 'no state file yet — resolves and reads, does not throw');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
