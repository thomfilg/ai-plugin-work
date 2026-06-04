'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { detectFabrication } = require('../fabrication-detector');

function makeTaskDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabdet-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

test('case A: stability claim with no artifact yields stability-claim violation', () => {
  const dir = makeTaskDir();
  const prBody = 'This change is verified with 10/10 stability run across CI.';
  const { violations } = detectFabrication(prBody, dir);
  assert.ok(violations.length >= 1, 'expected at least one violation');
  const stab = violations.find((v) => v.reason === 'stability-claim');
  assert.ok(stab, 'expected a stability-claim violation');
  assert.match(stab.phrase, /10\/10|stability/i);
});

test('case B: only-pending Test Results table yields zero violations', () => {
  const dir = makeTaskDir();
  const prBody = [
    '## Test Results',
    '',
    '| Test | Status | Notes |',
    '| --- | --- | --- |',
    '| modal opens on click | pending | awaiting |',
    '| login flow | not run | — |',
    '| signup flow | skipped | n/a |',
    '| dashboard render | n/a | — |',
    '| nav link | — | — |',
    '',
  ].join('\n');
  const { violations } = detectFabrication(prBody, dir);
  assert.equal(violations.length, 0);
});

test('case C: PASS row supported by tests.check.md substring yields zero violations', () => {
  const dir = makeTaskDir({
    'tests.check.md': 'Verified: modal opens on click — passed in CI.\n',
  });
  const prBody = [
    '## Test Results',
    '',
    '| Test | Status | Notes |',
    '| --- | --- | --- |',
    '| modal opens on click | PASS | covered by E2E |',
    '',
  ].join('\n');
  const { violations } = detectFabrication(prBody, dir);
  assert.equal(violations.length, 0);
});

test('empty stability artifact does NOT suppress stability-claim violation', () => {
  // An empty (or whitespace-only) stability.log placeholder must not pass as
  // evidence — otherwise the guard is bypassable by `touch stability.log`.
  const dir = makeTaskDir({ 'stability.log': '   \n\n' });
  const prBody = 'Verified with 10/10 stability run on CI.';
  const { violations } = detectFabrication(prBody, dir);
  const stab = violations.find((v) => v.reason === 'stability-claim');
  assert.ok(stab, 'expected stability-claim violation despite empty artifact');
});

test('incidental "10/10" mention in tests.check.md does NOT clear stability violation', () => {
  // Past behavior: any substring match in tests.check.md cleared the claim.
  // That was bypassable: a warning like "never write 10/10 without proof"
  // would suppress R11. Now stability claims require a real stability artifact.
  const dir = makeTaskDir({
    'tests.check.md': 'Reminder: do not write 10/10 without a stability log.\n',
  });
  const prBody = 'Verified with 10/10 stability run on CI.';
  const { violations } = detectFabrication(prBody, dir);
  const stab = violations.find((v) => v.reason === 'stability-claim');
  assert.ok(stab, 'expected stability-claim violation despite incidental phrase in tests.check.md');
});

test('substantive stability artifact suppresses stability-claim violation', () => {
  const dir = makeTaskDir({
    'stability.log': 'iter 1 ok\niter 2 ok\niter 3 ok\niter 4 ok\niter 5 ok\n',
  });
  const prBody = 'Verified with 10/10 stability run on CI.';
  const { violations } = detectFabrication(prBody, dir);
  const stab = violations.find((v) => v.reason === 'stability-claim');
  assert.ok(!stab, 'expected no stability-claim violation when artifact has content');
});

test('Unsourced row with synonym status (ok/passed/green) trips a violation', () => {
  // Previously only `pass`/`fail` were cross-checked; any other verdict-like
  // text (passed, ok, green, success, verified) silently bypassed the guard.
  const dir = makeTaskDir({ 'tests.check.md': 'unrelated content\n' });
  for (const status of ['passed', 'ok', 'green', 'success', 'verified']) {
    const prBody = [
      '## Test Results',
      '',
      '| Test | Status | Notes |',
      '| --- | --- | --- |',
      `| feature X works | ${status} | manual |`,
      '',
    ].join('\n');
    const { violations } = detectFabrication(prBody, dir);
    const row = violations.find((v) => v.reason === 'unsourced-test-row');
    assert.ok(row, `expected unsourced-test-row violation for status="${status}"`);
  }
});

test('Unsourced PASS row under Test Results', () => {
  const dir = makeTaskDir({
    'tests.check.md': 'No matching content here.\n',
  });
  const prBody = [
    '## Test Results',
    '',
    '| Test | Status | Notes |',
    '| --- | --- | --- |',
    '| user can log in | PASS | smoke verified |',
    '',
  ].join('\n');
  const { violations } = detectFabrication(prBody, dir);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].reason, 'unsourced-test-row');
  assert.match(violations[0].suggestion, /pending/i);
});
