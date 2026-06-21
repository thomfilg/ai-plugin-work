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
    '| nav link | pending | — |',
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

test('Empty or dash Status no longer bypasses sourcing', () => {
  // Previously '', '-', '—' were in ALLOWED_STATUSES, so a row could leave
  // Status blank and smuggle verdict language into Notes. Now those values
  // must be sourced like any other claim.
  const dir = makeTaskDir({ 'tests.check.md': 'unrelated content\n' });
  for (const status of ['', '-', '—']) {
    const prBody = [
      '## Test Results',
      '',
      '| Test | Status | Notes |',
      '| --- | --- | --- |',
      `| sneaky verdict in notes | ${status} | works in prod |`,
      '',
    ].join('\n');
    const { violations } = detectFabrication(prBody, dir);
    const row = violations.find((v) => v.reason === 'unsourced-test-row');
    assert.ok(row, `expected unsourced-test-row violation for status="${status}"`);
  }
});

test('Bare 10/10 in a calendar date does NOT trip a stability violation', () => {
  // Calendar dates like 10/10/2026 used to false-positive on the bare 10/10
  // regex. Now the pattern requires no trailing `/` or digit.
  const dir = makeTaskDir();
  const prBody = 'Scheduled rollout on 10/10/2026. No stability claims here.';
  const { violations } = detectFabrication(prBody, dir);
  const stab = violations.find((v) => v.reason === 'stability-claim');
  assert.ok(!stab, 'expected no stability-claim violation for calendar date 10/10/2026');
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

test('Verdict in Notes column with pending Status still trips a violation', () => {
  // Smuggling: Status=pending but Notes contains "PASS in CI" or similar.
  const dir = makeTaskDir({ 'tests.check.md': 'unrelated content\n' });
  const cases = ['PASS in CI', 'works in prod', 'verified manually', 'green', 'OK on staging'];
  for (const notes of cases) {
    const prBody = [
      '## Test Results',
      '',
      '| Test | Status | Notes |',
      '| --- | --- | --- |',
      `| feature Y | pending | ${notes} |`,
      '',
    ].join('\n');
    const { violations } = detectFabrication(prBody, dir);
    const row = violations.find((v) => v.reason === 'unsourced-test-row');
    assert.ok(row, `expected violation for pending row with notes="${notes}"`);
  }
});

test('Known over-eager cases: benign Notes containing verdict words DO trip (documented)', () => {
  // The Notes verdict regex is deliberately over-eager — a false positive
  // forces the agent to source the row or rewrite Notes, which is the safer
  // failure mode. This test pins that behavior so future tightening is a
  // conscious choice, not an accidental drift.
  const dir = makeTaskDir({ 'tests.check.md': 'unrelated content\n' });
  const benignCases = [
    'works in progress',
    'verified pending product review',
    'OK to merge after review',
    'follow-up: passed manual but not yet in tests.check.md',
  ];
  for (const notes of benignCases) {
    const prBody = [
      '## Test Results',
      '',
      '| Test | Status | Notes |',
      '| --- | --- | --- |',
      `| feature Z | pending | ${notes} |`,
      '',
    ].join('\n');
    const { violations } = detectFabrication(prBody, dir);
    const row = violations.find((v) => v.reason === 'unsourced-test-row');
    assert.ok(row, `over-eager (expected) violation for benign notes="${notes}"`);
  }
});

test('Row with no Notes column (2-column row) does not crash and does not trip', () => {
  // parseTableRow defaults notes to '' when only Test and Status are present.
  // Guards `!!row.notes` against undefined / null defensively.
  const dir = makeTaskDir();
  const prBody = [
    '## Test Results',
    '',
    '| Test | Status |',
    '| --- | --- |',
    '| modal opens | pending |',
    '',
  ].join('\n');
  const { violations } = detectFabrication(prBody, dir);
  assert.equal(violations.length, 0);
});

test('Plain pending row with non-verdict Notes does not trip', () => {
  const dir = makeTaskDir();
  const prBody = [
    '## Test Results',
    '',
    '| Test | Status | Notes |',
    '| --- | --- | --- |',
    '| modal opens | pending | awaiting tests.check.md |',
    '| login flow | pending | follow-up next sprint |',
    '',
  ].join('\n');
  const { violations } = detectFabrication(prBody, dir);
  assert.equal(violations.length, 0);
});

test('Sourcing requires word-boundary match, not naive substring', () => {
  // `login` as a substring of `loginflow` / `logins` must NOT count as evidence.
  const dir = makeTaskDir({
    'tests.check.md': 'See logins table and loginflow utility for context.\n',
  });
  const prBody = [
    '## Test Results',
    '',
    '| Test | Status | Notes |',
    '| --- | --- | --- |',
    '| login | PASS | smoke |',
    '',
  ].join('\n');
  const { violations } = detectFabrication(prBody, dir);
  const row = violations.find((v) => v.reason === 'unsourced-test-row');
  assert.ok(
    row,
    'expected violation — "login" inside "loginflow"/"logins" should not source the claim'
  );
});

test('Whole-word sourcing in tests.check.md clears the claim', () => {
  const dir = makeTaskDir({
    'tests.check.md': '- login: verified via smoke run in CI.\n',
  });
  const prBody = [
    '## Test Results',
    '',
    '| Test | Status | Notes |',
    '| --- | --- | --- |',
    '| login | PASS | smoke |',
    '',
  ].join('\n');
  const { violations } = detectFabrication(prBody, dir);
  assert.equal(violations.length, 0);
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
