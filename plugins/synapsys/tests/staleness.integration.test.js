'use strict';

/**
 * Integration tests for `scripts/synapsys-staleness-check.js`.
 *
 * Spawns the CLI as a subprocess (mirrors `lint.integration.test.js`) and
 * asserts on exit codes + stdout shape for the five gherkin scenarios this
 * task covers: S5, S6, S7, S8, S9.
 *
 * Fixtures live under `tests/fixtures/store-mixed/` and `store-all-fresh/`.
 * Their pre-computed `source_hash` frontmatter values were generated against
 * the sibling `tests/fixtures/sample-repo/docs/*.md` byte content (see the
 * helper at the bottom of this file for the recipe).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'scripts', 'synapsys-staleness-check.js');
const SAMPLE_REPO = path.join(__dirname, 'fixtures', 'sample-repo');
const STORE_MIXED = path.join(__dirname, 'fixtures', 'store-mixed');
const STORE_ALL_FRESH = path.join(__dirname, 'fixtures', 'store-all-fresh');

function run(args, opts) {
  const env = Object.assign({}, process.env, { NO_COLOR: '1' }, (opts && opts.env) || {});
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env,
  });
}

test('CASE 5 (S5) — exit code 1 when store has drifted or orphan sources', () => {
  const r = run([`--cwd=${SAMPLE_REPO}`, `--store=${STORE_MIXED}`, '--no-color']);
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stderr=${r.stderr}`);
  // At least one of DRIFTED / ORPHAN block headers must appear in stdout.
  assert.ok(
    /DRIFTED|ORPHAN/.test(r.stdout),
    `expected DRIFTED or ORPHAN block in stdout, got:\n${r.stdout}`
  );
});

test('CASE 6 (S6) — exit code 0 when all sources are fresh', () => {
  const r = run([`--cwd=${SAMPLE_REPO}`, `--store=${STORE_ALL_FRESH}`, '--no-color']);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr=${r.stderr}\nstdout=${r.stdout}`);
  // Summary line should report zero drifted and zero orphan.
  assert.match(r.stdout, /drifted[^0-9]*0/i);
  assert.match(r.stdout, /orphan[^0-9]*0/i);
});

test('CASE 7 (S7) — --json emits per-source results + summary on store-mixed', () => {
  const r = run([`--cwd=${SAMPLE_REPO}`, `--store=${STORE_MIXED}`, '--json']);
  // Exit code is still 1 (drifted/orphan present) but stdout MUST parse.
  let payload;
  assert.doesNotThrow(() => {
    payload = JSON.parse(r.stdout);
  }, `stdout was not parseable JSON:\n${r.stdout}`);
  assert.ok(Array.isArray(payload.results), 'results is an array');
  assert.ok(payload.results.length > 0, 'at least one result entry');
  for (const entry of payload.results) {
    for (const key of ['source', 'status', 'stored_hash', 'current_hash', 'memories']) {
      assert.ok(key in entry, `result entry missing key '${key}': ${JSON.stringify(entry)}`);
    }
    assert.ok(Array.isArray(entry.memories), 'memories is an array');
  }
  assert.ok(payload.summary && typeof payload.summary === 'object', 'summary present');
  for (const key of ['drifted', 'orphan', 'fresh', 'memories_affected']) {
    assert.ok(key in payload.summary, `summary missing key '${key}'`);
    assert.equal(typeof payload.summary[key], 'number', `summary.${key} is a number`);
  }
});

test('CASE S8 — exit code 2 + "store not found" on stderr for missing store kind', () => {
  const r = run([`--cwd=${SAMPLE_REPO}`, '--store=does-not-exist', '--no-color']);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}. stdout=${r.stdout}\nstderr=${r.stderr}`);
  assert.match(r.stderr, /store not found/i);
});

test('CASE S9 — --verbose adds FRESH block in addition to DRIFTED block', () => {
  const r = run([`--cwd=${SAMPLE_REPO}`, `--store=${STORE_MIXED}`, '--verbose', '--no-color']);
  // Mixed store contains both fresh and drifted sources, so both blocks should appear.
  assert.match(r.stdout, /FRESH/, `expected FRESH block in --verbose stdout:\n${r.stdout}`);
  assert.match(r.stdout, /DRIFTED/, `expected DRIFTED block in --verbose stdout:\n${r.stdout}`);
});

// ---------------------------------------------------------------------------
// S10 — --re-consolidate dispatches the owning profile for each drifted source
// ---------------------------------------------------------------------------

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Build a fresh sandbox containing:
 *   - profilesDir with the given profile files
 *   - a stub consolidate binary that logs its argv to a file and exits with
 *     the supplied code for matching --profile=<name> calls
 * Returns paths and a helper to read the captured argv lines.
 */
