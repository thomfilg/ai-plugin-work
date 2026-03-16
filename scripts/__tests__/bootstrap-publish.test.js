const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'bootstrap-publish.js');

function run(args, env = {}) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function runWithError(args, env = {}) {
  try {
    run(args, env);
    assert.fail('Expected process to exit with error');
  } catch (err) {
    return err;
  }
}

describe('bootstrap-publish.js', () => {
  describe('argument validation', () => {
    it('exits 1 with no arguments', () => {
      const err = runWithError([]);
      assert.equal(err.status, 1);
    });

    it('exits 1 with missing arguments', () => {
      const err = runWithError(['--commit', '/tmp']);
      assert.equal(err.status, 1);
    });

    it('exits 1 with unknown mode', () => {
      const err = runWithError(['--unknown', '/tmp', 'branch', 'TICKET-1']);
      assert.equal(err.status, 1);
    });
  });

  describe('--commit mode', () => {
    it('skips when ENABLE_EMPTY_COMMIT is not set', () => {
      const output = run(['--commit', '/tmp', 'branch', 'TICKET-1'], { ENABLE_EMPTY_COMMIT: '' });
      assert.match(output, /skipping/i);
    });
  });

  describe('--pr mode', () => {
    it('skips when ENABLE_DRAFT_PR is not set', () => {
      const output = run(['--pr', '/tmp', 'branch', 'TICKET-1'], { ENABLE_EMPTY_COMMIT: '1', ENABLE_DRAFT_PR: '' });
      assert.match(output, /skipping/i);
    });

    it('skips when ENABLE_EMPTY_COMMIT is not set', () => {
      const output = run(['--pr', '/tmp', 'branch', 'TICKET-1'], { ENABLE_EMPTY_COMMIT: '', ENABLE_DRAFT_PR: '1' });
      assert.match(output, /skipping/i);
    });

    it('skips when both env vars are not set', () => {
      const output = run(['--pr', '/tmp', 'branch', 'TICKET-1'], { ENABLE_EMPTY_COMMIT: '', ENABLE_DRAFT_PR: '' });
      assert.match(output, /skipping/i);
    });
  });
});
