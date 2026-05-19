'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pr_merged_check = require('../lib/phases/pr_merged_check');
const branch_cleanup = require('../lib/phases/branch_cleanup');
const tmux_cleanup = require('../lib/phases/tmux_cleanup');
const state_archive = require('../lib/phases/state_archive');

function makeTasksDir(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-phases-'));
  const tasksDir = path.join(root, 'tasks', 'ECHO-7777');
  fs.mkdirSync(tasksDir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(tasksDir, name), contents);
  }
  return { root, tasksDir, worktreeRoot: root, ticket: 'ECHO-7777' };
}

test('pr_merged_check blocks when cleanup-context.json is missing', () => {
  const { root, tasksDir, worktreeRoot } = makeTasksDir();
  const r = pr_merged_check.validate({ tasksDir, worktreeRoot, ticket: 'ECHO-7777' });
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes('cleanup-context.json'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('pr_merged_check advances when state=MERGED', () => {
  const original = pr_merged_check.fetchPrState;
  const ctx = makeTasksDir({
    'cleanup-context.json': JSON.stringify({ prNumber: 1740 }),
  });
  pr_merged_check.fetchPrState = () => ({ state: 'MERGED', mergedAt: '2026-05-19T18:00:00Z' });
  try {
    const r = pr_merged_check.validate(ctx);
    assert.equal(r.ok, true);
  } finally {
    pr_merged_check.fetchPrState = original;
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('pr_merged_check HARD-BLOCKS when state=OPEN (not WAITs)', () => {
  const original = pr_merged_check.fetchPrState;
  const ctx = makeTasksDir({
    'cleanup-context.json': JSON.stringify({ prNumber: 1740 }),
  });
  pr_merged_check.fetchPrState = () => ({ state: 'OPEN', mergedAt: null });
  try {
    const r = pr_merged_check.validate(ctx);
    assert.equal(r.ok, false);
    assert.ok(r.errors[0].includes('OPEN'));
  } finally {
    pr_merged_check.fetchPrState = original;
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('branch_cleanup blocks without sentinel', () => {
  const { root, tasksDir } = makeTasksDir({
    'cleanup-context.json': JSON.stringify({ branch: 'feature/x' }),
  });
  const r = branch_cleanup.validate({ tasksDir, ticket: 'ECHO-7777' });
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes('.branch-cleaned'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('branch_cleanup passes with sentinel present', () => {
  const { root, tasksDir } = makeTasksDir({
    'cleanup-context.json': JSON.stringify({ branch: 'feature/x' }),
    '.branch-cleaned': 'ok',
  });
  const r = branch_cleanup.validate({ tasksDir, ticket: 'ECHO-7777' });
  assert.equal(r.ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('tmux_cleanup auto-passes when no sessions match ticket', () => {
  const original = tmux_cleanup.listSessionsMatching;
  const { root, tasksDir } = makeTasksDir();
  tmux_cleanup.listSessionsMatching = () => [];
  try {
    const r = tmux_cleanup.validate({ tasksDir, ticket: 'ECHO-7777' });
    assert.equal(r.ok, true);
    assert.ok(r.summary.includes('no matching'));
  } finally {
    tmux_cleanup.listSessionsMatching = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tmux_cleanup blocks when matching sessions exist without sentinel', () => {
  const original = tmux_cleanup.listSessionsMatching;
  const { root, tasksDir } = makeTasksDir();
  tmux_cleanup.listSessionsMatching = () => ['ECHO-7777-dev', 'ECHO-7777-listen'];
  try {
    const r = tmux_cleanup.validate({ tasksDir, ticket: 'ECHO-7777' });
    assert.equal(r.ok, false);
    assert.ok(r.errors[0].includes('ECHO-7777-dev'));
  } finally {
    tmux_cleanup.listSessionsMatching = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('state_archive blocks on missing required sections', () => {
  const { root, tasksDir } = makeTasksDir({
    'cleanup-summary.md': '## Branch\nx\nStatus: DONE\n',
  });
  const r = state_archive.validate({ tasksDir });
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes('missing section'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('state_archive passes when all sections + Status present', () => {
  const md = [
    '## Branch',
    'deleted feature/x locally and remote',
    '## Tmux sessions',
    'killed ECHO-7777-dev',
    '## Worktree',
    'left at /home/x/worktrees/ECHO-7777 for manual removal',
    '',
    'Status: PARTIAL',
  ].join('\n');
  const { root, tasksDir } = makeTasksDir({ 'cleanup-summary.md': md });
  const r = state_archive.validate({ tasksDir });
  assert.equal(r.ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});
