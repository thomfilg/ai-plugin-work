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
 * The rule these tests pin is therefore about VISIBILITY, per site, and it is
 * not uniform — because the pre-PR behaviour was not uniform either:
 *
 *   - runDispatchedGate REFUSES by name, and work-pr SKIPS with a warning
 *     (its onTransition may not throw). Previously an unset
 *     REPO_NAME produced a `<worktrees>/my-project-<TICKET>` path that did not
 *     exist, so git/the gate command failed loudly. null means "inherit", so
 *     the same misconfiguration would quietly succeed against the wrong repo.
 *     Refusing preserves the loud failure.
 *   - follow-up-next KEEPS its cwd fallback and warns. There the placeholder
 *     path never existed either, so it already fell through to cwd — the
 *     outcome is unchanged and only the silence was new.
 *
 * Blocking follow-up-next outright was tried and reverted: it turned a narrow
 * hazard into a precondition for the whole command and broke six suites that
 * never needed a worktree.
 *
 * The runDispatchedGate case is a STRUCTURAL pin (it asserts the guard exists
 * in source) rather than a behavioural one: reaching that call needs a live
 * dispatched-gate loop, and a fixture that elaborate would test the fixture.
 *
 * Uses node:test + node:assert/strict.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WORKFLOWS = path.join(__dirname, '..', '..');

describe('an unresolved worktree refuses instead of falling back to cwd', () => {
  it('work-pr onTransition skips the sha write instead of running git in the cwd', () => {
    // onTransition carries a never-throws contract (pinned by "does not throw
    // for any step combination"), so this one degrades rather than refuses:
    // the requirement is that git never runs with cwd:null, not that it throws.
    const tasks = fs.mkdtempSync(path.join(os.tmpdir(), 'unresolved-wt-'));
    try {
      const wf = path.join(WORKFLOWS, 'work-pr', 'work-pr.workflow.js');
      const r = spawnSync(
        process.execPath,
        [
          '-e',
          `const wf = require(${JSON.stringify(wf)});
           wf.onTransition('3_pr_gen', '4_screenshot_gate', 'PROJ-1');
           process.stdout.write('NO_THROW');`,
        ],
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

      assert.equal(r.stdout, 'NO_THROW', `onTransition must not throw; stderr: ${r.stderr}`);
      assert.match(
        String(r.stderr || ''),
        /cannot resolve the worktree/i,
        'skipping must be reported, not silent'
      );
      assert.equal(
        fs.existsSync(path.join(tasks, 'PROJ-1', '.pr-update-sha')),
        false,
        'no .pr-update-sha may be written from a HEAD read in an inherited cwd'
      );
    } finally {
      fs.rmSync(tasks, { recursive: true, force: true });
    }
  });

  it('follow-up-next says so on stderr before classifying against the cwd', () => {
    // cwd is the long-standing fallback for "the worktree is not there", and it
    // is NOT a new outcome: before REPO_NAME stopped defaulting to
    // 'my-project', an unset one produced a path that never existed and landed
    // here too. What must not happen is landing here SILENTLY.
    const tasks = fs.mkdtempSync(path.join(os.tmpdir(), 'unresolved-wt-fu-'));
    try {
      const r = spawnSync(
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
      assert.match(
        String(r.stderr || ''),
        /REPO_NAME is not configured/,
        `falling back to the launch directory must be reported; stderr: ${r.stderr}`
      );
    } finally {
      fs.rmSync(tasks, { recursive: true, force: true });
    }
  });

  it('runDispatchedGate refuses rather than running gate tests in an inherited cwd', () => {
    // Here the outcome DID change: an unresolvable worktree used to be a
    // non-existent path, so the gate command failed loudly. null means
    // "inherit", which would run the tests in whichever shell fired the hook.
    const { createGetNextInstruction } = require(
      path.join(WORKFLOWS, 'work', 'lib', 'next-instruction')
    );
    assert.equal(
      typeof createGetNextInstruction,
      'function',
      'next-instruction must expose its factory for this contract to be testable'
    );
    const src = fs.readFileSync(path.join(WORKFLOWS, 'work', 'lib', 'next-instruction.js'), 'utf8');
    assert.match(
      src,
      /if \(!worktreeDir\) \{[\s\S]*?throw new Error\(/,
      'runDispatchedGate must refuse a null worktreeDir instead of passing it through as cwd'
    );
  });
});
