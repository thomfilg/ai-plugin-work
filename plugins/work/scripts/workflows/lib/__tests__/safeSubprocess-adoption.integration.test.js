// safeSubprocess-adoption.integration.test.js — Task 6 (GH-690)
//
// Verifies that /work's production subprocess call site
// `plugins/work/scripts/workflows/work-implement/lib/changed-test-files.js`
// has been migrated onto the vendored safeSubprocess wrapper
// (`plugins/work/scripts/workflows/lib/safeSubprocess`).
//
// `detectChangedTestFilesInScope` issues THREE best-effort `git` probes
//   - git diff --name-only
//   - git diff --cached --name-only
//   - git ls-files --others --exclude-standard
// none of which set a timeout in the committed (unmigrated) baseline. The
// migration is behavior-preserving: the exact `.status !== 0` / `.stdout`
// success predicate over each raw result object stays intact; the ONLY intended
// delta is that each probe now runs through `safeSpawnSync`, which injects the
// enforced default timeout (15000 ms) and forces `shell: false`.
//
// Strategy (mirrors the maestro adoption test): we intercept
// `node:child_process.spawnSync` in a spawned Node child via a
// NODE_OPTIONS=--require preload shim, run a tiny driver that requires the real
// target module and calls `detectChangedTestFilesInScope`, and observe the exact
// options object that reaches child_process AFTER the wrapper applied its policy.
// This tests real end-to-end behavior, not source text, and survives refactoring
// of the call site.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');
const VENDOR_DIR = path.join(
  REPO_ROOT,
  'plugins',
  'work',
  'scripts',
  'workflows',
  'lib',
  'safeSubprocess'
);
const TARGET = path.join(
  REPO_ROOT,
  'plugins',
  'work',
  'scripts',
  'workflows',
  'work-implement',
  'lib',
  'changed-test-files.js'
);

/**
 * Build a preload shim that intercepts `node:child_process.spawnSync`, records
 * every (command, args, options) triple to `outFile`, and short-circuits the
 * real spawn with a canned success result so the test never depends on the
 * driver running inside a real git repo. The shim is applied via
 * NODE_OPTIONS=--require, so it patches the shared child_process module object
 * before the target (or the vendored wrapper) destructures `spawnSync`.
 */
function writeSpawnSyncShim(dir, outFile) {
  const shim = path.join(dir, 'spawnsync-shim.js');
  const src = `
'use strict';
const fs = require('fs');
const cp = require('node:child_process');
const realSpawnSync = cp.spawnSync;
cp.spawnSync = function (command, args, options) {
  try {
    const rec = { command, args, options: options || {} };
    fs.appendFileSync(${JSON.stringify(outFile)}, JSON.stringify(rec) + '\\n');
  } catch {}
  // Canned success so the caller's r.status === 0 predicate is exercised.
  return { status: 0, stdout: '', stderr: '', signal: null, error: null };
};
`;
  fs.writeFileSync(shim, src);
  return shim;
}

/**
 * Build a driver script that requires the real target module and invokes
 * `detectChangedTestFilesInScope(repoRoot, scope)` once. The three git probes
 * inside it are what we want to observe through the shim.
 */
function writeDriver(dir) {
  const driver = path.join(dir, 'driver.js');
  const src = `
'use strict';
const { detectChangedTestFilesInScope } = require(${JSON.stringify(TARGET)});
// Empty scope → every changed test file passes through; return value is
// irrelevant to this test — we only care about the git probe options.
detectChangedTestFilesInScope(${JSON.stringify(REPO_ROOT)}, []);
`;
  fs.writeFileSync(driver, src);
  return driver;
}

function runDriverWithShim(tmpDir) {
  const outFile = path.join(tmpDir, 'spawn-calls.ndjson');
  fs.writeFileSync(outFile, '');
  const shim = writeSpawnSyncShim(tmpDir, outFile);
  const driver = writeDriver(tmpDir);
  const res = spawnSync(process.execPath, [driver], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${shim}`.trim(),
    },
  });
  const calls = fs
    .readFileSync(outFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return { res, calls };
}

/** Return the recorded git probes in call order. */
function gitProbes(calls) {
  return calls.filter((c) => c.command === 'git' && Array.isArray(c.args));
}

test('vendored safeSubprocess module is available to the /work call site', () => {
  const mod = require(VENDOR_DIR);
  assert.equal(typeof mod.safeSpawnSync, 'function', 'safeSpawnSync export missing');
  assert.equal(typeof mod.safeExecFileSync, 'function', 'safeExecFileSync export missing');
});

test('changed-test-files.js no longer imports raw spawnSync from child_process', () => {
  const src = fs.readFileSync(TARGET, 'utf8');
  // The migrated file must import the vendored wrapper.
  assert.match(
    src,
    /require\(['"][^'"]*lib\/safeSubprocess['"]\)/,
    'changed-test-files.js must require the vendored safeSubprocess wrapper'
  );
  // And must NOT keep a raw child_process spawnSync import.
  assert.doesNotMatch(
    src,
    /require\(['"](?:node:)?child_process['"]\)/,
    'changed-test-files.js must not import raw child_process directly after migration'
  );
});

test('all three git probes go through safeSpawnSync (enforced default timeout + shell:false)', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-adopt-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const { res, calls } = runDriverWithShim(tmpDir);
  assert.equal(res.status, 0, `driver exited nonzero: ${res.stderr}`);

  const probes = gitProbes(calls);
  assert.equal(
    probes.length,
    3,
    `expected exactly 3 git probes (diff, diff --cached, ls-files); got ${probes.length}`
  );

  // The three probes we expect, matched by their leading args.
  const expected = [
    ['diff', '--name-only'],
    ['diff', '--cached', '--name-only'],
    ['ls-files', '--others', '--exclude-standard'],
  ];
  for (const want of expected) {
    const probe = probes.find((p) => want.every((tok, i) => p.args[i] === tok));
    assert.ok(probe, `expected a git probe with leading args ${JSON.stringify(want)}`);
    // Enforced default: the wrapper injects timeout: 15000 for a site with no timeout.
    assert.equal(
      probe.options.timeout,
      15000,
      `git ${want.join(' ')} must run under the enforced default 15000 ms timeout`
    );
    // The wrapper always forces shell: false.
    assert.equal(probe.options.shell, false, `git ${want.join(' ')} must run with shell: false`);
  }
});

test('migrated probes preserve their pass-through options (cwd + encoding)', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-adopt-opts-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const { res, calls } = runDriverWithShim(tmpDir);
  assert.equal(res.status, 0, `driver exited nonzero: ${res.stderr}`);

  const probes = gitProbes(calls);
  assert.ok(probes.length >= 1, 'expected at least one git probe recorded');
  for (const p of probes) {
    // Non-policy options must pass through the wrapper untouched.
    assert.equal(p.options.cwd, REPO_ROOT, 'cwd must pass through the wrapper unchanged');
    assert.equal(p.options.encoding, 'utf8', 'encoding must pass through the wrapper unchanged');
  }
});

test('the success predicate over the raw result object is preserved (status !== 0 path)', () => {
  // With the shim returning { status: 0 } for every probe, detectChangedTestFilesInScope
  // must NOT emit the "git change detection failed" warning: the migrated call
  // site keeps its `r.status !== 0 → gitFailed` predicate over the raw result.
  const src = fs.readFileSync(TARGET, 'utf8');
  assert.match(
    src,
    /\.status\s*!==\s*0/,
    'the raw-result success predicate (.status !== 0) must survive the migration'
  );
  assert.match(src, /\.stdout\b/, 'the raw-result stdout read must survive the migration');
});
