'use strict';

// sleep.test.js — Atomics-based synchronous sleep (replaces the execSync
// `node -e setTimeout` pattern that crashed with spawnSync ETIMEDOUT).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { sleepSync, sleepSyncInterruptible } = require('../sleep');

describe('sleep — Atomics.wait based', () => {
  it('sleepSync blocks for roughly the requested duration', () => {
    const start = Date.now();
    sleepSync(120);
    assert.ok(Date.now() - start >= 100, 'expected at least ~100ms of sleep');
  });

  it('sleepSyncInterruptible wakes early when shouldWake returns true', () => {
    const start = Date.now();
    const woke = sleepSyncInterruptible(10000, () => true, 50);
    assert.equal(woke, true);
    assert.ok(Date.now() - start < 2000, 'expected early wake, not the full 10s');
  });

  it('sleepSyncInterruptible runs to completion when shouldWake stays false', () => {
    const woke = sleepSyncInterruptible(150, () => false, 50);
    assert.equal(woke, false);
  });

  it('sleepSyncInterruptible survives a throwing shouldWake (best-effort)', () => {
    const woke = sleepSyncInterruptible(
      120,
      () => {
        throw new Error('boom');
      },
      40
    );
    assert.equal(woke, false);
  });
});
