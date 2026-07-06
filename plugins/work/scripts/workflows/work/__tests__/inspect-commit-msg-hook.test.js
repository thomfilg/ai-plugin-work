'use strict';

// GH-539: detectCommitMsgHook wires commit.js's hasCommitMsgHook branch to real
// state. Without it the direct-commit path is dead code and every commit still
// dispatches commit-writer. These tests confirm the detector resolves the active
// hooks directory (core.hooksPath when set, else .git/hooks) and only reports the
// hook present when a commit-msg shim delegating to validate-commit-msg exists.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { detectCommitMsgHook } = require('../engine/inspect');

/** A `run` that returns the given core.hooksPath value (empty string = unset). */
const runReturning = (hooksPath) => () => hooksPath;

describe('detectCommitMsgHook', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh539-hook-'));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns false when no commit-msg hook file exists', () => {
    fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
    assert.equal(detectCommitMsgHook(dir, runReturning('')), false);
  });

  it('returns true for a .git/hooks/commit-msg shim delegating to the validator (hooksPath unset)', () => {
    const hooks = path.join(dir, '.git', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(
      path.join(hooks, 'commit-msg'),
      '#!/bin/sh\nexec node "/x/validate-commit-msg.js" "$1"\n',
    );
    assert.equal(detectCommitMsgHook(dir, runReturning('')), true);
  });

  it('returns false when a commit-msg hook exists but is not our validator', () => {
    const hooks = path.join(dir, '.git', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, 'commit-msg'), '#!/bin/sh\necho unrelated\n');
    assert.equal(detectCommitMsgHook(dir, runReturning('')), false);
  });

  it('resolves a relative core.hooksPath against the worktree root', () => {
    const hooks = path.join(dir, 'scripts', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(
      path.join(hooks, 'commit-msg'),
      '#!/bin/sh\nexec node "/x/validate-commit-msg.js" "$1"\n',
    );
    assert.equal(detectCommitMsgHook(dir, runReturning('scripts/hooks')), true);
  });
});
