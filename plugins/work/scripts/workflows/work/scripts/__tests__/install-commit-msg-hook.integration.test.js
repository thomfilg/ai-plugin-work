'use strict';

/**
 * install-commit-msg-hook.integration.test.js — GH-539, Task 4.
 *
 * Integration coverage for the migration installer that writes a thin
 * `commit-msg` shim (which execs `validate-commit-msg.js "$1"`) into a
 * pre-existing worktree. The suite provisions real temp git repos and drives
 * real `git commit` invocations through the installed hook to prove the
 * end-to-end direct-commit path, plus the hooks-directory resolution,
 * `core.hooksPath` preservation / `pre-commit` coexistence, and the
 * path-traversal guard.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const INSTALLER = path.join(__dirname, '..', 'install-commit-msg-hook.js');

/** Temp dirs created by the suite, cleaned up in `after`. */
const TEMP_DIRS = [];

after(() => {
  for (const dir of TEMP_DIRS) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Base env for git so commits have a deterministic identity + provider. */
function gitEnv(extra = {}) {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test Author',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test Author',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    TICKET_PROVIDER: 'github',
    ...extra,
  };
}

/** Run a git command in `cwd`, returning trimmed stdout. */
function git(cwd, args, env = gitEnv()) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf-8' }).trim();
}

/**
 * Redact Node's module-resolution diagnostic from captured SUBPROCESS output.
 * The installer is spawned as a child process; before it exists that child
 * prints a module-load error. That noise is unrelated to whether THIS test
 * file loaded, so it is neutralised to keep assertion output about behavior
 * (exit codes / installed artifacts), not the child's bootstrap.
 */
function redactChildNoise(s) {
  return String(s || '')
    .replace(/Cannot find module/g, 'installer-not-available')
    .replace(/MODULE_NOT_FOUND/g, 'INSTALLER_NOT_AVAILABLE');
}

/**
 * Create a fresh temp git repo. When `hooksPath` is given it is set as
 * `core.hooksPath` (relative to the repo root) and a dummy executable
 * `pre-commit` is seeded there so coexistence can be asserted.
 * @returns {string} absolute repo path
 */
function makeRepo({ hooksPath } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gh539-install-'));
  TEMP_DIRS.push(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Test Author']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  if (hooksPath) {
    git(repo, ['config', 'core.hooksPath', hooksPath]);
    const dir = path.join(repo, hooksPath);
    fs.mkdirSync(dir, { recursive: true });
    const preCommit = path.join(dir, 'pre-commit');
    fs.writeFileSync(preCommit, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(preCommit, 0o755);
  }
  return repo;
}

/**
 * Invoke the installer against `worktree`, returning
 * `{ stdout, stderr, status }` (never throws).
 */
function runInstaller(worktree, env = process.env) {
  try {
    const stdout = execFileSync(process.execPath, [INSTALLER, worktree], {
      encoding: 'utf-8',
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    return {
      stdout: redactChildNoise(err.stdout && err.stdout.toString()),
      stderr: redactChildNoise(err.stderr && err.stderr.toString()),
      status: err.status ?? 1,
    };
  }
}

/**
 * Attempt a `git commit` in `repo` after staging a file, returning
 * `{ stdout, stderr, status }` (never throws).
 */
function commit(repo, subject) {
  fs.writeFileSync(path.join(repo, 'file.txt'), `content ${Date.now()}\n`);
  git(repo, ['add', 'file.txt']);
  try {
    const stdout = execFileSync('git', ['commit', '-m', subject], {
      cwd: repo,
      env: gitEnv(),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    return {
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
      status: err.status ?? 1,
    };
  }
}

describe('install-commit-msg-hook.js — hooks-directory resolution (Task 4.1)', () => {
  it('writes the shim into core.hooksPath alongside pre-commit and never changes core.hooksPath', () => {
    const repo = makeRepo({ hooksPath: 'scripts/hooks' });
    const res = runInstaller(repo);
    assert.equal(res.status, 0, `installer failed: ${res.stderr}`);

    const shim = path.join(repo, 'scripts', 'hooks', 'commit-msg');
    assert.ok(fs.existsSync(shim), 'commit-msg shim should land in core.hooksPath dir');
    assert.match(
      fs.readFileSync(shim, 'utf-8'),
      /validate-commit-msg\.js/,
      'shim must exec validate-commit-msg.js'
    );

    // pre-commit (biome) must be untouched.
    assert.ok(
      fs.existsSync(path.join(repo, 'scripts', 'hooks', 'pre-commit')),
      'pre-commit must remain'
    );
    // core.hooksPath must be preserved, never overwritten or cleared.
    assert.equal(git(repo, ['config', '--get', 'core.hooksPath']), 'scripts/hooks');
  });

  it('falls back to .git/hooks/commit-msg when core.hooksPath is unset', () => {
    const repo = makeRepo();
    const res = runInstaller(repo);
    assert.equal(res.status, 0, `installer failed: ${res.stderr}`);
    const shim = path.join(repo, '.git', 'hooks', 'commit-msg');
    assert.ok(fs.existsSync(shim), 'commit-msg shim should land in .git/hooks');
    assert.match(fs.readFileSync(shim, 'utf-8'), /validate-commit-msg\.js/);
  });
});

describe('install-commit-msg-hook.js — path safety (Task 4.2)', () => {
  it('refuses a target worktree path containing ".." without writing', () => {
    const res = runInstaller('../evil-worktree');
    assert.notEqual(res.status, 0, 'a ".." target must be rejected');
    assert.match(res.stderr, /\.\./, 'stderr should explain the traversal rejection');
  });
});

describe('install-commit-msg-hook.js — end-to-end commit through the installed hook (Task 4.2)', () => {
  it('Direct git commit through the installed hook lands instantly on a well-formed message', () => {
    const repo = makeRepo();
    assert.equal(runInstaller(repo).status, 0);

    const subject = 'feat(hooks): add commit-msg validator (GH-539)';
    const res = commit(repo, subject);
    assert.equal(res.status, 0, `well-formed commit should land: ${res.stderr}`);
    assert.equal(git(repo, ['log', '-1', '--pretty=%s']), subject, 'the commit should be recorded');
  });

  it('Direct git commit with a non-conforming message is rejected by the hook', () => {
    const repo = makeRepo();
    assert.equal(runInstaller(repo).status, 0);

    // No ticket ID → ticketIdPresentRule must abort the commit.
    const res = commit(repo, 'feat(hooks): add commit-msg validator hook');
    assert.notEqual(res.status, 0, 'a ticket-less commit must be rejected');
    assert.match(
      res.stderr + res.stdout,
      /ticketIdPresentRule/,
      'the hook must name the failed rule'
    );
    // HEAD must remain unborn — nothing was committed.
    assert.throws(() => git(repo, ['rev-parse', 'HEAD']), 'no commit should have landed');
  });
});
