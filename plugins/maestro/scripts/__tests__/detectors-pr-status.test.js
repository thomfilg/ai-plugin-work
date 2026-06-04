// pr-status detector: emit pr-ready / pr-broken / pr-pending on transitions.
//
// The detector calls `gh pr list` + `gh pr view --json` and inspects the
// statusCheckRollup + mergeStateStatus. We mock spawnSync to return shaped
// gh-output JSON, then assert the classification and dedup behavior.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const DETECTOR_PATH = path.resolve(
  __dirname,
  '..',
  'lib',
  'maestro-conduct',
  'detectors',
  'pr-status'
);

function freshDetector(stateDir, ghResponses) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/maestro-conduct')) delete require.cache[k];
  }
  process.env.STATE_DIR = stateDir;
  process.env.PR_STATUS_RE_EMIT_MIN = '30';
  process.env.GITHUB_REPO = 'thomfilg/claude-plugin-work';
  // Patch spawnSync BEFORE requiring the detector so its captured reference
  // points at the fake.
  const cp = require('child_process');
  cp.spawnSync = (cmd, args) => {
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
      return { status: 0, stdout: ghResponses.list || '[]' };
    }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      return { status: 0, stdout: ghResponses.view || '{}' };
    }
    if (cmd === 'git') return { status: 0, stdout: '' };
    return { status: 0, stdout: '' };
  };
  return require(DETECTOR_PATH);
}

function viewJson({ sha, checks, merge }) {
  return JSON.stringify({
    headRefOid: sha,
    statusCheckRollup: checks,
    mergeStateStatus: merge,
  });
}

test('classify maps the (checks, mergeable) tuple to event kind', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-classify-'));
  const { classify } = freshDetector(stateDir, {});
  assert.equal(classify('SUCCESS', 'CLEAN'), 'pr-ready');
  assert.equal(classify('SUCCESS', 'UNSTABLE'), null); // SUCCESS but not CLEAN → silent
  assert.equal(classify('FAILURE', 'CLEAN'), 'pr-broken');
  assert.equal(classify('FAILURE', 'DIRTY'), 'pr-broken');
  assert.equal(classify('SUCCESS', 'DIRTY'), 'pr-broken'); // merge conflict counts as broken
  assert.equal(classify('PENDING', 'CLEAN'), 'pr-pending');
  assert.equal(classify('UNKNOWN', 'BLOCKED'), null); // no signal
});

test('all-SUCCESS + CLEAN emits pr-ready once, then dedups on same SHA', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-ready-'));
  const detector = freshDetector(stateDir, {
    list: JSON.stringify([{ number: 488 }]),
    view: viewJson({
      sha: 'abc123def',
      checks: [
        { name: 'Test (Node 20)', conclusion: 'SUCCESS', status: 'COMPLETED' },
        { name: 'CodeQL', conclusion: 'SUCCESS', status: 'COMPLETED' },
        { name: 'Quality', conclusion: 'SUCCESS', status: 'COMPLETED' },
      ],
      merge: 'CLEAN',
    }),
  });

  // First call: state transition (no marker) → hits.
  const r1 = detector.detect({ ticket: 'GH-400', worktree: '/tmp' });
  assert.equal(r1.hit, true);
  assert.equal(r1.kind, 'pr-ready');
  assert.equal(r1.prNumber, 488);
  assert.equal(r1.sha, 'abc123def');
  assert.equal(r1.checksState, 'SUCCESS');
  assert.equal(r1.mergeable, 'CLEAN');

  // Second call same state same SHA → dedup'd (no hit) until RE_EMIT_MIN.
  const r2 = detector.detect({ ticket: 'GH-400', worktree: '/tmp' });
  assert.equal(r2.hit, false, 'same state + same SHA must not re-emit within cooldown');
});

test('failing check emits pr-broken with failingChecks populated', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-broken-'));
  const detector = freshDetector(stateDir, {
    list: JSON.stringify([{ number: 555 }]),
    view: viewJson({
      sha: 'badcommit',
      checks: [
        { name: 'Test (Node 20)', conclusion: 'SUCCESS', status: 'COMPLETED' },
        {
          name: 'Quality',
          conclusion: 'FAILURE',
          status: 'COMPLETED',
          detailsUrl: 'https://ci.example/jobs/42',
        },
      ],
      merge: 'BLOCKED',
    }),
  });
  const r = detector.detect({ ticket: 'GH-BROKEN', worktree: '/tmp' });
  assert.equal(r.hit, true);
  assert.equal(r.kind, 'pr-broken');
  assert.equal(r.failingChecks.length, 1);
  assert.equal(r.failingChecks[0].name, 'Quality');
  assert.equal(r.failingChecks[0].url, 'https://ci.example/jobs/42');
});

test('SHA change re-emits even when state is unchanged (operator pushed a new commit)', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-sha-'));

  // First: green at SHA "aaa".
  let detector = freshDetector(stateDir, {
    list: JSON.stringify([{ number: 100 }]),
    view: viewJson({
      sha: 'aaa',
      checks: [{ name: 'CI', conclusion: 'SUCCESS', status: 'COMPLETED' }],
      merge: 'CLEAN',
    }),
  });
  assert.equal(detector.detect({ ticket: 'GH-SHA', worktree: '/tmp' }).hit, true);

  // Re-require with the SAME state dir but updated gh response (new SHA).
  detector = freshDetector(stateDir, {
    list: JSON.stringify([{ number: 100 }]),
    view: viewJson({
      sha: 'bbb',
      checks: [{ name: 'CI', conclusion: 'SUCCESS', status: 'COMPLETED' }],
      merge: 'CLEAN',
    }),
  });
  const r = detector.detect({ ticket: 'GH-SHA', worktree: '/tmp' });
  assert.equal(r.hit, true, 'new SHA must re-emit even for the same kind');
  assert.equal(r.sha, 'bbb');
});

test('pending checks classify as pr-pending (informational)', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-pending-'));
  const detector = freshDetector(stateDir, {
    list: JSON.stringify([{ number: 999 }]),
    view: viewJson({
      sha: 'wip',
      checks: [{ name: 'CI', conclusion: null, status: 'IN_PROGRESS' }],
      merge: 'CLEAN',
    }),
  });
  const r = detector.detect({ ticket: 'GH-PEND', worktree: '/tmp' });
  assert.equal(r.hit, true);
  assert.equal(r.kind, 'pr-pending');
});

test('no PR for the head ref → silent (hit=false)', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-nopr-'));
  const detector = freshDetector(stateDir, { list: '[]' });
  const r = detector.detect({ ticket: 'GH-NOPR', worktree: '/tmp' });
  assert.equal(r.hit, false);
});

test('SUCCESS+UNSTABLE (e.g., approval missing) is silent — no emit', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-unstable-'));
  const detector = freshDetector(stateDir, {
    list: JSON.stringify([{ number: 77 }]),
    view: viewJson({
      sha: 'unstable',
      checks: [{ name: 'CI', conclusion: 'SUCCESS', status: 'COMPLETED' }],
      merge: 'UNSTABLE',
    }),
  });
  const r = detector.detect({ ticket: 'GH-UN', worktree: '/tmp' });
  assert.equal(
    r.hit,
    false,
    'UNSTABLE is not pr-ready (CLEAN required) and not broken — daemon stays quiet'
  );
});
