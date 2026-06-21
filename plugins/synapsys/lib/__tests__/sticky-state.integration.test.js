'use strict';

// RED phase — Task 5 (GH-513) INTEGRATION (deliverable 5.1.4).
//
// Round-trips real file writes against a tmpdir-scoped state path:
//   - load → update → save → reload preserves entries
//   - atomic-rename leaves no `.tmp` artifact in the state dir
//   - 24h-old entries are evicted on a fresh load

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { loadStickyState, saveStickyState, updateStickyState } = require('../sticky-state');

function tmpStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-sticky-int-'));
  return path.join(dir, 'sticky-domains.json');
}

test('integration: round-trip load → update → save → reload preserves state', () => {
  const file = tmpStateFile();
  const now = Date.now();

  // Fresh load: empty.
  const initial = loadStickyState({ filePath: file, now });
  assert.deepEqual(initial, {});

  // Three active prompts → sticky for git:plumbing-ops in session s1.
  let state = initial;
  for (let i = 0; i < 3; i++) {
    state = updateStickyState({
      state,
      sessionId: 's1',
      rawActiveSet: new Set(['git:plumbing-ops']),
      now: now + i * 1000,
    });
  }
  saveStickyState({ state, filePath: file });

  const reloaded = loadStickyState({ filePath: file, now: now + 4000 });
  assert.ok(reloaded.s1 && reloaded.s1['git:plumbing-ops']);
  assert.equal(reloaded.s1['git:plumbing-ops'].sticky, true);
  assert.equal(reloaded.s1['git:plumbing-ops'].activeStreak, 3);
});

test('integration: atomic-rename leaves no `.tmp` artifact in state dir', () => {
  const file = tmpStateFile();
  const dir = path.dirname(file);
  const now = Date.now();

  let state = {};
  state = updateStickyState({
    state,
    sessionId: 's_atomic',
    rawActiveSet: new Set(['git:plumbing-ops']),
    now,
  });

  // Save multiple times to exercise overwrite path.
  saveStickyState({ state, filePath: file });
  saveStickyState({ state, filePath: file });
  saveStickyState({ state, filePath: file });

  const entries = fs.readdirSync(dir);
  const tmpLeft = entries.filter((f) => f.endsWith('.tmp'));
  assert.equal(tmpLeft.length, 0, `no .tmp artifacts; found: ${tmpLeft.join(',')}`);
  assert.ok(entries.includes('sticky-domains.json'));
});

test('integration: 24h-old entries are evicted on a fresh load from disk', () => {
  const file = tmpStateFile();
  const now = Date.now();
  const oldTs = now - 25 * 60 * 60 * 1000;

  const seeded = {
    s_stale: {
      'git:plumbing-ops': {
        activeStreak: 3,
        quietStreak: 0,
        sticky: true,
        lastSeenTs: oldTs,
      },
    },
    s_recent: {
      'git:plumbing-ops': {
        activeStreak: 2,
        quietStreak: 0,
        sticky: false,
        lastSeenTs: now - 60 * 1000,
      },
    },
  };
  // Write directly to disk (not via saveStickyState) so eviction happens at load.
  fs.writeFileSync(file, JSON.stringify(seeded));

  const loaded = loadStickyState({ filePath: file, now });
  assert.ok(!loaded.s_stale || Object.keys(loaded.s_stale).length === 0);
  assert.ok(loaded.s_recent && loaded.s_recent['git:plumbing-ops']);
});
