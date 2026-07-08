'use strict';

// GH-539: the commit-msg validator blocks commits authored under an AI-tool
// git identity. resolveGitUser reads the EFFECTIVE identity (what git commits
// as — local overriding global), so a rogue local "Claude" identity is caught
// even without a worktree .envrc.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { resolveGitUser, isAiIdentity } = require('../git-identity');

describe('isAiIdentity', () => {
  it('flags AI-tool names / emails', () => {
    assert.equal(isAiIdentity({ name: 'Claude', email: 'noreply@anthropic.com' }), true);
    assert.equal(isAiIdentity({ name: 'Codex Bot', email: 'x@y.z' }), true);
    assert.equal(isAiIdentity({ name: 'dev', email: 'gemini@x.z' }), true);
  });
  it('allows a human identity', () => {
    assert.equal(isAiIdentity({ name: 'Thompson Filgueiras', email: 'thomfilg@gmail.com' }), false);
  });
});

describe('resolveGitUser', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh539-gi-'));
    execFileSync('git', ['-C', dir, 'init', '-q'], { timeout: 5000 });
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'Claude'], { timeout: 5000 });
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'noreply@anthropic.com'], {
      timeout: 5000,
    });
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads the effective (local) identity — catches a rogue local AI user', () => {
    const user = resolveGitUser(dir);
    assert.equal(user.name, 'Claude');
    assert.equal(isAiIdentity(user), true);
  });
});
