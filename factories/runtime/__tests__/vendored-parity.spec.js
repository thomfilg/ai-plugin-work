/**
 * Tests for scripts/sync-vendored.js — the vendored-copy parity gate
 * (design §B): every vendor dir in every VENDOR_SETS entry must be a
 * byte-identical, GENERATED-bannered copy of its factories/<lib> master, and
 * each vendored copy must load standalone (no require may escape the plugin
 * dir — codex cache isolation, INV P7).
 *
 * Run: node --test factories/runtime/__tests__/vendored-parity.spec.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const SYNC_SCRIPT = path.join(REPO_ROOT, 'scripts', 'sync-vendored.js');

const {
  VENDOR_SETS,
  BANNER_PREFIX,
  banner,
  listMasterFiles,
  expectedContent,
  check,
  sync,
} = require(SYNC_SCRIPT);

// Exact per-master file lists. Adding a file to any master (or a whole new
// vendor set) must be a deliberate, loud change here — never a drive-by.
const EXPECTED_MASTER_FILES = {
  'factories/runtime': [
    'doctor.js',
    'emit.js',
    'envconfig-lite.js',
    'index.js',
    'payload.js',
    'tickets.js',
    'tools.js',
    'transcript-claude.js',
    'transcript-codex.js',
    'transcript-shared.js',
    'transcript.js',
    'vocab.js',
  ],
  'factories/storeDiscovery': ['index.js', 'storeDiscovery.js'],
  'factories/safeIO': ['index.js', 'safeIO.js'],
  'factories/hookEntrypoint': ['hookEntrypoint.js', 'index.js', 'logHookError.js'],
  'factories/safeSubprocess': ['index.js', 'safeSubprocess.js'],
  'factories/pathSafe': ['index.js', 'pathSafe.js'],
};

const RUNTIME_SET = VENDOR_SETS.find((set) => set.master === 'factories/runtime');

function masterFilesOf(set) {
  return listMasterFiles(set.master, REPO_ROOT);
}

const TOTAL_VENDORED_FILES = VENDOR_SETS.reduce(
  (n, set) => n + masterFilesOf(set).length * set.vendorDirs.length,
  0
);

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function copyMastersInto(root) {
  for (const set of VENDOR_SETS) {
    fs.mkdirSync(path.join(root, set.master), { recursive: true });
    for (const name of masterFilesOf(set)) {
      fs.copyFileSync(path.join(REPO_ROOT, set.master, name), path.join(root, set.master, name));
    }
  }
}

// Scratch trees live under os.tmpdir() and are deliberately never removed.
function makeTempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `vendored-parity-${label}-`));
}

describe('VENDOR_SETS table shape', () => {
  it('covers exactly the expected masters (new sets must be registered here)', () => {
    assert.deepEqual(
      VENDOR_SETS.map((set) => set.master).sort(),
      Object.keys(EXPECTED_MASTER_FILES).sort()
    );
  });

  it('runtime master keeps its four plugin vendor dirs', () => {
    assert.ok(RUNTIME_SET, 'factories/runtime must stay in VENDOR_SETS');
    assert.deepEqual(RUNTIME_SET.vendorDirs, [
      'plugins/heimdall/lib/runtime',
      'plugins/maestro/scripts/lib/runtime',
      'plugins/synapsys/lib/runtime',
      'plugins/work/scripts/workflows/lib/runtime',
    ]);
  });

  // Exact vendorDirs pins for the non-runtime sets: silently dropping a table
  // entry (a vendored dir losing parity coverage) must fail this suite, not
  // pass quietly because the loop below simply iterates fewer dirs.
  const EXPECTED_VENDOR_DIRS = {
    'factories/storeDiscovery': [
      'plugins/synapsys/lib/storeDiscovery',
      'plugins/heimdall/lib/storeDiscovery',
    ],
    'factories/safeIO': ['plugins/work/scripts/workflows/lib/safeIO'],
    'factories/hookEntrypoint': [
      'plugins/synapsys/lib/hookEntrypoint',
      'plugins/work/scripts/workflows/lib/hookEntrypoint',
    ],
    'factories/safeSubprocess': ['plugins/work/scripts/workflows/lib/safeSubprocess'],
    'factories/pathSafe': ['plugins/heimdall/lib/pathSafe'],
  };

  for (const [master, vendorDirs] of Object.entries(EXPECTED_VENDOR_DIRS)) {
    it(`${master} keeps its exact vendor dirs`, () => {
      const set = VENDOR_SETS.find((s) => s.master === master);
      assert.ok(set, `${master} must stay in VENDOR_SETS`);
      assert.deepEqual(set.vendorDirs, vendorDirs);
    });
  }

  it("quality.js's vendored-dir exclusion list equals the sorted union of all vendor dirs", () => {
    const { VENDORED_DIRS } = require(
      path.join(REPO_ROOT, 'plugins/work/scripts/workflows/lib/scripts/quality/quality.js')
    );
    const union = [...new Set(VENDOR_SETS.flatMap((set) => set.vendorDirs))].sort();
    assert.deepEqual(VENDORED_DIRS, union);
  });
});

describe('vendored copies match their masters (sha256)', () => {
  for (const set of VENDOR_SETS) {
    const masterFiles = masterFilesOf(set);

    it(`${set.master} has the expected module set`, () => {
      assert.deepEqual(masterFiles, EXPECTED_MASTER_FILES[set.master]);
    });

    for (const vendorDir of set.vendorDirs) {
      for (const name of masterFiles) {
        it(`${vendorDir}/${name} is banner + master bytes`, () => {
          const vendored = fs.readFileSync(path.join(REPO_ROOT, vendorDir, name), 'utf8');
          assert.equal(sha256(vendored), sha256(expectedContent(set.master, name, REPO_ROOT)));
        });
      }

      it(`${vendorDir} has no stale .js files`, () => {
        const extras = fs
          .readdirSync(path.join(REPO_ROOT, vendorDir))
          .filter((f) => f.endsWith('.js') && !masterFiles.includes(f));
        assert.deepEqual(extras, []);
      });
    }

    it(`every ${set.master} vendored file carries the GENERATED banner`, () => {
      for (const vendorDir of set.vendorDirs) {
        for (const name of masterFiles) {
          const vendored = fs.readFileSync(path.join(REPO_ROOT, vendorDir, name), 'utf8');
          assert.ok(
            vendored.startsWith(banner(set.master, name)),
            `${vendorDir}/${name} must start with "${BANNER_PREFIX}${set.master}/${name} …"`
          );
        }
      }
    });
  }

  it('check(REPO_ROOT) reports parity', () => {
    assert.deepEqual(check(REPO_ROOT), []);
  });
});

describe('parity self-test — injected drift fails the check', () => {
  it('flags a hand-edited vendored file (module API and --check CLI agree)', () => {
    const root = makeTempRoot('drift');
    copyMastersInto(root);
    const { written, stale } = sync(root);
    assert.equal(written.length, TOTAL_VENDORED_FILES);
    assert.deepEqual(stale, []);
    assert.deepEqual(check(root), []);

    const drifted = path.join(root, RUNTIME_SET.vendorDirs[0], 'emit.js');
    fs.appendFileSync(drifted, '\n// hand edit\n');

    const problems = check(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /emit\.js: drifted from factories\/runtime\/emit\.js/);

    const res = spawnSync(process.execPath, [SYNC_SCRIPT, '--check', `--root=${root}`], {
      encoding: 'utf8',
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /emit\.js: drifted/);
  });

  it('flags a missing vendored file', () => {
    const root = makeTempRoot('missing');
    copyMastersInto(root);
    sync(root);
    // Recreate the tree minus one file rather than deleting from it.
    const gapped = makeTempRoot('missing-gap');
    copyMastersInto(gapped);
    for (const set of VENDOR_SETS) {
      for (const vendorDir of set.vendorDirs) {
        fs.mkdirSync(path.join(gapped, vendorDir), { recursive: true });
        for (const name of masterFilesOf(set)) {
          if (vendorDir === RUNTIME_SET.vendorDirs[1] && name === 'tools.js') continue;
          fs.copyFileSync(path.join(root, vendorDir, name), path.join(gapped, vendorDir, name));
        }
      }
    }
    const problems = check(gapped);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /tools\.js: missing/);
  });

  it('flags a stale vendored file with no master counterpart', () => {
    const root = makeTempRoot('stale');
    copyMastersInto(root);
    sync(root);
    fs.writeFileSync(path.join(root, RUNTIME_SET.vendorDirs[2], 'orphan.js'), '// leftover\n');
    const problems = check(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /orphan\.js: stale/);
  });

  it('--check exits 0 and sync is idempotent on a clean tree', () => {
    const root = makeTempRoot('clean');
    copyMastersInto(root);
    sync(root);
    const again = sync(root);
    assert.deepEqual(again.written, []);
    const res = spawnSync(process.execPath, [SYNC_SCRIPT, '--check', `--root=${root}`], {
      encoding: 'utf8',
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /in parity/);
  });
});

describe('vendored copies load standalone (factories/ absent)', () => {
  for (const set of VENDOR_SETS) {
    for (const vendorDir of set.vendorDirs) {
      it(`${vendorDir} requires cleanly with no factories/ in the tree`, () => {
        const root = makeTempRoot('standalone');
        const target = path.join(root, vendorDir);
        fs.mkdirSync(target, { recursive: true });
        for (const name of masterFilesOf(set)) {
          fs.copyFileSync(path.join(REPO_ROOT, vendorDir, name), path.join(target, name));
        }
        assert.equal(fs.existsSync(path.join(root, 'factories')), false);
        const script = masterFilesOf(set)
          .map((name) => `require(${JSON.stringify(path.join(target, name))});`)
          .join('');
        const res = spawnSync(process.execPath, ['-e', script], {
          cwd: path.join(root, vendorDir.split('/').slice(0, 2).join(path.sep)),
          encoding: 'utf8',
        });
        assert.equal(res.status, 0, `require failed: ${res.stderr}`);
      });
    }
  }
});
