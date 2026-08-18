/**
 * unresolved-worktree-never-cwd.test.js
 *
 * Removing the `'my-project'` placeholder made `worktreeDir()` return null when
 * REPO_NAME is unconfigured. That is correct — but null is only an improvement
 * if it STOPS things. `child_process` reads a null/undefined `cwd` as
 * "inherit", so a null worktree silently becomes "whatever directory the
 * process was launched in", and `git rev-parse`, diffs, rebases and `gh pr
 * view` then run against the wrong repository. A wrong-but-plausible directory
 * is exactly what this burn-down exists to remove, and "the current directory"
 * is the most plausible wrong directory there is.
 *
 * So the rule these tests pin is narrower than "returns null": an unresolved
 * worktree must produce a REFUSAL that names the key, never a silent fallback.
 *
 * Uses node:test + node:assert/strict.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WORKFLOWS = path.join(__dirname, '..', '..');

/** Run a snippet in a child so a null config cannot leak into other suites. */
function runNode(script, env) {
  return execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ...env },
  });
}

describe('an unresolved worktree refuses instead of falling back to cwd', () => {
  it('work-pr getWorktreeDir throws naming WORKTREES_BASE and REPO_NAME', () => {
    const tasks = fs.mkdtempSync(path.join(os.tmpdir(), 'unresolved-wt-'));
    try {
      const wf = path.join(WORKFLOWS, 'work-pr', 'work-pr.workflow.js');
      const out = runNode(
        `
        try {
          const wf = require(${JSON.stringify(wf)});
          // onTransition reaches getWorktreeDir for the sha-recording step.
          wf.onTransition('3_pr_gen', '4_screenshot_gate', 'SHA');
          process.stdout.write('NO_THROW');
        } catch (e) {
          process.stdout.write(e.message);
        }`,
        { WORKTREES_BASE: '/srv/worktrees', TASKS_BASE: tasks, REPO_NAME: '' }
      );

      assert.match(out, /REPO_NAME/, `the error must name the key to set, got: ${out}`);
      assert.equal(
        out.includes('NO_THROW'),
        false,
        'a null worktree must not reach execSync, where cwd:null means "inherit"'
      );
    } finally {
      fs.rmSync(tasks, { recursive: true, force: true });
    }
  });

  it('work-next blocks with a structured instruction when REPO_NAME is unset', () => {
    const tasks = fs.mkdtempSync(path.join(os.tmpdir(), 'unresolved-wt-next-'));
    try {
      const out = execFileSync(
        process.execPath,
        [path.join(WORKFLOWS, 'work', 'work-next.js'), 'PROJ-1'],
        {
          encoding: 'utf8',
          timeout: 20000,
          env: {
            ...process.env,
            WORKTREES_BASE: '/srv/worktrees',
            TASKS_BASE: tasks,
            REPO_NAME: '',
          },
        }
      );
      const payload = JSON.parse(out.trim().split('\n').pop());

      assert.equal(payload.action, 'blocked', `expected a blocked instruction, got: ${out}`);
      assert.match(payload.reason, /REPO_NAME/);
      // The orchestrator contract: always a structured instruction, never a crash.
      assert.equal(payload.type, 'work_instruction');
    } finally {
      fs.rmSync(tasks, { recursive: true, force: true });
    }
  });

  it('follow-up-next blocks rather than classifying against the launch directory', () => {
    const tasks = fs.mkdtempSync(path.join(os.tmpdir(), 'unresolved-wt-fu-'));
    try {
      const out = execFileSync(
        process.execPath,
        [path.join(WORKFLOWS, 'follow-up', 'follow-up-next.js'), 'PROJ-1'],
        {
          encoding: 'utf8',
          timeout: 20000,
          env: {
            ...process.env,
            WORKTREES_BASE: '/srv/worktrees',
            TASKS_BASE: tasks,
            REPO_NAME: '',
          },
        }
      );
      const payload = JSON.parse(out.trim().split('\n').pop());

      assert.equal(payload.action, 'blocked', `expected a blocked instruction, got: ${out}`);
      assert.match(payload.reason, /REPO_NAME/);
    } finally {
      fs.rmSync(tasks, { recursive: true, force: true });
    }
  });
});
