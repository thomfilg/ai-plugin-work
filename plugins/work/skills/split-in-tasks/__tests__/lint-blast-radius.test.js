'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MODULE_PATH = path.resolve(__dirname, '..', 'lib', 'lint-blast-radius.js');
const FIXTURE_5353 = path.resolve(__dirname, 'fixtures', 'echo-5353');

describe('lint-blast-radius — resolveLintCommand (shell-metacharacter guard)', () => {
  it('returns null when package.json has no lint script', () => {
    const { resolveLintCommand } = require(MODULE_PATH);
    const pkg = { scripts: { build: 'echo build' } };
    const result = resolveLintCommand(pkg);
    assert.equal(result, null, 'expected null when scripts.lint missing');
  });

  it('returns the lint command string when scripts.lint is safe', () => {
    const { resolveLintCommand } = require(MODULE_PATH);
    const pkg = { scripts: { lint: 'eslint . --format json' } };
    const result = resolveLintCommand(pkg);
    assert.equal(typeof result, 'string', 'expected a string command');
    assert.match(result, /eslint/);
  });

  it('rejects shell metacharacter `;` and returns null', () => {
    const { resolveLintCommand } = require(MODULE_PATH);
    const pkg = { scripts: { lint: 'eslint .; rm -rf /' } };
    const result = resolveLintCommand(pkg);
    assert.equal(result, null, 'expected null when `;` present');
  });

  it('rejects shell metacharacter `&&` and returns null', () => {
    const { resolveLintCommand } = require(MODULE_PATH);
    const pkg = { scripts: { lint: 'eslint . && cat /etc/passwd' } };
    const result = resolveLintCommand(pkg);
    assert.equal(result, null, 'expected null when `&&` present');
  });

  it('rejects backticks and returns null', () => {
    const { resolveLintCommand } = require(MODULE_PATH);
    const pkg = { scripts: { lint: 'eslint `whoami`' } };
    const result = resolveLintCommand(pkg);
    assert.equal(result, null, 'expected null when backticks present');
  });
});

describe('lint-blast-radius — scan on echo-5353 fixture (static-parse fallback)', () => {
  it('parses eslint-output.json and emits a Pass C warning naming file, line, and rule no-test-focus', () => {
    const { scan } = require(MODULE_PATH);
    const out = scan({
      projectRoot: FIXTURE_5353,
      lintCommand: null,
      filesInScope: new Set(),
    });
    assert.ok(out, 'scan must return a result');
    assert.ok(Array.isArray(out.warnings), 'expected warnings array');
    assert.ok(out.warnings.length >= 1, 'expected at least one warning');
    const w = out.warnings[0];
    assert.equal(w.kind, 'C', 'expected Pass C warning');
    const blob = `${w.message || ''} ${w.hint || ''}`;
    assert.match(blob, /radial-pixel-table\.test\.ts/, 'expected file name in warning');
    assert.match(blob, /\b17\b/, 'expected line 17 in warning');
    assert.match(blob, /no-test-focus/, 'expected rule id in warning');
  });

  it('warning includes the three operator-resolution option strings', () => {
    const { scan } = require(MODULE_PATH);
    const out = scan({
      projectRoot: FIXTURE_5353,
      lintCommand: null,
      filesInScope: new Set(),
    });
    const w = out.warnings[0];
    const blob = `${w.message || ''} ${w.hint || ''}`;
    assert.match(blob, /\(a\) add a Task 0/, 'expected option (a)');
    assert.match(blob, /\(b\) accept blast-radius takeover/, 'expected option (b)');
    assert.match(blob, /\(c\) confirm with brief author/, 'expected option (c)');
  });

  it('warning includes a `Searched: <path>` note when falling back to static parse', () => {
    const { scan } = require(MODULE_PATH);
    const out = scan({
      projectRoot: FIXTURE_5353,
      lintCommand: null,
      filesInScope: new Set(),
    });
    const w = out.warnings[0];
    const blob = `${w.message || ''} ${w.hint || ''}`;
    assert.match(
      blob,
      /Searched:\s*\S*eslint-output\.json/,
      'expected Searched: note with path to eslint-output.json'
    );
  });

  it('suppresses warning when violating file IS in scope', () => {
    const { scan } = require(MODULE_PATH);
    const out = scan({
      projectRoot: FIXTURE_5353,
      lintCommand: null,
      filesInScope: new Set(['radial-pixel-table.test.ts']),
    });
    assert.ok(Array.isArray(out.warnings), 'expected warnings array');
    assert.equal(out.warnings.length, 0, 'expected zero warnings when file is in scope');
  });
});

describe('lint-blast-radius — fail-open subprocess behavior', () => {
  it('emits a `lint pre-check skipped:` warning when given a non-existent command, and does not throw', () => {
    const { scan } = require(MODULE_PATH);
    let out;
    assert.doesNotThrow(() => {
      out = scan({
        projectRoot: FIXTURE_5353,
        lintCommand: '/nonexistent/path/to/binary-that-does-not-exist-xyz',
        filesInScope: new Set(),
      });
    }, 'scan must not throw on subprocess failure');
    assert.ok(out, 'scan must still return a result');
    assert.ok(Array.isArray(out.warnings), 'expected warnings array');
    const skipped = out.warnings.find((w) =>
      /lint pre-check skipped:/i.test(`${w.message || ''} ${w.hint || ''}`)
    );
    assert.ok(skipped, 'expected a `lint pre-check skipped:` warning');
  });

  it('emits a `lint pre-check skipped:` warning when lintCommand contains shell metacharacters, without executing', () => {
    const { scan } = require(MODULE_PATH);
    const out = scan({
      projectRoot: FIXTURE_5353,
      lintCommand: 'eslint . ; rm -rf /',
      filesInScope: new Set(),
    });
    assert.ok(out, 'scan must return a result');
    assert.ok(Array.isArray(out.warnings), 'expected warnings array');
    const skipped = out.warnings.find((w) =>
      /lint pre-check skipped:/i.test(`${w.message || ''} ${w.hint || ''}`)
    );
    assert.ok(skipped, 'expected a `lint pre-check skipped:` warning for unsafe command');
  });
});

describe('lint-blast-radius — module hygiene', () => {
  it('module source has no console.* or process.exit calls', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(MODULE_PATH, 'utf8');
    assert.doesNotMatch(src, /console\.\w+\s*\(/, 'module must not call console.*');
    assert.doesNotMatch(src, /process\.exit\s*\(/, 'module must not call process.exit');
  });
});
