'use strict';

/**
 * Tests for scripts/install-git-hooks.js.
 *
 * The assertions that matter most are the end-to-end ones: after installing, a
 * REAL `git commit` carrying an attribution trailer is rejected by git itself,
 * a real commit whose staged FILES carry one is rejected too, and a clean
 * commit lands. Everything else here guards the installer's manners — it must
 * never clobber somebody else's hook, and never delete one it did not write.
 *
 * Run with: node --test plugins/ghostwriter/scripts/__tests__/install-git-hooks.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const INSTALLER = path.resolve(__dirname, '..', 'install-git-hooks.js');
const TOOL = ['Cl', 'aude'].join('');

let repo;

function git(...args) {
  return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 15000 });
}

function install(...args) {
  const result = spawnSync(process.execPath, [INSTALLER, '--repo', repo, ...args], {
    encoding: 'utf8',
    timeout: 15000,
  });
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function hookPath(name = 'commit-msg') {
  return path.join(repo, '.git', 'hooks', name);
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostwriter-install-'));
  spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  git('config', 'user.name', 'Ada Lovelace');
  git('config', 'user.email', 'ada@example.com');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'content\n');
  git('add', '-A');
});

afterEach(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

describe('install-git-hooks — lifecycle', () => {
  it('reports absent, installs both hooks, then reports ours', () => {
    assert.match(install('--status').stdout, /commit-msg hook is absent/);
    assert.match(install('--status').stdout, /pre-commit hook is absent/);
    const result = install();
    assert.equal(result.code, 0);
    for (const name of ['commit-msg', 'pre-commit']) {
      assert.match(result.stdout, new RegExp(`${name} hook installed at`));
      assert.ok(fs.statSync(hookPath(name)).mode & 0o111, `${name} must be executable`);
    }
    assert.match(install('--status').stdout, /commit-msg hook is ours/);
    assert.match(install('--status').stdout, /pre-commit hook is ours/);
  });

  it('is idempotent', () => {
    assert.equal(install().code, 0, 'first install');
    assert.equal(install().code, 0, 'second install must be a no-op, not a refusal');
    assert.match(install('--status').stdout, /is ours/);
  });

  it('uninstalls its own hooks and tolerates a missing one', () => {
    install();
    assert.equal(install('--uninstall').code, 0);
    assert.equal(fs.existsSync(hookPath()), false);
    assert.equal(fs.existsSync(hookPath('pre-commit')), false);
    assert.equal(install('--uninstall').code, 0);
  });

  it('rejects unknown options', () => {
    assert.equal(install('--bogus').code, 2);
  });

  it('reports a usage error outside a git repository', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostwriter-plain-'));
    try {
      const result = spawnSync(process.execPath, [INSTALLER, '--repo', plain], {
        encoding: 'utf8',
        timeout: 15000,
        env: { ...process.env, GIT_CEILING_DIRECTORIES: os.tmpdir() },
      });
      assert.equal(result.status, 2);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('install-git-hooks — other people’s hooks', () => {
  it('refuses to overwrite a foreign hook, and says how to chain instead', () => {
    fs.mkdirSync(path.dirname(hookPath()), { recursive: true });
    fs.writeFileSync(hookPath(), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const result = install();
    assert.equal(result.code, 1);
    assert.match(result.stderr, /already exists/);
    assert.match(result.stderr, /ghostwriter-check\.js/);
    assert.match(fs.readFileSync(hookPath(), 'utf8'), /exit 0/, 'foreign hook must survive');
  });

  it('replaces a foreign hook only with --force', () => {
    fs.mkdirSync(path.dirname(hookPath()), { recursive: true });
    fs.writeFileSync(hookPath(), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    assert.equal(install('--force').code, 0);
    assert.match(install('--status').stdout, /is ours/);
  });

  // "Install both hooks" is one operation with one outcome. Installing the
  // first and then refusing the second reports failure while leaving a new
  // hook running, which is a state nobody chose.
  it('installs neither when one destination is somebody else’s', () => {
    fs.mkdirSync(path.dirname(hookPath()), { recursive: true });
    fs.writeFileSync(hookPath('pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const result = install();
    assert.equal(result.code, 1);
    assert.match(result.stderr, /nothing was installed/);
    assert.equal(fs.existsSync(hookPath('commit-msg')), false, 'the other hook must not land');
    assert.match(fs.readFileSync(hookPath('pre-commit'), 'utf8'), /exit 0/);
  });

  // The preflight catches the expected refusal. This is the unexpected one —
  // a directory that cannot be written partway through — where "both or
  // neither" has to hold just as firmly.
  it('leaves nothing behind when a write fails partway', () => {
    const hooksDir = path.dirname(hookPath());
    fs.mkdirSync(hooksDir, { recursive: true });
    // A directory where the second hook's file must go: writing it throws
    // EISDIR, after the first hook has already landed.
    fs.mkdirSync(hookPath('pre-commit'), { recursive: true });
    const result = install();
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Nothing was left behind/);
    assert.equal(
      fs.existsSync(hookPath('commit-msg')),
      false,
      'the first hook must be rolled back'
    );
  });

  // `writeFileSync` can succeed and the `chmod` after it fail. A hook recorded
  // only on success is a hook the rollback never hears about, and the command
  // would report a clean restoration over a file still sitting on disk.
  it('rolls back a hook whose write succeeded but whose chmod did not', () => {
    const hooksDir = path.dirname(hookPath());
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.mkdirSync(hookPath('pre-commit'), { recursive: true });
    const result = install();
    assert.equal(result.code, 1);
    assert.equal(fs.existsSync(hookPath('commit-msg')), false);
    assert.match(result.stderr, /Nothing was left behind/);
  });

  // A failed UPGRADE is the case a create-only rollback gets wrong twice:
  // deleting the old hook leaves no guard, leaving the new one leaves whatever
  // the failed write managed to put there. Restoring is neither.
  it('restores a previous ghostwriter hook when the install fails', () => {
    assert.equal(install().code, 0);
    const old = '#!/usr/bin/env sh\n# ghostwriter-commit-msg v1\n# OLD VERSION\nexit 0\n';
    fs.writeFileSync(hookPath('commit-msg'), old, { mode: 0o755 });
    fs.rmSync(hookPath('pre-commit'));
    fs.mkdirSync(hookPath('pre-commit'));

    const result = install();
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Nothing was left behind/);
    assert.equal(
      fs.readFileSync(hookPath('commit-msg'), 'utf8'),
      old,
      'the hook that was already here must come back exactly as it was'
    );
  });

  it('never deletes a foreign hook', () => {
    fs.mkdirSync(path.dirname(hookPath()), { recursive: true });
    fs.writeFileSync(hookPath(), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    assert.equal(install('--uninstall').code, 1);
    assert.equal(fs.existsSync(hookPath()), true);
  });
});

describe('install-git-hooks — real commits', () => {
  it('git itself rejects an attributed message and accepts a clean one', () => {
    install();
    const rejected = git('commit', '-m', `feat: x\n\nCo-Authored-By: ${TOOL} <a@b>`);
    assert.notEqual(rejected.status, 0, 'the attributed commit must not land');
    assert.match(rejected.stderr, /ghostwriter:/);

    const accepted = git('commit', '-m', 'feat: add the file (#12)');
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(git('log', '--oneline').stdout, /feat: add the file/);
  });

  // The message half is not the whole change. A footer written into a FILE by
  // an editor, a script or a second agent reaches the pull request under a
  // perfectly clean commit message.
  it('git itself rejects a staged file that carries a footer', () => {
    install();
    fs.writeFileSync(path.join(repo, 'src.js'), `// Generated with ${TOOL} Code\nconst a = 1;\n`);
    git('add', '-A');
    const rejected = git('commit', '-m', 'feat: add src (#12)');
    assert.notEqual(rejected.status, 0, 'the attributed file must not land');
    assert.match(rejected.stderr, /ghostwriter:/);
    assert.match(rejected.stderr, /src\.js/);
  });

  it('lets the same commit through once the footer is gone', () => {
    install();
    fs.writeFileSync(path.join(repo, 'src.js'), 'const a = 1;\n');
    git('add', '-A');
    const accepted = git('commit', '-m', 'feat: add src (#12)');
    assert.equal(accepted.status, 0, accepted.stderr);
  });
});
