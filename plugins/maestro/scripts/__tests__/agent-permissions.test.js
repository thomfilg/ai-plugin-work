// lib/agent-permissions.js — bootstrap injection of destructive-command
// allowlist rules into an agent worktree's local settings (GH-698 secondary
// issue: --dangerously-skip-permissions does not cover the destructive-command
// backstop, so a benign `rm -f` prompt stalled an unattended agent ~1h).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { spawnSync } = require('node:child_process');

const MOD = path.resolve(__dirname, '..', 'lib', 'agent-permissions.js');
const {
  applyAgentPermissions,
  ensureGitExcluded,
  resolveRules,
  DEFAULT_AGENT_PERMISSIONS,
} = require(MOD);

const settingsPath = (wt) => path.join(wt, '.claude', 'settings.local.json');
const readSettings = (wt) => JSON.parse(fs.readFileSync(settingsPath(wt), 'utf8'));

test('resolveRules: argv > env > default; set-but-empty env disables', () => {
  assert.deepEqual(resolveRules([], {}), DEFAULT_AGENT_PERMISSIONS, 'unset env → defaults');
  assert.deepEqual(
    resolveRules([], { MAESTRO_AGENT_PERMISSIONS: 'Bash(rm:*), Bash(git clean:*)' }),
    ['Bash(rm:*)', 'Bash(git clean:*)'],
    'env list is comma-split and trimmed'
  );
  assert.deepEqual(
    resolveRules([], { MAESTRO_AGENT_PERMISSIONS: '' }),
    [],
    'empty env is the explicit off switch'
  );
  assert.deepEqual(
    resolveRules(['Bash(x:*)'], { MAESTRO_AGENT_PERMISSIONS: 'Bash(y:*)' }),
    ['Bash(x:*)'],
    'explicit argv rules win over env'
  );
});

test('applyAgentPermissions: creates the settings file with the rules', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'agentperm-'));
  const r = applyAgentPermissions(wt, DEFAULT_AGENT_PERMISSIONS);
  assert.deepEqual(r.added, DEFAULT_AGENT_PERMISSIONS);
  assert.deepEqual(readSettings(wt), {
    permissions: { allow: ['Bash(rm:*)', 'Bash(pkill:*)'] },
  });
});

test('applyAgentPermissions: merges into existing settings, preserving keys and deduping', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'agentperm-'));
  fs.mkdirSync(path.join(wt, '.claude'), { recursive: true });
  fs.writeFileSync(
    settingsPath(wt),
    JSON.stringify({
      env: { FOO: '1' },
      permissions: { allow: ['Bash(rm:*)'], deny: ['Read(secrets/**)'] },
    })
  );
  const r = applyAgentPermissions(wt, DEFAULT_AGENT_PERMISSIONS);
  assert.deepEqual(r.added, ['Bash(pkill:*)'], 'only the missing rule is added');
  const s = readSettings(wt);
  assert.deepEqual(s.env, { FOO: '1' }, 'unrelated keys survive');
  assert.deepEqual(s.permissions.deny, ['Read(secrets/**)'], 'sibling permission lists survive');
  assert.deepEqual(s.permissions.allow, ['Bash(rm:*)', 'Bash(pkill:*)']);

  const again = applyAgentPermissions(wt, DEFAULT_AGENT_PERMISSIONS);
  assert.deepEqual(again.added, [], 'idempotent on re-run (bare bootstrap re-invocations)');
});

test('applyAgentPermissions: never clobbers an existing-but-unparsable settings file', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'agentperm-'));
  fs.mkdirSync(path.join(wt, '.claude'), { recursive: true });
  fs.writeFileSync(settingsPath(wt), '{ hand-edited, not json');
  const r = applyAgentPermissions(wt, DEFAULT_AGENT_PERMISSIONS);
  assert.equal(r.skipped, 'unparsable-settings');
  assert.deepEqual(r.added, []);
  assert.equal(
    fs.readFileSync(settingsPath(wt), 'utf8'),
    '{ hand-edited, not json',
    'the operator-owned file is byte-identical'
  );
});

test('ensureGitExcluded: excludes the settings file per-worktree, idempotently; no-op outside git', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'agentperm-'));
  assert.equal(ensureGitExcluded(wt), false, 'plain directory (no git) → fail-open no-op');

  const init = spawnSync('git', ['init', '-q', wt], { encoding: 'utf8' });
  if (init.status !== 0) return; // no git on this machine — the guard above is the contract
  assert.equal(ensureGitExcluded(wt), true);
  const excludePath = path.join(wt, '.git', 'info', 'exclude');
  const body = fs.readFileSync(excludePath, 'utf8');
  assert.ok(
    body.split('\n').includes('.claude/settings.local.json'),
    'the injected settings file cannot be swept into the agent PR'
  );
  assert.equal(ensureGitExcluded(wt), true, 'idempotent');
  assert.equal(
    fs.readFileSync(excludePath, 'utf8'),
    body,
    'second run appends nothing (no duplicate lines)'
  );
});

test('applyAgentPermissions: repairs a malformed permissions shape without dropping the rest', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'agentperm-'));
  fs.mkdirSync(path.join(wt, '.claude'), { recursive: true });
  fs.writeFileSync(settingsPath(wt), JSON.stringify({ permissions: 'oops', model: 'x' }));
  const r = applyAgentPermissions(wt, ['Bash(rm:*)']);
  assert.deepEqual(r.added, ['Bash(rm:*)']);
  const s = readSettings(wt);
  assert.equal(s.model, 'x');
  assert.deepEqual(s.permissions.allow, ['Bash(rm:*)']);
});
