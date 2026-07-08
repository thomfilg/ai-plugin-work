// progress.js — worktree-progress signature (GH-627 lite).
//
// The conductor's activity heuristics (pane hash, spinner age, wall-clock)
// cannot tell "working slowly" from "hung"; progress.js hashes the worktree's
// git state so detectors can suppress interrupts while files are changing.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execSync } = require('node:child_process');

const MOD = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'progress.js');

function freshProgress(stateDir) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/maestro-conduct/')) delete require.cache[k];
  }
  process.env.STATE_DIR = stateDir;
  return require(MOD);
}

function mkGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-repo-'));
  execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', {
    cwd: dir,
    shell: '/bin/bash',
  });
  return dir;
}

test('signature: null for a non-repo, stable for an unchanged repo, moves on edits', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-state-'));
  const progress = freshProgress(stateDir);

  assert.equal(progress.signature(path.join(os.tmpdir(), 'nope-not-a-repo')), null);
  assert.equal(progress.signature(null), null);

  const repo = mkGitRepo();
  const s1 = progress.signature(repo);
  assert.ok(s1, 'repo must produce a signature');
  assert.equal(progress.signature(repo), s1, 'unchanged repo → same signature');

  fs.writeFileSync(path.join(repo, 'new-file.txt'), 'work happened\n');
  const s2 = progress.signature(repo);
  assert.notEqual(s2, s1, 'an untracked file must move the signature');
});

test('observe/hasFreshProgress: first sight and changes are fresh; failures are not', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-state-'));
  const progress = freshProgress(stateDir);
  const repo = mkGitRepo();

  // First observation counts as a change (safe side: suppress right after boot).
  const first = progress.observe('GH-77', repo);
  assert.equal(first.changed, true);
  assert.equal(progress.hasFreshProgress('GH-77'), true);

  // Same state → not changed, but still fresh (lastChangeAt is recent).
  const second = progress.observe('GH-77', repo);
  assert.equal(second.changed, false);
  assert.equal(second.minutesSinceChange, 0);
  assert.equal(progress.hasFreshProgress('GH-77'), true);

  // Edit → changed again.
  fs.writeFileSync(path.join(repo, 'more.txt'), 'x');
  assert.equal(progress.observe('GH-77', repo).changed, true);

  // Unreadable worktree → fail-open: no verdict, never "fresh".
  const broken = progress.observe('GH-88', '/nonexistent/worktree');
  assert.equal(broken.sig, null);
  assert.equal(broken.changed, false);
  assert.equal(progress.hasFreshProgress('GH-88'), false);
});

test('hasFreshProgress: stale lastChangeAt ages out', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-state-'));
  const progress = freshProgress(stateDir);
  const state = require(path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'state.js'));
  // Hand-write a marker whose last change was 2 hours ago.
  state.write('GH-99', 'progress', {
    sig: 'abc',
    lastChangeAt: state.now() - 2 * 60 * 60,
    lastCheckAt: state.now(),
  });
  assert.equal(progress.hasFreshProgress('GH-99'), false);
  assert.equal(progress.hasFreshProgress('GH-99', 200), true, 'custom window honored');
});
