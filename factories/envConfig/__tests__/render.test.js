'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  renderGhTokenBlock,
  renderGitIdentityBlock,
  quoteEnvValue,
  renderVarLine,
  renderEnvrc,
  mergeEnvContent,
} = require('../render');

const schema = {
  plugin: 'demo',
  prefixes: ['DEMO_'],
  vars: {
    DEMO_NAME: { type: 'string', default: 'fallback', description: 'The name', section: 'Core' },
    DEMO_FLAG: { type: 'bool01', default: '0', description: 'A flag', section: 'Core' },
    DEMO_TUNE: {
      type: 'number',
      default: '9',
      description: 'Tunable',
      section: 'Core',
      advanced: true,
    },
  },
};

test('gh token block pins the account and fails loudly', () => {
  const block = renderGhTokenBlock('thomfilg');
  assert.match(block, /_gh_token=\$\(gh auth token -u thomfilg 2>\/dev\/null\)/);
  assert.match(block, /export GH_TOKEN="\$_gh_token"/);
  assert.match(block, /unset GH_TOKEN/);
  assert.match(
    block,
    /log_status "⚠ GH_TOKEN unset: 'gh auth token -u thomfilg' failed — run 'gh auth login -u thomfilg' \(gh is using stored creds for now\)"/
  );
  assert.match(block, /unset _gh_token$/);
});

test('git identity block: default defers to git config, custom pins literals', () => {
  const def = renderGitIdentityBlock({ mode: 'default' });
  assert.match(def, /export GIT_AUTHOR_NAME="\$\(git config user\.name\)"/);
  assert.match(def, /export GIT_COMMITTER_EMAIL="\$\(git config user\.email\)"/);
  const custom = renderGitIdentityBlock({ mode: 'custom', name: 'Jane', email: 'j@x.dev' });
  assert.match(custom, /export GIT_AUTHOR_NAME="Jane"/);
  assert.match(custom, /export GIT_COMMITTER_EMAIL="j@x\.dev"/);
});

test('renderVarLine exports set values and comments unset ones', () => {
  const def = schema.vars.DEMO_NAME;
  assert.equal(renderVarLine('DEMO_NAME', def, 'plain'), 'export DEMO_NAME=plain');
  assert.equal(renderVarLine('DEMO_NAME', def, 'two words'), 'export DEMO_NAME="two words"');
  assert.equal(renderVarLine('DEMO_NAME', def, undefined), '# export DEMO_NAME=fallback');
});

test('quoting: $VAR refs expand (double quotes), command types stay literal', () => {
  const pathDef = { type: 'path', default: '', description: 'p', section: 'S' };
  const cmdDef = { type: 'command', default: '', description: 'c', section: 'S' };
  assert.equal(
    renderVarLine('DEMO_DIR', pathDef, '$HOME/my worktrees'),
    'export DEMO_DIR="$HOME/my worktrees"'
  );
  assert.equal(
    renderVarLine('DEMO_CMD', cmdDef, 'pnpm test $CHANGED_FILES'),
    "export DEMO_CMD='pnpm test $CHANGED_FILES'"
  );
  assert.equal(quoteEnvValue('say "hi"'), '"say \\"hi\\""');
});

test('renderEnvrc assembles gh block, identity, and plugin sections', () => {
  const out = renderEnvrc({
    ghUser: 'someone',
    gitIdentity: { mode: 'default' },
    schemas: [schema],
    values: { DEMO_NAME: 'set-me' },
  });
  assert.match(out, /# ─── Git \/ GitHub /);
  assert.match(out, /gh auth token -u someone/);
  assert.match(out, /# ─── demo: Core /);
  assert.match(out, /export DEMO_NAME=set-me/);
  assert.match(out, /# export DEMO_FLAG=0/);
  assert.ok(!out.includes('DEMO_TUNE'), 'unset advanced vars are omitted');
});

test('mergeEnvContent updates in place, uncomments, and appends', () => {
  const existing = ['# header', 'KEEP=1', '# KNOWN=old', 'CHANGE=old', ''].join('\n');
  const merged = mergeEnvContent(existing, { CHANGE: 'new', KNOWN: 'now-set', ADDED: 'x' });
  assert.match(merged, /KEEP=1/);
  assert.match(merged, /^KNOWN=now-set$/m);
  assert.match(merged, /^CHANGE=new$/m);
  assert.match(merged, /^ADDED=x$/m);
});

test('mergeEnvContent exportPrefix preserves .envrc form', () => {
  const merged = mergeEnvContent('export A=1\n', { A: '2', B: '3' }, { exportPrefix: true });
  assert.match(merged, /^export A=2$/m);
  assert.match(merged, /^export B=3$/m);
});

test('mergeEnvContent quotes values that need it (spaces stay one assignment)', () => {
  const merged = mergeEnvContent(
    'export DIR=/old\n',
    { DIR: '/home/user/my worktrees', REF: '$HOME/tasks' },
    { exportPrefix: true }
  );
  assert.match(merged, /^export DIR="\/home\/user\/my worktrees"$/m);
  assert.match(merged, /^export REF="\$HOME\/tasks"$/m);
});
