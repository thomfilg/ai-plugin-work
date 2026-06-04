// Integration tests for Heimdall lock-store `shared` kind discovery.
//
// Discovered by plugins/work/scripts/run-tests.sh.
// Manual: node --test plugins/heimdall/lib/__tests__/lock-store.integration.test.js
//
// Covers GH-541 Task 1 scenarios:
//   - discoverStores returns the shared store from any cwd
//   - discoverStores precedence orders shared last (local, worktree, global, shared)

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lockStorePath = path.resolve(__dirname, '..', 'lock-store');
const { MARKER, FOLDER, candidateStores, discoverStores, writeConfig, SHARED_FOLDER } = require(
  lockStorePath
);

let originalHome;
let base;
let fakeHome;
let sharedDir;

before(() => {
  originalHome = os.homedir();
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-shared-it-'));
  fakeHome = path.join(base, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;
  // os.homedir() caches via env on POSIX; reassert.
  sharedDir = path.join(fakeHome, '.claude', SHARED_FOLDER || 'heimdall-shared');
});

after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  // Reset shared dir between tests so we can selectively seed it.
  fs.rmSync(path.join(fakeHome, '.claude'), { recursive: true, force: true });
});

describe('SHARED_FOLDER constant', () => {
  it('equals `${FOLDER}-shared`', () => {
    assert.equal(SHARED_FOLDER, `${FOLDER}-shared`);
  });
});

describe('candidateStores includes shared row', () => {
  it('returns a row with kind=shared at ~/.claude/heimdall-shared', () => {
    const rows = candidateStores('/tmp/anywhere', 'anyproject');
    const shared = rows.find((r) => r.kind === 'shared');
    assert.ok(shared, 'expected a candidate row with kind=shared');
    assert.equal(shared.dir, path.join(os.homedir(), '.claude', `${FOLDER}-shared`));
  });
});

describe('discoverStores returns the shared store from any cwd', () => {
  beforeEach(() => {
    // Seed shared marker only.
    writeConfig(sharedDir, { kind: 'shared', locks: [] });
  });

  it('discovers shared from cwd1', () => {
    const cwd1 = fs.mkdtempSync(path.join(base, 'cwd1-'));
    const stores = discoverStores(cwd1);
    const shared = stores.find((s) => s.kind === 'shared');
    assert.ok(shared, 'expected shared store in discoverStores result');
    assert.equal(shared.dir, sharedDir);
    assert.equal(shared.projectName, null);
  });

  it('discovers shared from cwd2', () => {
    const cwd2 = fs.mkdtempSync(path.join(base, 'cwd2-'));
    const stores = discoverStores(cwd2);
    const shared = stores.find((s) => s.kind === 'shared');
    assert.ok(shared);
    assert.equal(shared.dir, sharedDir);
    assert.equal(shared.projectName, null);
  });

  it('discovers shared from cwd3', () => {
    const cwd3 = fs.mkdtempSync(path.join(base, 'cwd3-'));
    const stores = discoverStores(cwd3);
    const shared = stores.find((s) => s.kind === 'shared');
    assert.ok(shared);
    assert.equal(shared.dir, sharedDir);
    assert.equal(shared.projectName, null);
  });
});

describe('discoverStores does not report ~/.claude/heimdall as a worktree ancestor', () => {
  it('returns no spurious worktree entry when cwd is nested under HOME', () => {
    // Seed a marker at `<fakeHome>/.claude/heimdall/.heimdall.json`. Without
    // the HOME-stop in findAncestorStore(), discoverStores() for a cwd nested
    // under HOME would walk up past HOME and pick this marker up as a
    // "worktree" ancestor — leaking an unrelated project's locks into this
    // session. Guards the GH-541 R11 fix in lib/lock-store.js.
    writeConfig(path.join(fakeHome, '.claude', FOLDER), { kind: 'global', locks: [] });

    const sub = path.join(fakeHome, 'sub', 'dir');
    fs.mkdirSync(sub, { recursive: true });

    const stores = discoverStores(sub);
    const worktree = stores.find((s) => s.kind === 'worktree');
    assert.equal(
      worktree,
      undefined,
      `expected no worktree store, got ${JSON.stringify(worktree)}`
    );
  });
});

describe('discoverStores precedence orders shared last', () => {
  it('returns entries in order local, worktree, global, shared', () => {
    // Layout: <base>/wt/.claude/heimdall (worktree marker)
    //         <base>/wt/repo/.claude/heimdall (local marker)
    //         ~/.claude/heimdall/<projectName> (global marker)
    //         ~/.claude/heimdall-shared (shared marker)
    const wt = path.join(base, 'wt');
    const repo = path.join(wt, 'repo');
    fs.mkdirSync(repo, { recursive: true });

    writeConfig(path.join(repo, '.claude', FOLDER), { kind: 'local', locks: [] });
    writeConfig(path.join(wt, '.claude', FOLDER), { kind: 'worktree', locks: [] });
    // Use 'repo' as the projectName since git is likely unavailable / not a repo.
    writeConfig(path.join(fakeHome, '.claude', FOLDER, 'repo'), { kind: 'global', locks: [] });
    writeConfig(sharedDir, { kind: 'shared', locks: [] });

    assert.ok(fs.existsSync(path.join(sharedDir, MARKER)), 'shared marker seeded');

    const stores = discoverStores(repo);
    const kinds = stores.map((s) => s.kind);
    // Expect exactly this order; filter out any unknowns just in case.
    assert.deepEqual(
      kinds.filter((k) => ['local', 'worktree', 'global', 'shared'].includes(k)),
      ['local', 'worktree', 'global', 'shared']
    );
    // And shared must be the last entry overall.
    assert.equal(kinds[kinds.length - 1], 'shared');
  });
});
