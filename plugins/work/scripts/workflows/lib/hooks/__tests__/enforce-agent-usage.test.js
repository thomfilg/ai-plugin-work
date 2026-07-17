'use strict';

// GH-539: enforce-agent-usage relocated into the plugin; the Semantic Commits
// rule now FORCES every commit through the sanctioned commit-and-push.js script
// (a raw `git commit` is always blocked — no validator-hook lift, no install
// step). These tests cover the pure decision helpers (the process/stdin main()
// stays unexercised).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { AGENT_ENFORCEMENT_RULES, COMMIT_SCRIPT, shouldBypass } = require('../enforce-agent-usage');

const commitRule = AGENT_ENFORCEMENT_RULES.find((r) => r.name === 'Semantic Commits');

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

  it('has no agent alias — no agent may satisfy the rule (script is the only path)', () => {
    assert.deepEqual(commitRule.agentAliases, []);
  });

  it('the block message points the agent at the sanctioned commit-and-push.js script', () => {
    assert.ok(commitRule.message.includes(COMMIT_SCRIPT));
    assert.ok(commitRule.message.includes('commit-and-push.js'));
  });

  it('COMMIT_SCRIPT resolves to the plugin commit-and-push.js', () => {
    assert.equal(path.basename(COMMIT_SCRIPT), 'commit-and-push.js');
    assert.ok(path.isAbsolute(COMMIT_SCRIPT));
    assert.ok(COMMIT_SCRIPT.endsWith(path.join('work', 'scripts', 'commit-and-push.js')));
  });
});

// GH-767 Task 3: the migrated primary hooks obtain identity from the
// canonical agent-identity module — require-path assertions only (no
// behavior assertions; the suites above are the behavior anchor).
describe('enforce-agent-usage — GH-767 agent-identity migration (require paths)', () => {
  const fs = require('fs');
  const LIB = path.join(__dirname, '..', '..');
  const MIGRATED = [
    'hooks/agent-hook-dispatcher.js',
    'hooks/enforce-agent-usage.js',
    'hooks/enforce-step-workflow.js',
    'hooks/enforce-screenshot-requirement.js',
    'hooks/policies/agent-gate-rule.js',
    'hooks/policies/step-gate.js',
    'hooks/policies/workflow-loop-rules.js',
  ];

  it('every migrated hook requires agent-identity, never agent-detection', () => {
    for (const rel of MIGRATED) {
      const src = fs.readFileSync(path.join(LIB, rel), 'utf8');
      assert.ok(src.includes('agent-identity'), `${rel} must require agent-identity`);
      assert.ok(!src.includes("agent-detection'"), `${rel} must not require agent-detection`);
    }
  });
});
