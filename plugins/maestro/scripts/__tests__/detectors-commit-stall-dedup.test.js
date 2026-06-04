// commit-stall dedup contract: emit only on threshold crossings, not every tick.
//
// Drive `detect()` across many simulated "minutes since last commit" values
// and assert the detector hits exactly once per crossing of
// `[30, 60, 120, 240, 480]`. Without dedup it would hit ~480 times for an
// 8-hour stall — the very behaviour that desensitized the orchestrator and
// prompted this change.

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
  'commit-stall'
);

function freshDetector(stateDir, spawnSyncFake) {
  // Wipe the entire maestro-conduct require subtree so STATE_DIR rebinds
  // when the module re-requires state.js.
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/maestro-conduct')) delete require.cache[k];
  }
  process.env.STATE_DIR = stateDir;
  // Patch BEFORE requiring the detector so its `const { spawnSync } = require('child_process')`
  // captures the fake instead of the real binding.
  if (spawnSyncFake) {
    const cp = require('child_process');
    cp.spawnSync = spawnSyncFake;
  }
  return require(DETECTOR_PATH);
}

function makeMinutesController() {
  const cp = require('child_process');
  const original = cp.spawnSync;
  const ctl = { mins: 0 };
  ctl.spawnSync = (cmd, args, opts) => {
    if (cmd === 'git' && Array.isArray(args) && args.includes('log')) {
      const ct = Math.floor(Date.now() / 1000) - ctl.mins * 60;
      return { status: 0, stdout: `${ct}\n` };
    }
    return original(cmd, args, opts);
  };
  ctl.restore = () => {
    cp.spawnSync = original;
  };
  return ctl;
}

test('thresholdFor returns the highest crossed threshold (or 0 below the floor)', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-th-'));
  const { thresholdFor } = freshDetector(stateDir);
  assert.equal(thresholdFor(0), 0);
  assert.equal(thresholdFor(29), 0);
  assert.equal(thresholdFor(30), 30);
  assert.equal(thresholdFor(59), 30);
  assert.equal(thresholdFor(60), 60);
  assert.equal(thresholdFor(119), 60);
  assert.equal(thresholdFor(120), 120);
  assert.equal(thresholdFor(240), 240);
  assert.equal(thresholdFor(480), 480);
  assert.equal(thresholdFor(9999), 480);
});

test('detect hits exactly once per threshold crossing across 500 simulated minutes', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cross-'));
  const ctl = makeMinutesController();
  const detector = freshDetector(stateDir, ctl.spawnSync);
  try {
    let hits = 0;
    const observedThresholds = [];
    // Tick every "minute" from 0..500. With dedup, expect exactly 5 hits
    // (at 30/60/120/240/480). Without dedup we'd get ~471 hits.
    for (let m = 0; m <= 500; m++) {
      ctl.mins = m;
      const r = detector.detect({ ticket: 'GH-DEDUP', worktree: '/tmp' });
      if (r.hit) {
        hits++;
        observedThresholds.push(r.threshold);
      }
    }
    assert.equal(hits, 5, `expected 5 threshold crossings over 500 minutes, got ${hits}`);
    assert.deepStrictEqual(observedThresholds, [30, 60, 120, 240, 480]);
  } finally {
    ctl.restore();
  }
});

test('recovery (mins back below floor) clears marker so next stall re-emits', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-recov-'));
  const ctl = makeMinutesController();
  const detector = freshDetector(stateDir, ctl.spawnSync);
  try {
    // First stall climbs to 60m and back to 0 (commit landed).
    ctl.mins = 30;
    assert.equal(detector.detect({ ticket: 'GH-RECOV', worktree: '/tmp' }).hit, true);
    ctl.mins = 60;
    assert.equal(detector.detect({ ticket: 'GH-RECOV', worktree: '/tmp' }).hit, true);
    ctl.mins = 5; // commit landed; below floor
    assert.equal(detector.detect({ ticket: 'GH-RECOV', worktree: '/tmp' }).hit, false);

    // Second stall climbs back to 30m — the FIRST stall already announced 30m
    // BUT recovery cleared the marker, so we re-emit on the next 30m crossing.
    ctl.mins = 30;
    const r = detector.detect({ ticket: 'GH-RECOV', worktree: '/tmp' });
    assert.equal(r.hit, true, 'must re-emit at 30m after recovery cleared the marker');
    assert.equal(r.threshold, 30);
  } finally {
    ctl.restore();
  }
});
