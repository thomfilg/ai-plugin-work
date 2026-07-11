/**
 * diff-audit.test.js — GH-693 blocked-state propagation for the diff_audit
 * phase of the task-review runner.
 *
 * When computeTaskDiff blocks (zero commits ahead of base and no valid
 * .last-commit-sha), validate() must surface that exact reason instead of
 * auditing an empty range and misattributing it to a stale SHA.
 */

'use strict';

const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validate } = require('../lib/phases/diff_audit');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-audit-test-'));

after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

describe('diff_audit validate (GH-693 blocked propagation)', () => {
  // computeTaskDiff uses a dynamic require('child_process').execFileSync, so
  // patching the module property makes the commits-ahead answer deterministic.
  const cp = require('node:child_process');
  let origExecFileSync;
  let revList;

  beforeEach(() => {
    revList = '0\n';
    origExecFileSync = cp.execFileSync;
    cp.execFileSync = (cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'rev-list' && args[1] === '--count') {
        if (revList instanceof Error) throw revList;
        return revList;
      }
      if (cmd === 'git' && args[0] === 'merge-base' && args[1] !== '--is-ancestor') {
        return `${'a'.repeat(40)}\n`;
      }
      return origExecFileSync(cmd, args, opts);
    };
  });

  afterEach(() => {
    cp.execFileSync = origExecFileSync;
  });

  function makeCtx(name) {
    const tasksDir = path.join(TEMP, name);
    fs.mkdirSync(tasksDir, { recursive: true });
    // worktreeRoot is a plain temp dir (not a git repo) so any real
    // `git diff --name-only` deterministically yields an empty file list.
    return { ticket: name, tasksDir, worktreeRoot: tasksDir };
  }

  it('surfaces the blocked reason when zero commits are ahead and no .last-commit-sha exists', () => {
    const ctx = makeCtx('T-BLOCKED');
    const res = validate(ctx);
    assert.equal(res.ok, false);
    assert.match(res.errors[0], /no commits ahead/, 'must surface the gate reason verbatim');
    assert.equal(
      fs.existsSync(path.join(ctx.tasksDir, 'task-review-context.json')),
      false,
      'no context snapshot may be written for a blocked range'
    );
  });

  it('keeps the empty-file-list rejection for non-blocked ranges (belt and braces)', () => {
    revList = '1\n';
    const ctx = makeCtx('T-EMPTY');
    const res = validate(ctx);
    assert.equal(res.ok, false);
    assert.match(res.errors[0], /task diff empty/);
  });
});
