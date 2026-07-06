'use strict';

// GH-539: enforce-agent-usage relocated into the plugin; the Semantic Commits
// rule is lifted where the commit-msg validator hook is installed. These tests
// cover the pure decision helpers (the process/stdin main() stays unexercised).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  AGENT_ENFORCEMENT_RULES,
  shouldBypass,
  bypassOnValidatorHook,
} = require('../enforce-agent-usage');

const commitRule = AGENT_ENFORCEMENT_RULES.find((r) => r.name === 'Semantic Commits');

function initRepoWithValidator(withValidator) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh539-eau-'));
  execFileSync('git', ['-C', dir, 'init', '-q'], { timeout: 5000 });
  if (withValidator) {
    const hook = path.join(dir, '.git', 'hooks', 'commit-msg');
    fs.writeFileSync(hook, '#!/bin/sh\nexec node "/x/validate-commit-msg.js" "$1"\n');
    fs.chmodSync(hook, 0o755);
  }
  return dir;
}

describe('enforce-agent-usage — Semantic Commits rule', () => {
  it('commandPattern matches a plain git commit but not --amend', () => {
    assert.ok(commitRule.commandPattern.test('git commit -m "x"'));
    assert.ok(!commitRule.commandPattern.test('git commit --amend'));
  });

  it('shouldBypass allows --amend / --allow-empty / fixup! / squash!', () => {
    assert.ok(shouldBypass({ command: 'git commit --amend' }, commitRule.allowPatterns));
    assert.ok(shouldBypass({ command: 'git commit --allow-empty -m x' }, commitRule.allowPatterns));
    assert.ok(!shouldBypass({ command: 'git commit -m x' }, commitRule.allowPatterns));
  });

  describe('bypassOnValidatorHook', () => {
    let withHook;
    let withoutHook;
    before(() => {
      withHook = initRepoWithValidator(true);
      withoutHook = initRepoWithValidator(false);
    });
    after(() => {
      fs.rmSync(withHook, { recursive: true, force: true });
      fs.rmSync(withoutHook, { recursive: true, force: true });
    });

    it('lifts the block when the validator hook is installed (git -C <path>)', () => {
      const toolInput = { command: `git -C "${withHook}" commit -m "x"` };
      assert.equal(bypassOnValidatorHook(commitRule, toolInput, {}), true);
    });

    it('does NOT lift when the worktree lacks the validator hook', () => {
      const toolInput = { command: `git -C "${withoutHook}" commit -m "x"` };
      assert.equal(bypassOnValidatorHook(commitRule, toolInput, {}), false);
    });

    it('falls back to hookData.cwd when the command has no -C path', () => {
      assert.equal(bypassOnValidatorHook(commitRule, { command: 'git commit -m x' }, { cwd: withHook }), true);
      assert.equal(bypassOnValidatorHook(commitRule, { command: 'git commit -m x' }, { cwd: withoutHook }), false);
    });

    it('never lifts rules that are not opted in', () => {
      const prRule = AGENT_ENFORCEMENT_RULES.find((r) => r.name === 'PR Creation');
      assert.equal(bypassOnValidatorHook(prRule, { command: 'x' }, { cwd: withHook }), false);
    });
  });
});
