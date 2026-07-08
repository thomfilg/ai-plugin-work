'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const { createStoreDiscovery } = require('../storeDiscovery');

// The HOME-override fixtures rely on Node's os.homedir() honouring $HOME on
// POSIX; skip them on win32 (mirrors the existing store suites).
const HOME_DRIVEN = process.platform !== 'win32';

const FOLDER = 'acme';
const MARKER = '.acme.json';
const ENV_VAR = 'ACME_DISABLE_HOME_STORES';

function makeApi(overrides) {
  return createStoreDiscovery({
    folder: FOLDER,
    marker: MARKER,
    projectNameStrategy: 'toplevel',
    ancestorWalkStopsAtHome: false,
    disableHomeStoresEnvVar: null,
    ...overrides,
  });
}

function seedMarker(storeDir) {
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, MARKER), '{}\n');
  return storeDir;
}

describe('createStoreDiscovery config validation', () => {
  it('throws TypeError for a non-object config', () => {
    assert.throws(() => createStoreDiscovery(null), TypeError);
    assert.throws(() => createStoreDiscovery('acme'), /config object required/);
    assert.throws(() => createStoreDiscovery(['acme']), /config object required/);
  });

  it('throws the missing-key idiom for each required key', () => {
    assert.throws(
      () => createStoreDiscovery({}),
      new TypeError('storeDiscovery: missing "folder"')
    );
    assert.throws(
      () => createStoreDiscovery({ folder: FOLDER }),
      new TypeError('storeDiscovery: missing "marker"')
    );
    assert.throws(
      () => createStoreDiscovery({ folder: FOLDER, marker: MARKER }),
      new TypeError('storeDiscovery: missing "projectNameStrategy"')
    );
  });

  it('rejects empty or non-string required keys', () => {
    assert.throws(() => makeApi({ folder: '' }), /"folder" must be a non-empty string/);
    assert.throws(() => makeApi({ marker: 42 }), /"marker" must be a non-empty string/);
  });

  it('rejects an unknown projectNameStrategy enum value', () => {
    assert.throws(() => makeApi({ projectNameStrategy: 'basename' }), TypeError);
    assert.throws(
      () => makeApi({ projectNameStrategy: 'basename' }),
      /invalid "projectNameStrategy" — expected "git-common-dir" or "toplevel"/
    );
  });

  it('rejects a non-boolean ancestorWalkStopsAtHome', () => {
    assert.throws(
      () => makeApi({ ancestorWalkStopsAtHome: 'yes' }),
      /"ancestorWalkStopsAtHome" must be a boolean/
    );
    assert.throws(() => makeApi({ ancestorWalkStopsAtHome: null }), TypeError);
  });

  it('rejects a non-string disableHomeStoresEnvVar', () => {
    assert.throws(
      () => makeApi({ disableHomeStoresEnvVar: 42 }),
      /"disableHomeStoresEnvVar" must be a non-empty string or null/
    );
    assert.throws(() => makeApi({ disableHomeStoresEnvVar: '' }), TypeError);
  });

  it('returns a frozen api with the derived constants', () => {
    const api = makeApi();
    assert.ok(Object.isFrozen(api));
    assert.equal(api.MARKER, MARKER);
    assert.equal(api.FOLDER, FOLDER);
    assert.equal(api.SHARED_FOLDER, `${FOLDER}-shared`);
    assert.deepEqual([...api.PRECEDENCE_ORDER], ['local', 'worktree', 'global', 'shared']);
    assert.ok(Object.isFrozen(api.PRECEDENCE_ORDER));
    for (const fn of [
      'safeExec',
      'getRepoRoot',
      'getProjectName',
      'candidateStores',
      'findAncestorStore',
      'discoverStores',
    ]) {
      assert.equal(typeof api[fn], 'function', `expected api.${fn} to be a function`);
    }
  });
});

