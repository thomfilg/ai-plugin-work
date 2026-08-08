'use strict';

/**
 * Tests for scripts/install-commit-msg-hook.js.
 *
 * The assertion that matters most is the end-to-end one: after installing, a
 * REAL `git commit` carrying an attribution trailer is rejected by git itself,
 * and a clean one lands. Everything else here guards the installer's manners —
 * it must never clobber somebody else's commit-msg hook, and it must never
 * delete a hook it did not write.
 *
 * Run with: node --test plugins/ghostwriter/scripts/__tests__/install-commit-msg-hook.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const INSTALLER = path.resolve(__dirname, '..', 'install-commit-msg-hook.js');
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

function hookPath() {
  return path.join(repo, '.git', 'hooks', 'commit-msg');
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

describe('install-commit-msg-hook — lifecycle', () => {
  it('reports absent, installs, then reports ours', () => {
    assert.match(install('--status').stdout, /is absent/);
    const result = install();
    assert.equal(result.code, 0);
    assert.match(result.stdout, /installed at/);
    assert.match(install('--status').stdout, /is ours/);
    assert.ok(fs.statSync(hookPath()).mode & 0o111, 'hook must be executable');
  });

  it('is idempotent', () => {
    assert.equal(install().code, 0, 'first install');
    assert.equal(install().code, 0, 'second install must be a no-op, not a refusal');
    assert.match(install('--status').stdout, /is ours/);
  });

  it('uninstalls its own hook and tolerates a missing one', () => {
    install();
    assert.equal(install('--uninstall').code, 0);
    assert.equal(fs.existsSync(hookPath()), false);
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

describe('install-commit-msg-hook — other people’s hooks', () => {
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

  it('never deletes a foreign hook', () => {
    fs.mkdirSync(path.dirname(hookPath()), { recursive: true });
    fs.writeFileSync(hookPath(), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    assert.equal(install('--uninstall').code, 1);
    assert.equal(fs.existsSync(hookPath()), true);
  });
});

describe('install-commit-msg-hook — real commits', () => {
  it('git itself rejects an attributed message and accepts a clean one', () => {
    install();
    const rejected = git('commit', '-m', `feat: x\n\nCo-Authored-By: ${TOOL} <a@b>`);
    assert.notEqual(rejected.status, 0, 'the attributed commit must not land');
    assert.match(rejected.stderr, /ghostwriter:/);

    const accepted = git('commit', '-m', 'feat: add the file (#12)');
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(git('log', '--oneline').stdout, /feat: add the file/);
  });
});
