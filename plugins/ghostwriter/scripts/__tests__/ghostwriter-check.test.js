'use strict';

/**
 * Tests for scripts/ghostwriter-check.js — the CLI the installed git hook
 * calls. Spawned as a real process because the exit code IS the contract:
 * 0 clean, 1 attribution found, 2 usage error.
 *
 * Run with: node --test plugins/ghostwriter/scripts/__tests__/ghostwriter-check.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.resolve(__dirname, '..', 'ghostwriter-check.js');
const TOOL = ['Cl', 'aude'].join('');

let workDir;

function run(args, { input, env = {} } = {}) {
  const merged = { ...process.env, ...env };
  if (!('GHOSTWRITER_ALLOW_ATTRIBUTION' in env)) delete merged.GHOSTWRITER_ALLOW_ATTRIBUTION;
  const result = spawnSync(process.execPath, [CLI, ...args], {
    input: input === undefined ? '' : input,
    encoding: 'utf8',
    timeout: 15000,
    env: merged,
  });
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function writeMessage(name, text) {
  const file = path.join(workDir, name);
  fs.writeFileSync(file, text);
  return file;
}

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostwriter-cli-'));
});

after(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

describe('ghostwriter-check — message files (the git commit-msg contract)', () => {
  it('accepts a clean message', () => {
    const file = writeMessage('clean.txt', 'feat(hooks): add the guard (#12)\n');
    assert.equal(run([file]).code, 0);
  });

  it('rejects an attribution trailer and explains why', () => {
    const file = writeMessage('dirty.txt', `feat: x\n\nCo-Authored-By: ${TOOL} <a@b>\n`);
    const result = run([file]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /aiCoAuthorTrailer/);
    assert.match(result.stderr, /↳ Fix:/);
  });

  it('ignores the comment block git appends to the template', () => {
    const file = writeMessage(
      'commented.txt',
      `feat: x\n\n# Co-Authored-By: ${TOOL} <a@b>\n# Please enter the commit message\n`
    );
    assert.equal(run([file]).code, 0, 'commented-out lines never reach the commit');
  });

  it('reports a usage error for an unreadable file', () => {
    assert.equal(run([path.join(workDir, 'missing.txt')]).code, 2);
  });
});

describe('ghostwriter-check — other input modes', () => {
  it('validates literal text via --message', () => {
    assert.equal(run(['--message', 'feat: add the guard (#12)']).code, 0);
    assert.equal(run(['--message', `feat: x\n\nGenerated with ${TOOL} Code`]).code, 1);
  });

  it('validates a message on stdin via -', () => {
    assert.equal(run(['-'], { input: 'feat: x (#12)\n' }).code, 0);
    assert.equal(run(['-'], { input: `feat: x\n\nCo-Authored-By: ${TOOL} <a@b>\n` }).code, 1);
  });

  it('validates a repository identity via --identity', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostwriter-cli-repo-'));
    try {
      spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
      spawnSync('git', ['-C', repo, 'config', 'user.name', TOOL], { encoding: 'utf8' });
      spawnSync('git', ['-C', repo, 'config', 'user.email', 'noreply@example.com'], {
        encoding: 'utf8',
      });
      const result = run(['--identity', repo]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /aiIdentity/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects unknown options and empty invocation with a usage error', () => {
    assert.equal(run(['--bogus']).code, 2);
    assert.equal(run([]).code, 2);
    assert.equal(run(['--message']).code, 2);
  });
});

describe('ghostwriter-check — the operator override', () => {
  it('passes everything when the operator set the override', () => {
    const file = writeMessage('override.txt', `feat: x\n\nCo-Authored-By: ${TOOL} <a@b>\n`);
    assert.equal(run([file], { env: { GHOSTWRITER_ALLOW_ATTRIBUTION: '1' } }).code, 0);
  });
});
