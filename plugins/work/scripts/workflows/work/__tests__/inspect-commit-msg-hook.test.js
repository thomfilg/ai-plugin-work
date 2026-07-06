'use strict';

// GH-539: hasCommitMsgValidator is the ONE shared detector behind both
// inspect.js's `hasCommitMsgHook` (commit step direct-commit choice) and
// enforce-agent-usage.js's git-commit block lift. It reports the validator
// present only when an EXECUTABLE commit-msg hook delegating to
// validate-commit-msg exists in the active hooks dir (core.hooksPath else
// .git/hooks). The executable-bit check matters: git silently skips a
// non-exec hook, so a non-exec file must NOT count as "validated".

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { hasCommitMsgValidator } = require('../../lib/commit-msg-hook');

const VALIDATOR_SHIM = '#!/bin/sh\nexec node "/x/validate-commit-msg.js" "$1"\n';

/** Initialise a throwaway git repo so `git config --get core.hooksPath` works. */
function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh539-cmh-'));
  execFileSync('git', ['-C', dir, 'init', '-q'], { timeout: 5000 });
  return dir;
}

describe('hasCommitMsgValidator', () => {
  let dir;
  before(() => {
    dir = initRepo();
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns false when no commit-msg hook exists', () => {
    assert.equal(hasCommitMsgValidator(dir), false);
  });

  it('returns true for an executable .git/hooks/commit-msg validator shim', () => {
    const hook = path.join(dir, '.git', 'hooks', 'commit-msg');
    fs.writeFileSync(hook, VALIDATOR_SHIM);
    fs.chmodSync(hook, 0o755);
    assert.equal(hasCommitMsgValidator(dir), true);
  });

  it('returns false when the validator hook is NOT executable (git would skip it)', () => {
    const hook = path.join(dir, '.git', 'hooks', 'commit-msg');
    fs.writeFileSync(hook, VALIDATOR_SHIM);
    fs.chmodSync(hook, 0o644);
    assert.equal(hasCommitMsgValidator(dir), false);
  });

  it('returns false when an executable commit-msg hook is not our validator', () => {
    const hook = path.join(dir, '.git', 'hooks', 'commit-msg');
    fs.writeFileSync(hook, '#!/bin/sh\necho unrelated\n');
    fs.chmodSync(hook, 0o755);
    assert.equal(hasCommitMsgValidator(dir), false);
  });

  it('resolves a relative core.hooksPath against the worktree root', () => {
    execFileSync('git', ['-C', dir, 'config', 'core.hooksPath', 'scripts/hooks'], { timeout: 5000 });
    const hooks = path.join(dir, 'scripts', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    const hook = path.join(hooks, 'commit-msg');
    fs.writeFileSync(hook, VALIDATOR_SHIM);
    fs.chmodSync(hook, 0o755);
    assert.equal(hasCommitMsgValidator(dir), true);
  });
});
