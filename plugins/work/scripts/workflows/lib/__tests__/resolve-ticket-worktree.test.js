'use strict';

/**
 * Tests for lib/resolve-ticket-worktree.js (ECHO-5322 issue 2).
 *
 * Covers the cwd-independent resolution order:
 *   1. ticket id + env config (WORKTREES_BASE/<REPO_NAME>-<safeTicket>)
 *   2. cwd git-detection — only when the detected toplevel differs from the
 *      plugin checkout's toplevel
 *   3. null
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const MODULE_PATH = path.resolve(__dirname, '..', 'resolve-ticket-worktree.js');
const { resolveTicketWorktree, configuredWorktreeDir, gitToplevel } = require(MODULE_PATH);

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git init failed: ${r.stderr}`);
  return dir;
}

function fakeConfig(worktreesBase, repoName = 'repo') {
  return {
    safeTicketId: (id) => id,
    worktreeDir: (id) => (worktreesBase ? path.join(worktreesBase, `${repoName}-${id}`) : null),
  };
}

// ─── configuredWorktreeDir ────────────────────────────────────────────────

test('configuredWorktreeDir: builds WORKTREES_BASE/<REPO_NAME>-<ticket> from config', () => {
  const dir = configuredWorktreeDir('TKT-1', { config: fakeConfig('/base') });
  assert.equal(dir, path.join('/base', 'repo-TKT-1'));
});

test('configuredWorktreeDir: resolves the BASE ticket for suffix ids (TKT-1/phase1)', () => {
  const dir = configuredWorktreeDir('TKT-1/phase1', { config: fakeConfig('/base') });
  assert.equal(dir, path.join('/base', 'repo-TKT-1'));
});

test('configuredWorktreeDir: null for empty ticket or missing config functions', () => {
  assert.equal(configuredWorktreeDir('', { config: fakeConfig('/base') }), null);
  assert.equal(configuredWorktreeDir(null, { config: fakeConfig('/base') }), null);
  assert.equal(configuredWorktreeDir('TKT-1', { config: {} }), null);
});

// ─── resolveTicketWorktree: config-first resolution ───────────────────────

test('resolveTicketWorktree: resolves configured worktree from an unrelated non-git cwd', () => {
  const tmp = makeTmpDir('rtw-config-');
  try {
    const worktree = path.join(tmp, 'wt', 'repo-TKT-9');
    fs.mkdirSync(worktree, { recursive: true });
    const unrelatedCwd = path.join(tmp, 'tasks', 'TKT-9'); // simulates the tasks dir
    fs.mkdirSync(unrelatedCwd, { recursive: true });
    const got = resolveTicketWorktree('TKT-9', {
      config: fakeConfig(path.join(tmp, 'wt')),
      cwd: unrelatedCwd,
      pluginToplevel: null,
    });
    assert.equal(got, worktree);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveTicketWorktree: configured worktree wins over a valid git cwd', () => {
  const tmp = makeTmpDir('rtw-config-wins-');
  try {
    const worktree = path.join(tmp, 'wt', 'repo-TKT-10');
    fs.mkdirSync(worktree, { recursive: true });
    const otherRepo = initGitRepo(path.join(tmp, 'other-repo'));
    const got = resolveTicketWorktree('TKT-10', {
      config: fakeConfig(path.join(tmp, 'wt')),
      cwd: otherRepo,
      pluginToplevel: null,
    });
    assert.equal(got, worktree);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── resolveTicketWorktree: guarded cwd fallback ──────────────────────────

test('resolveTicketWorktree: falls back to cwd git toplevel when config dir does not exist', () => {
  const tmp = makeTmpDir('rtw-fallback-');
  try {
    const repo = initGitRepo(path.join(tmp, 'ticket-repo'));
    const nested = path.join(repo, 'src', 'deep');
    fs.mkdirSync(nested, { recursive: true });
    const got = resolveTicketWorktree('TKT-11', {
      config: fakeConfig(path.join(tmp, 'nonexistent-base')),
      cwd: nested,
      pluginToplevel: path.join(tmp, 'some-other-plugin-checkout'),
    });
    assert.equal(fs.realpathSync(got), fs.realpathSync(repo));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveTicketWorktree: REFUSES cwd fallback when cwd toplevel IS the plugin checkout', () => {
  const tmp = makeTmpDir('rtw-plugin-guard-');
  try {
    const pluginRepo = initGitRepo(path.join(tmp, 'plugin-checkout'));
    const got = resolveTicketWorktree('TKT-12', {
      config: fakeConfig(path.join(tmp, 'nonexistent-base')),
      cwd: pluginRepo,
      pluginToplevel: pluginRepo,
    });
    assert.equal(got, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveTicketWorktree: null when config misses and cwd is not a git repo', () => {
  const tmp = makeTmpDir('rtw-null-');
  try {
    const got = resolveTicketWorktree('TKT-13', {
      config: fakeConfig(path.join(tmp, 'nonexistent-base')),
      cwd: os.tmpdir(),
      pluginToplevel: null,
    });
    // os.tmpdir() is not expected to be a git repo; guard anyway.
    if (gitToplevel(os.tmpdir()) === null) assert.equal(got, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── real env-config path (subprocess: fresh config module) ───────────────

test('resolveTicketWorktree: resolves via real config from WORKTREES_BASE/REPO_NAME env in a fresh process', () => {
  const tmp = makeTmpDir('rtw-env-');
  try {
    const worktreesBase = path.join(tmp, 'w-repo');
    const worktree = path.join(worktreesBase, 'myrepo-TKT-77');
    fs.mkdirSync(worktree, { recursive: true });
    const cwd = path.join(worktreesBase, 'tasks', 'TKT-77');
    fs.mkdirSync(cwd, { recursive: true });
    const r = spawnSync(
      process.execPath,
      [
        '-e',
        `process.stdout.write(String(require(${JSON.stringify(MODULE_PATH)}).resolveTicketWorktree('TKT-77') || 'NULL'))`,
      ],
      {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          WORKTREES_BASE: worktreesBase,
          REPO_NAME: 'myrepo',
          TASKS_BASE: path.join(worktreesBase, 'tasks'),
          TICKET_PROVIDER: '',
        },
      }
    );
    assert.equal(r.status, 0, `subprocess failed: ${r.stderr}`);
    assert.equal(r.stdout, worktree);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
