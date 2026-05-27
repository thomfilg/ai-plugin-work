// Tests for Heimdall lock-store discovery + config IO + lock ops.
//
// Discovered by plugins/work/scripts/run-tests.sh (searches plugins/heimdall/).
// Manual: node --test plugins/heimdall/lib/__tests__/lock-store.test.js
//
// In-process (no subprocess/git spawns) so the test adds no parallel-process
// load to the full suite.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MARKER, FOLDER, discoverStores, readConfig, writeConfig, upsertLock, removeLock } = require(
  path.resolve(__dirname, '..', 'lock-store')
);

let base;
let local;

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-store-'));
  local = path.join(base, 'repo');
  fs.mkdirSync(local, { recursive: true });
});

after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('store discovery', () => {
  it('finds a local store once its marker exists', () => {
    assert.equal(discoverStores(local).length, 0, 'no store before init');
    const storeDir = path.join(local, '.claude', FOLDER);
    writeConfig(storeDir, { kind: 'local', locks: [] });
    assert.ok(fs.existsSync(path.join(storeDir, MARKER)));
    const stores = discoverStores(local);
    assert.equal(stores.length, 1);
    assert.equal(stores[0].kind, 'local');
  });

  it('writeConfig round-trips through readConfig', () => {
    const storeDir = path.join(base, 'rt', '.claude', FOLDER);
    writeConfig(storeDir, { kind: 'local', locks: [{ protect: ['x'], unlockPhrase: 'edit x' }] });
    assert.deepEqual(readConfig(storeDir).locks, [{ protect: ['x'], unlockPhrase: 'edit x' }]);
  });
});

describe('upsertLock', () => {
  it('appends a new block and dedupes its paths', () => {
    const cfg = { locks: [] };
    upsertLock(cfg, {
      phrase: 'edit .claude',
      paths: ['.claude', '.claude'],
      allowedPaths: ['plans'],
    });
    assert.equal(cfg.locks.length, 1);
    assert.deepEqual(cfg.locks[0].protect, ['.claude']);
    assert.deepEqual(cfg.locks[0].allowedPaths, ['plans']);
  });

  it('merges into the existing block with the same phrase', () => {
    const cfg = { locks: [{ protect: ['.claude'], unlockPhrase: 'edit .claude' }] };
    upsertLock(cfg, { phrase: 'edit .claude', paths: ['extra'] });
    assert.equal(cfg.locks.length, 1, 'merged, not appended');
    assert.deepEqual(cfg.locks[0].protect, ['.claude', 'extra']);
  });
});

describe('removeLock', () => {
  it('removes a whole block by phrase', () => {
    const cfg = { locks: [{ protect: ['.github'], unlockPhrase: 'edit .github' }] };
    assert.equal(removeLock(cfg, 'edit .github'), 'removed');
    assert.equal(cfg.locks.length, 0);
  });

  it('trims a path and keeps the block when others remain', () => {
    const cfg = { locks: [{ protect: ['a', 'b'], unlockPhrase: 'p' }] };
    assert.equal(removeLock(cfg, 'p', ['a']), 'trimmed');
    assert.deepEqual(cfg.locks[0].protect, ['b']);
  });

  it('empties (deletes) the block when its last path is removed', () => {
    const cfg = { locks: [{ protect: ['a'], unlockPhrase: 'p' }] };
    assert.equal(removeLock(cfg, 'p', ['a']), 'emptied');
    assert.equal(cfg.locks.length, 0);
  });

  it('reports missing when no block matches the phrase', () => {
    assert.equal(removeLock({ locks: [] }, 'nope'), 'missing');
  });
});