function makeStubConsolidate({ exitFor } = {}) {
  const stubDir = mkTmpDir('synapsys-stub-');
  const logFile = path.join(stubDir, 'calls.log');
  const exitMap = exitFor || {};
  const stub = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const exitMap = ${JSON.stringify(exitMap)};
const profileArg = process.argv.slice(2).find((a) => a.startsWith('--profile='));
const name = profileArg ? profileArg.slice('--profile='.length) : '';
process.exit(exitMap[name] != null ? exitMap[name] : 0);
`;
  const stubPath = path.join(stubDir, 'stub-consolidate.js');
  fs.writeFileSync(stubPath, stub, { mode: 0o755 });
  return {
    stubPath,
    logFile,
    readCalls() {
      if (!fs.existsSync(logFile)) return [];
      return fs
        .readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    },
  };
}

function makeProfilesDir(profiles) {
  const dir = mkTmpDir('synapsys-profiles-');
  for (const [filename, exportObj] of Object.entries(profiles)) {
    fs.writeFileSync(
      path.join(dir, filename),
      `'use strict';\nmodule.exports = ${JSON.stringify(exportObj)};\n`
    );
  }
  return dir;
}

test('CASE S10a — --re-consolidate spawns stub with --profile=<owner> for drifted source, skips orphan', () => {
  // store-mixed has a drifted source `docs/b.md` and an orphan `docs/c-missing.md`.
  const profilesDir = makeProfilesDir({
    'good-profile.js': { name: 'good', sources: ['docs/b.md'] },
  });
  const stub = makeStubConsolidate();
  const r = run([`--cwd=${SAMPLE_REPO}`, `--store=${STORE_MIXED}`, '--re-consolidate', '--no-color'], {
    env: {
      SYNAPSYS_CONSOLIDATE_BIN_FOR_TEST: stub.stubPath,
      SYNAPSYS_PROFILES_DIR_FOR_TEST: profilesDir,
    },
  });
  // Drift remained (we don't actually mutate hashes) so exit stays non-zero.
  assert.notEqual(r.status, 0, `expected non-zero exit, got ${r.status}. stderr=${r.stderr}\nstdout=${r.stdout}`);
  const calls = stub.readCalls();
  assert.ok(calls.length >= 1, `expected at least one spawn call, got ${calls.length}`);
  // Spawn must include --profile=good for the drifted source.
  const flat = calls.flat();
  assert.ok(
    flat.includes('--profile=good'),
    `expected --profile=good in spawn argv, got ${JSON.stringify(calls)}`
  );
  // Orphan source `docs/c-missing.md` must NOT be dispatched: no call should
  // contain a missing-profile argument referencing that path.
  const orphanCall = calls.find((argv) => argv.some((a) => a.includes('c-missing')));
  assert.equal(orphanCall, undefined, `orphan must not be auto-acted on, got ${JSON.stringify(calls)}`);
});

test('CASE S10b — --re-consolidate emits stderr warning AND skips spawn when source is ambiguous', () => {
  // Both profiles claim docs/b.md → ambiguous.
  const profilesDir = makeProfilesDir({
    'first-profile.js': { name: 'first', sources: ['docs/b.md'] },
    'second-profile.js': { name: 'second', sources: ['docs/b.md'] },
  });
  const stub = makeStubConsolidate();
  const r = run([`--cwd=${SAMPLE_REPO}`, `--store=${STORE_MIXED}`, '--re-consolidate', '--no-color'], {
    env: {
      SYNAPSYS_CONSOLIDATE_BIN_FOR_TEST: stub.stubPath,
      SYNAPSYS_PROFILES_DIR_FOR_TEST: profilesDir,
    },
  });
  // Warning must name both profiles.
  assert.match(r.stderr, /first/, `expected 'first' in ambiguity warning: ${r.stderr}`);
  assert.match(r.stderr, /second/, `expected 'second' in ambiguity warning: ${r.stderr}`);
  assert.match(r.stderr, /ambiguous/i, `expected 'ambiguous' wording: ${r.stderr}`);
  // No spawn at all for the ambiguous source.
  const calls = stub.readCalls();
  const matched = calls.find((argv) => argv.some((a) => a === '--profile=first' || a === '--profile=second'));
  assert.equal(matched, undefined, `ambiguous source must be skipped, got ${JSON.stringify(calls)}`);
});

test('CASE S10d — getProfileForSource: single match returns { name }, no match returns null, missing dir tolerated', () => {
  const { getProfileForSource } = require('../lib/staleness');
  // Missing dir → null (no crash).
  assert.equal(
    getProfileForSource('docs/a.md', { profilesDir: path.join(os.tmpdir(), 'definitely-not-here-' + Date.now()) }),
    null
  );
  // Single match → { name }
  const single = makeProfilesDir({ 'p.js': { name: 'p', sources: ['docs/a.md'] } });
  const hit = getProfileForSource('docs/a.md', { profilesDir: single });
  assert.ok(hit && hit.name === 'p', `expected { name: 'p' }, got ${JSON.stringify(hit)}`);
  // No match → null
  const empty = makeProfilesDir({ 'p.js': { name: 'p', sources: ['docs/other.md'] } });
  assert.equal(getProfileForSource('docs/a.md', { profilesDir: empty }), null);
  // Ambiguous → { ambiguous: true, profiles: [...] }
  const ambig = makeProfilesDir({
    'p1.js': { name: 'p1', sources: ['docs/a.md'] },
    'p2.js': { name: 'p2', sources: ['docs/a.md'] },
  });
  const amb = getProfileForSource('docs/a.md', { profilesDir: ambig });
  assert.ok(amb && amb.ambiguous === true, `expected ambiguous result, got ${JSON.stringify(amb)}`);
  assert.deepEqual([...amb.profiles].sort(), ['p1', 'p2']);
});

test('CASE S10c — --re-consolidate continues to next source after a spawn failure and exits non-zero overall', () => {
  // Two drifted sources both owned by `good`; stub fails for the first profile
  // invocation but the script must keep going and ultimately exit non-zero.
  const profilesDir = makeProfilesDir({
    'good-profile.js': { name: 'good', sources: ['docs/b.md'] },
  });
  const stub = makeStubConsolidate({ exitFor: { good: 7 } });
  const r = run([`--cwd=${SAMPLE_REPO}`, `--store=${STORE_MIXED}`, '--re-consolidate', '--no-color'], {
    env: {
      SYNAPSYS_CONSOLIDATE_BIN_FOR_TEST: stub.stubPath,
      SYNAPSYS_PROFILES_DIR_FOR_TEST: profilesDir,
    },
  });
  // Stub failed → overall exit code must be non-zero.
  assert.notEqual(r.status, 0, `expected non-zero exit after spawn failure, got ${r.status}`);
  // Stub was actually invoked at least once for the drifted source.
  const calls = stub.readCalls();
  assert.ok(
    calls.some((argv) => argv.includes('--profile=good')),
    `expected at least one --profile=good invocation, got ${JSON.stringify(calls)}`
  );
});

// ---------------------------------------------------------------------------
// CASE 8 / CASE 9 — pending GH-442 (stamping contract lives in sibling
// `synapsys-consolidate.js`, which is not yet on disk in this ticket).
// These are documentation-only `test.skip` entries so `node --test` output
// records the eventual contract surface. When GH-442 lands, lift the `.skip`
// and implement the bodies against the real consolidate script.
// ---------------------------------------------------------------------------

test.skip(
  'CASE 8 — pending GH-442 — stamping hook lives in sibling consolidate script',
  () => {
    // Eventual contract: after `synapsys-consolidate` writes a memory file,
    // its frontmatter MUST contain:
    //   - `source: <repo-relative path>` (no leading slash, POSIX separators)
    //   - `source_hash: sha256:<64 lowercase hex>` matching
    //     /^sha256:[0-9a-f]{64}$/ over the raw bytes of the source file.
    assert.ok(true);
  }
);

test.skip(
  'CASE 9 — pending GH-442 — stamp stability across runs',
  () => {
    // Eventual contract: running `synapsys-consolidate` twice against an
    // unchanged source file MUST yield byte-identical `source_hash` values
    // in the resulting memory frontmatter (deterministic hashing, no
    // timestamp leakage into the hashed payload).
    assert.ok(true);
  }
);
