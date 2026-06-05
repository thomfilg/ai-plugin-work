'use strict';

// RED phase — Task 5 (GH-513): `lib/sticky-state.js` LRU + hysteresis store.
//
// Unit tests cover deliverable 5.1.1:
//   - streak math: activeStreak 1, 2, 3 → sticky flips on 3
//   - quietStreak 1, 2, 3 → sticky drops on 3
//   - 24h-old entries evicted on load
//   - atomic write leaves no .tmp file behind
//   - fail-open on corrupt JSON: empty state, no throw
//   - fail-open on missing file: empty state, no throw

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  loadStickyState,
  saveStickyState,
  updateStickyState,
  nextStreak,
} = require('../sticky-state');

function tmpStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-sticky-'));
  return path.join(dir, 'sticky-domains.json');
}

test('updateStickyState: activeStreak increments 1, 2, 3 and flips sticky on 3', () => {
  const now = 1_700_000_000_000;
  let state = {};
  state = updateStickyState({
    state,
    sessionId: 's1',
    rawActiveSet: new Set(['git:plumbing-ops']),
    now,
  });
  assert.equal(state.s1['git:plumbing-ops'].activeStreak, 1);
  assert.notEqual(state.s1['git:plumbing-ops'].sticky, true);

  state = updateStickyState({
    state,
    sessionId: 's1',
    rawActiveSet: new Set(['git:plumbing-ops']),
    now: now + 1000,
  });
  assert.equal(state.s1['git:plumbing-ops'].activeStreak, 2);
  assert.notEqual(state.s1['git:plumbing-ops'].sticky, true);

  state = updateStickyState({
    state,
    sessionId: 's1',
    rawActiveSet: new Set(['git:plumbing-ops']),
    now: now + 2000,
  });
  assert.equal(state.s1['git:plumbing-ops'].activeStreak, 3);
  assert.equal(state.s1['git:plumbing-ops'].sticky, true);
});

test('updateStickyState: quietStreak 1, 2, 3 drops sticky on 3', () => {
  const now = 1_700_000_000_000;
  // Seed a sticky entry.
  let state = {
    s1: {
      'git:plumbing-ops': {
        activeStreak: 3,
        quietStreak: 0,
        sticky: true,
        lastSeenTs: now,
      },
    },
  };

  state = updateStickyState({
    state,
    sessionId: 's1',
    rawActiveSet: new Set(),
    now: now + 1000,
  });
  assert.equal(state.s1['git:plumbing-ops'].quietStreak, 1);
  assert.equal(state.s1['git:plumbing-ops'].sticky, true);

  state = updateStickyState({
    state,
    sessionId: 's1',
    rawActiveSet: new Set(),
    now: now + 2000,
  });
  assert.equal(state.s1['git:plumbing-ops'].quietStreak, 2);
  assert.equal(state.s1['git:plumbing-ops'].sticky, true);

  state = updateStickyState({
    state,
    sessionId: 's1',
    rawActiveSet: new Set(),
    now: now + 3000,
  });
  // Dropped: either removed or sticky=false.
  const entry = state.s1 && state.s1['git:plumbing-ops'];
  assert.ok(!entry || entry.sticky !== true, 'sticky should be dropped');
});

test('loadStickyState: 24h-old entries are evicted on load', () => {
  const file = tmpStateFile();
  const now = Date.now();
  const oldTs = now - 25 * 60 * 60 * 1000; // 25h ago
  const freshTs = now - 60 * 1000;
  const seeded = {
    s_old: {
      'git:plumbing-ops': {
        activeStreak: 3,
        quietStreak: 0,
        sticky: true,
        lastSeenTs: oldTs,
      },
    },
    s_fresh: {
      'git:plumbing-ops': {
        activeStreak: 3,
        quietStreak: 0,
        sticky: true,
        lastSeenTs: freshTs,
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(seeded));

  const loaded = loadStickyState({ filePath: file, now });
  assert.ok(!loaded.s_old || Object.keys(loaded.s_old).length === 0, 'old session pruned');
  assert.ok(loaded.s_fresh && loaded.s_fresh['git:plumbing-ops'], 'fresh session preserved');
});

test('saveStickyState: atomic write leaves no .tmp file behind', () => {
  const file = tmpStateFile();
  const dir = path.dirname(file);
  const state = {
    s1: {
      'git:plumbing-ops': {
        activeStreak: 3,
        quietStreak: 0,
        sticky: true,
        lastSeenTs: Date.now(),
      },
    },
  };
  saveStickyState({ state, filePath: file });

  assert.ok(fs.existsSync(file), 'target file written');
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.equal(leftovers.length, 0, `no .tmp artifacts; found: ${leftovers.join(',')}`);

  const re = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(re, state);
});

test('loadStickyState: corrupt JSON returns empty state and does not throw', () => {
  const file = tmpStateFile();
  fs.writeFileSync(file, '{ not valid json');

  let loaded;
  assert.doesNotThrow(() => {
    loaded = loadStickyState({ filePath: file, now: Date.now() });
  });
  assert.deepEqual(loaded, {});
});

test('loadStickyState: missing file returns empty state and does not throw', () => {
  const file = tmpStateFile();
  // Do not write the file.
  let loaded;
  assert.doesNotThrow(() => {
    loaded = loadStickyState({ filePath: file, now: Date.now() });
  });
  assert.deepEqual(loaded, {});
});

test('nextStreak: pure helper increments activeStreak when active', () => {
  // After REFACTOR, `nextStreak(prev, isActive)` is the pure core.
  if (typeof nextStreak !== 'function') {
    // RED-phase: helper does not exist yet — fail explicitly.
    assert.fail('nextStreak helper not exported yet (RED expected)');
  }
  const prev = { activeStreak: 1, quietStreak: 0, sticky: false };
  const next = nextStreak(prev, true);
  assert.equal(next.activeStreak, 2);
  assert.equal(next.quietStreak, 0);
});

test('nextStreak: pure helper increments quietStreak when inactive', () => {
  if (typeof nextStreak !== 'function') {
    assert.fail('nextStreak helper not exported yet (RED expected)');
  }
  const prev = { activeStreak: 3, quietStreak: 0, sticky: true };
  const next = nextStreak(prev, false);
  assert.equal(next.quietStreak, 1);
  assert.equal(next.activeStreak, 0);
});