describe('safeExec', { skip: !HOME_DRIVEN }, () => {
  it('returns trimmed stdout resolved against the given cwd', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-exec-'));
    try {
      assert.equal(makeApi().safeExec('pwd', dir), fs.realpathSync(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails open: returns "" when the command exits non-zero', () => {
    assert.equal(makeApi().safeExec('false', os.tmpdir()), '');
  });

  it('fails open: returns "" for an unknown command', () => {
    assert.equal(makeApi().safeExec('definitely-not-a-real-command-xyzzy', os.tmpdir()), '');
  });
});

describe('candidateStores', () => {
  it('returns the four canonical rows in precedence order', () => {
    const cwd = path.join(os.tmpdir(), 'sd-rows', 'repo');
    const rows = makeApi().candidateStores(cwd, 'proj');
    assert.deepEqual(rows, [
      { kind: 'local', dir: path.join(cwd, '.claude', FOLDER) },
      { kind: 'worktree', dir: path.resolve(cwd, '..', '.claude', FOLDER) },
      { kind: 'global', dir: path.join(os.homedir(), '.claude', FOLDER, 'proj') },
      { kind: 'shared', dir: path.join(os.homedir(), '.claude', `${FOLDER}-shared`) },
    ]);
  });

  it('resolves os.homedir() per call — reassigning HOME moves the home rows', {
    skip: !HOME_DRIVEN,
  }, () => {
    const api = makeApi();
    const originalHome = process.env.HOME;
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-home-'));
    const cwd = path.join(os.tmpdir(), 'sd-rows', 'repo');
    const beforeRows = api.candidateStores(cwd, 'proj');
    try {
      process.env.HOME = fakeHome;
      const rows = api.candidateStores(cwd, 'proj');
      assert.equal(rows[2].dir, path.join(fakeHome, '.claude', FOLDER, 'proj'));
      assert.equal(rows[3].dir, path.join(fakeHome, '.claude', `${FOLDER}-shared`));
      assert.notEqual(rows[2].dir, beforeRows[2].dir);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe('getProjectName / getRepoRoot (real git repo + linked worktree)', () => {
  let base;
  let repo;
  let worktree;

  before(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-git-'));
    repo = path.join(base, 'main-repo-name');
    worktree = path.join(base, 'main-repo-name-GH-123');
    const run = (cmd, cwd) =>
      execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });

    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
    run('git init -q -b main', repo);
    run('git add seed.txt', repo);
    run('git -c user.email=t@t -c user.name=t commit -q -m init', repo);
    run(`git worktree add -q ${JSON.stringify(worktree)} -b gh-123`, repo);
  });

  after(() => fs.rmSync(base, { recursive: true, force: true }));

  it("strategy 'git-common-dir' resolves the MAIN repo name from a linked worktree", () => {
    const api = makeApi({ projectNameStrategy: 'git-common-dir' });
    // From the main checkout the name is unchanged…
    assert.equal(api.getProjectName(repo), 'main-repo-name');
    // …and from inside the linked worktree it must be the MAIN repo name, not
    // the worktree directory basename.
    assert.equal(api.getProjectName(worktree), 'main-repo-name');
  });

  it("strategy 'toplevel' resolves the worktree's own toplevel basename", () => {
    const api = makeApi();
    assert.equal(api.getProjectName(repo), 'main-repo-name');
    // Divergence between the two strategies, pinned: toplevel of a linked
    // worktree is the worktree directory itself.
    assert.equal(api.getProjectName(worktree), 'main-repo-name-GH-123');
  });

  it('both strategies resolve the repo name from a sub-directory of the checkout', () => {
    const sub = path.join(repo, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    const common = makeApi({ projectNameStrategy: 'git-common-dir' });
    assert.equal(common.getProjectName(sub), 'main-repo-name');
    assert.equal(makeApi().getProjectName(sub), 'main-repo-name');
  });

  it('both strategies fall back to basename(cwd) outside any git repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-no-git-'));
    try {
      const plain = path.join(dir, 'plain-project');
      fs.mkdirSync(plain, { recursive: true });
      assert.equal(makeApi().getProjectName(plain), 'plain-project');
      const common = makeApi({ projectNameStrategy: 'git-common-dir' });
      assert.equal(common.getProjectName(plain), 'plain-project');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('getRepoRoot returns the toplevel inside a repo and cwd itself outside', () => {
    const api = makeApi();
    const sub = path.join(repo, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    assert.equal(fs.realpathSync(api.getRepoRoot(sub)), fs.realpathSync(repo));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-root-'));
    try {
      assert.equal(api.getRepoRoot(dir), dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('findAncestorStore (walk-to-root variant)', () => {
  it('finds the nearest ancestor store from a deeply nested start dir', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-walk-'));
    try {
      const storeDir = seedMarker(path.join(base, '.claude', FOLDER));
      const deep = path.join(base, 'a', 'b', 'c');
      fs.mkdirSync(deep, { recursive: true });
      assert.equal(makeApi().findAncestorStore(deep), storeDir);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('returns "" when no ancestor carries the marker (walks to the root)', () => {
    // Unique folder name so a stray real store at /tmp or / can never match.
    const unique = createStoreDiscovery({
      folder: `${FOLDER}-${process.pid}`,
      marker: MARKER,
      projectNameStrategy: 'toplevel',
      ancestorWalkStopsAtHome: false,
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-walk-none-'));
    try {
      assert.equal(unique.findAncestorStore(dir), '');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('findAncestorStore HOME boundary', { skip: !HOME_DRIVEN }, () => {
  let originalHome;
  let base;
  let fakeHome;

  before(() => {
    originalHome = process.env.HOME;
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-homestop-'));
    fakeHome = path.join(base, 'home');
    fs.mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
  });

  after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(base, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(fakeHome, '.claude'), { recursive: true, force: true });
    fs.rmSync(path.join(base, '.claude'), { recursive: true, force: true });
  });

  it('keeps a marker AT $HOME/.claude/<folder> discoverable when stopping at home', () => {
    const storeDir = seedMarker(path.join(fakeHome, '.claude', FOLDER));
    const api = makeApi({ ancestorWalkStopsAtHome: true });
    assert.equal(api.findAncestorStore(fakeHome), storeDir);

    // And discovery from a repo directly under home surfaces it as the
    // worktree tier (marker checked BEFORE the home stop).
    const repo = path.join(fakeHome, 'myrepo');
    fs.mkdirSync(repo, { recursive: true });
    const wt = api.discoverStores(repo).find((s) => s.kind === 'worktree');
    assert.ok(wt, 'expected worktree store for repo directly under HOME');
    assert.equal(wt.dir, storeDir);
  });

  it('never continues past $HOME when stopping at home (returns "")', () => {
    // Marker planted ABOVE the fake home: reachable only by walking past it.
    const aboveHome = seedMarker(path.join(base, '.claude', FOLDER));
    const sub = path.join(fakeHome, 'sub', 'dir');
    fs.mkdirSync(sub, { recursive: true });

    const stopApi = makeApi({ ancestorWalkStopsAtHome: true });
    assert.equal(stopApi.findAncestorStore(sub), '');
    assert.equal(
      stopApi.discoverStores(sub).find((s) => s.kind === 'worktree'),
      undefined
    );

    // Control: the walk-to-root variant DOES find the same layout.
    assert.equal(makeApi().findAncestorStore(sub), aboveHome);
  });
});

describe('discoverStores', { skip: !HOME_DRIVEN }, () => {
  let originalHome;
  let base;
  let fakeHome;

  before(() => {
    originalHome = process.env.HOME;
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-discover-'));
    fakeHome = path.join(base, 'home');
    fs.mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
  });

  after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(base, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(fakeHome, '.claude'), { recursive: true, force: true });
    delete process.env[ENV_VAR];
  });

  // Layout: <root>/wt/.claude/<folder>       (worktree marker, via the walk)
  //         <root>/wt/repo/.claude/<folder>  (local marker)
  //         $HOME/.claude/<folder>/repo      (global marker)
  //         $HOME/.claude/<folder>-shared    (shared marker)
  function seedAllTiers(root) {
    const wt = path.join(root, 'wt');
    const repo = path.join(wt, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    seedMarker(path.join(repo, '.claude', FOLDER));
    seedMarker(path.join(wt, '.claude', FOLDER));
    seedMarker(path.join(fakeHome, '.claude', FOLDER, 'repo'));
    seedMarker(path.join(fakeHome, '.claude', `${FOLDER}-shared`));
    return { wt, repo };
  }

  it('returns all four tiers in PRECEDENCE_ORDER', () => {
    const { repo } = seedAllTiers(fs.mkdtempSync(path.join(base, 'all-')));
    const api = makeApi();
    const stores = api.discoverStores(repo);
    assert.deepEqual(
      stores.map((s) => s.kind),
      [...api.PRECEDENCE_ORDER]
    );
  });

  it('stamps shared with projectName null and every other tier with the string', () => {
    const { repo } = seedAllTiers(fs.mkdtempSync(path.join(base, 'names-')));
    for (const store of makeApi().discoverStores(repo)) {
      if (store.kind === 'shared') assert.equal(store.projectName, null);
      else assert.equal(store.projectName, 'repo');
    }
  });

  it('omits tiers whose marker is absent (marker gating)', () => {
    const root = fs.mkdtempSync(path.join(base, 'partial-'));
    const repo = path.join(root, 'wt', 'repo');
    fs.mkdirSync(repo, { recursive: true });
    seedMarker(path.join(repo, '.claude', FOLDER));
    seedMarker(path.join(fakeHome, '.claude', `${FOLDER}-shared`));
    // A store DIRECTORY without a marker must not surface.
    fs.mkdirSync(path.join(fakeHome, '.claude', FOLDER, 'repo'), { recursive: true });

    const kinds = makeApi()
      .discoverStores(repo)
      .map((s) => s.kind);
    assert.deepEqual(kinds, ['local', 'shared']);
  });

  it('worktree tier comes from the ancestor walk, not the fixed parent row', () => {
    const root = fs.mkdtempSync(path.join(base, 'deep-'));
    const wtStore = seedMarker(path.join(root, '.claude', FOLDER));
    // Two levels below the store base: the candidateStores parent row
    // (<cwd>/../.claude/<folder>) has no marker, but the walk still resolves.
    const cwd = path.join(root, 'nested', 'repo');
    fs.mkdirSync(cwd, { recursive: true });

    const stores = makeApi().discoverStores(cwd);
    assert.deepEqual(stores, [{ kind: 'worktree', dir: wtStore, projectName: 'repo' }]);
  });

  it('discovers the shared store from any unrelated cwd (cross-project)', () => {
    seedMarker(path.join(fakeHome, '.claude', `${FOLDER}-shared`));
    const cwdA = fs.mkdtempSync(path.join(base, 'projA-'));
    const cwdB = fs.mkdtempSync(path.join(base, 'projB-'));
    for (const cwd of [cwdA, cwdB]) {
      const shared = makeApi()
        .discoverStores(cwd)
        .find((s) => s.kind === 'shared');
      assert.ok(shared, `expected shared store from ${cwd}`);
      assert.equal(shared.dir, path.join(fakeHome, '.claude', `${FOLDER}-shared`));
      assert.equal(shared.projectName, null);
    }
  });

  it('dedupes tiers that resolve to the same directory', () => {
    // A non-normalized cwd makes two tiers land on one store: the local join
    // collapses the trailing "x/.." to <proj>/.claude/<folder>, while the
    // worktree walk starts at dirname(<raw cwd>) = <proj>/x and finds the
    // same marker one level up. The resolved-dir seen-set must emit ONE row.
    const root = fs.mkdtempSync(path.join(base, 'dedupe-'));
    const proj = path.join(root, 'proj');
    fs.mkdirSync(path.join(proj, 'x'), { recursive: true });
    const storeDir = seedMarker(path.join(proj, '.claude', FOLDER));

    const rawCwd = `${proj}/x/..`;
    const stores = makeApi().discoverStores(rawCwd);
    assert.equal(stores.length, 1, `expected one deduped row, got ${JSON.stringify(stores)}`);
    assert.equal(stores[0].kind, 'local');
    assert.equal(stores[0].dir, storeDir);
  });

  it('skips global+shared when the configured env var is "1"', () => {
    const { repo } = seedAllTiers(fs.mkdtempSync(path.join(base, 'gate-on-')));
    const api = makeApi({ disableHomeStoresEnvVar: ENV_VAR });
    process.env[ENV_VAR] = '1';
    assert.deepEqual(
      api.discoverStores(repo).map((s) => s.kind),
      ['local', 'worktree']
    );
  });

  it('keeps home tiers when the env var is unset or not "1"', () => {
    const { repo } = seedAllTiers(fs.mkdtempSync(path.join(base, 'gate-off-')));
    const api = makeApi({ disableHomeStoresEnvVar: ENV_VAR });
    assert.equal(api.discoverStores(repo).length, 4);
    process.env[ENV_VAR] = '0';
    assert.equal(api.discoverStores(repo).length, 4);
  });

  it('ignores the env value entirely when disableHomeStoresEnvVar is null', () => {
    const { repo } = seedAllTiers(fs.mkdtempSync(path.join(base, 'gate-null-')));
    process.env[ENV_VAR] = '1';
    assert.equal(makeApi().discoverStores(repo).length, 4);
  });
});

// ─── Real-call-site parity (#579 acceptance) ────────────────────────────────
//
// The factory must reproduce a REAL adopter: the synapsys memory-store builds
// its discovery from the vendored copy of this factory with the config below.
// Plugin-branded strings are fine HERE — factories/README.md rule 1 states
// self-tests may import the real plugin tree as fixtures; only the factory
// module itself must stay plugin-neutral. Skips cleanly when the plugin file
// is absent so the factory suite still stands alone.

const MEMORY_STORE_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'plugins',
  'synapsys',
  'lib',
  'memory-store.js'
);
const HAS_MEMORY_STORE = fs.existsSync(MEMORY_STORE_PATH);
const SYNAPSYS_ENV_VAR = 'SYNAPSYS_DISABLE_HOME_STORES';

describe('parity with the real synapsys call site (memory-store.js)', {
  skip: !HOME_DRIVEN || !HAS_MEMORY_STORE,
}, () => {
  let originalHome;
  let originalDisable;
  let base;
  let fakeHome;

  before(() => {
    originalHome = process.env.HOME;
    originalDisable = process.env[SYNAPSYS_ENV_VAR];
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-parity-'));
    fakeHome = path.join(base, 'home');
    fs.mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
    delete process.env[SYNAPSYS_ENV_VAR];
  });

  after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalDisable === undefined) delete process.env[SYNAPSYS_ENV_VAR];
    else process.env[SYNAPSYS_ENV_VAR] = originalDisable;
    fs.rmSync(base, { recursive: true, force: true });
  });

  function seedSynapsysMarker(dir) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.synapsys.json'), '{}\n');
    return dir;
  }

  it('discoverStores deep-equals the shipped memory-store output on a full fixture layout', () => {
    const memoryStore = require(MEMORY_STORE_PATH);
    const factoryApi = createStoreDiscovery({
      folder: 'synapsys',
      marker: '.synapsys.json',
      projectNameStrategy: 'git-common-dir',
      ancestorWalkStopsAtHome: false,
      disableHomeStoresEnvVar: SYNAPSYS_ENV_VAR,
    });

    const wt = path.join(base, 'wt');
    const repo = path.join(wt, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    seedSynapsysMarker(path.join(repo, '.claude', 'synapsys'));
    seedSynapsysMarker(path.join(wt, '.claude', 'synapsys'));
    seedSynapsysMarker(path.join(fakeHome, '.claude', 'synapsys', 'repo'));
    seedSynapsysMarker(path.join(fakeHome, '.claude', 'synapsys-shared'));

    const fromPlugin = memoryStore.discoverStores(repo);
    // Sanity: the fixture must exercise all four tiers or the parity claim
    // is vacuous.
    assert.deepEqual(
      fromPlugin.map((s) => s.kind),
      ['local', 'worktree', 'global', 'shared']
    );
    assert.deepEqual(factoryApi.discoverStores(repo), fromPlugin);

    // Parity must also hold with the home-store gate engaged.
    process.env[SYNAPSYS_ENV_VAR] = '1';
    try {
      const gatedPlugin = memoryStore.discoverStores(repo);
      assert.deepEqual(
        gatedPlugin.map((s) => s.kind),
        ['local', 'worktree']
      );
      assert.deepEqual(factoryApi.discoverStores(repo), gatedPlugin);
    } finally {
      delete process.env[SYNAPSYS_ENV_VAR];
    }
  });
});
