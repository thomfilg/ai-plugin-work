'use strict';

// GH-539: commit-and-push.js is the ONE sanctioned commit path. These tests
// cover the pure argument parser + failure formatters and the CLI's fail-fast
// exit codes (usage / validation). The git side effects (add/commit/push) are
// intentionally not exercised here — they run via child_process against a real
// repo and are covered by the /work integration path.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  parseArgs,
  validate,
  formatValidationFailure,
  formatIdentityFailure,
} = require('../commit-and-push');

const SCRIPT = path.join(__dirname, '..', 'commit-and-push.js');

describe('commit-and-push — parseArgs', () => {
  it('reads -m and defaults push=true, cwd=process.cwd()', () => {
    const opts = parseArgs(['-m', 'feat(x): add thing (#1)']);
    assert.equal(opts.message, 'feat(x): add thing (#1)');
    assert.equal(opts.push, true);
    assert.equal(opts.cwd, process.cwd());
  });

  it('accepts a positional message', () => {
    assert.equal(parseArgs(['feat(x): add thing (#1)']).message, 'feat(x): add thing (#1)');
  });

  it('honours --no-push and --cwd', () => {
    const opts = parseArgs(['--cwd', '/tmp/wt', '--no-push', '-m', 'fix(y): patch (#2)']);
    assert.equal(opts.cwd, '/tmp/wt');
    assert.equal(opts.push, false);
    assert.equal(opts.message, 'fix(y): patch (#2)');
  });

  it('throws a usage error when no message is provided', () => {
    assert.throws(() => parseArgs([]), /usage: commit-and-push.js/);
    assert.throws(() => parseArgs(['--no-push']), /usage: commit-and-push.js/);
  });
});

describe('commit-and-push — failure formatters', () => {
  it('formatValidationFailure names the rule + hint', () => {
    const out = formatValidationFailure({
      rule: 'semanticFormatRule',
      reason: 'bad',
      hint: 'fix it',
    });
    assert.match(out, /commit rejected: semanticFormatRule \(bad\)/);
    assert.match(out, /Hint: fix it/);
  });

  it('formatIdentityFailure names the offending identity', () => {
    const out = formatIdentityFailure({ source: 'global', name: 'Claude', email: 'c@ai' });
    assert.match(out, /looks like an AI tool/);
    assert.match(out, /Claude <c@ai>/);
  });
});

describe('commit-and-push — validate()', () => {
  it('rejects a non-semantic message before touching git', () => {
    const err = validate('just some words', process.cwd());
    assert.ok(err, 'expected a non-null failure string');
    assert.match(err, /commit rejected:/);
  });
});

describe('commit-and-push — CLI exit codes', () => {
  it('exits 1 with a usage error when no message is given', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /usage: commit-and-push.js/);
  });

  it('exits 1 and rejects a non-conforming message (never reaches git)', () => {
    const r = spawnSync('node', [SCRIPT, '-m', 'not a semantic commit'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /commit rejected:/);
  });
});
