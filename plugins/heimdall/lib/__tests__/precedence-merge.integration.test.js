// Integration test for four-kind precedence merge via `buildEntries`.
//
// Discovered by plugins/work/scripts/run-tests.sh.
// Manual: node --test plugins/heimdall/lib/__tests__/precedence-merge.integration.test.js
//
// Covers GH-541 Task 8 / AC7:
//   With local/worktree/global/shared markers each holding one distinct
//   lock block, buildEntries over the merged discoverStores output contains
//   all four blocks, ordered local, worktree, global, shared.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lockStorePath = path.resolve(__dirname, '..', 'lock-store');
const guardPath = path.resolve(__dirname, '..', 'guard');

const lockStore = require(lockStorePath);
const {
  MARKER,
  FOLDER,
  SHARED_FOLDER,
  discoverStores,
  readConfig,
  writeConfig,
} = lockStore;
const { buildEntries } = require(guardPath);

let originalHome;
let base;
let fakeHome;
let sharedDir;

before(() => {
  originalHome = os.homedir();
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-precedence-it-'));
  fakeHome = path.join(base, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;
  sharedDir = path.join(fakeHome, '.claude', SHARED_FOLDER || 'heimdall-shared');
});

after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(fakeHome, '.claude'), { recursive: true, force: true });
});

describe('Four-kind precedence merge for buildEntries', () => {
  it('merges entries from all four stores in order local, worktree, global, shared', () => {
    const wt = path.join(base, 'wt');
    const repo = path.join(wt, 'repo');
    fs.mkdirSync(repo, { recursive: true });

    const localLock = {
      unlockPhrase: 'unlock-local',
      protect: ['local-target'],
    };
    const worktreeLock = {
      unlockPhrase: 'unlock-worktree',
      protect: ['worktree-target'],
    };
    const globalLock = {
      unlockPhrase: 'unlock-global',
      protect: ['global-target'],
    };
    const sharedLock = {
      unlockPhrase: 'unlock-shared',
      protect: ['~/shared-target'],
    };

    writeConfig(path.join(repo, '.claude', FOLDER), { kind: 'local', locks: [localLock] });
    writeConfig(path.join(wt, '.claude', FOLDER), { kind: 'worktree', locks: [worktreeLock] });
    writeConfig(path.join(fakeHome, '.claude', FOLDER, 'repo'), {
      kind: 'global',
      locks: [globalLock],
    });
    writeConfig(sharedDir, { kind: 'shared', locks: [sharedLock] });

    assert.ok(fs.existsSync(path.join(sharedDir, MARKER)), 'shared marker seeded');

    const stores = discoverStores(repo);
    const known = stores.filter((s) => ['local', 'worktree', 'global', 'shared'].includes(s.kind));

    // Build merged entries in store order — this represents the precedence
    // order local > worktree > global > shared.
    const merged = [];
    for (const store of known) {
      const cfg = readConfig(store.dir) || { locks: [] };
      for (const entry of buildEntries(cfg.locks, store.dir)) {
        merged.push({ kind: store.kind, entry });
      }
    }

    // All four blocks present.
    assert.equal(merged.length, 4, 'expected one merged entry per store');

    // Ordered local, worktree, global, shared.
    assert.deepEqual(
      merged.map((m) => m.kind),
      ['local', 'worktree', 'global', 'shared']
    );

    // Each entry carries the right unlockPhrase, proving union semantics
    // across stores rather than overwrite.
    assert.deepEqual(
      merged.map((m) => m.entry.unlockPhrase),
      ['unlock-local', 'unlock-worktree', 'unlock-global', 'unlock-shared']
    );
  });

  it('discoverStores precedence orders shared last', () => {
    // R4 says heimdall must "Define and document lock-merge precedence
    // local > worktree > global > shared". A documented constant lets
    // downstream consumers (merge/scan/list) align on the same order rather
    // than hand-rolling string literals.
    assert.ok(
      Array.isArray(lockStore.PRECEDENCE_ORDER),
      'lock-store must export PRECEDENCE_ORDER array'
    );
    assert.deepEqual(
      lockStore.PRECEDENCE_ORDER,
      ['local', 'worktree', 'global', 'shared'],
      'PRECEDENCE_ORDER must encode R4 precedence local > worktree > global > shared'
    );

    // And the live discovery order must agree with the documented constant.
    const wt = path.join(base, 'wt2');
    const repo = path.join(wt, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    writeConfig(path.join(repo, '.claude', FOLDER), { kind: 'local', locks: [] });
    writeConfig(path.join(wt, '.claude', FOLDER), { kind: 'worktree', locks: [] });
    writeConfig(path.join(fakeHome, '.claude', FOLDER, 'repo'), { kind: 'global', locks: [] });
    writeConfig(sharedDir, { kind: 'shared', locks: [] });

    const liveKinds = discoverStores(repo).map((s) => s.kind);
    assert.deepEqual(
      liveKinds,
      lockStore.PRECEDENCE_ORDER,
      'discoverStores order must match PRECEDENCE_ORDER constant'
    );
  });
});
