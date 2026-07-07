/**
 * Tests for scripts/sync-vendored.js — the vendored-copy parity gate
 * (design §B): every plugin's `runtime/` dir must be a byte-identical,
 * GENERATED-bannered copy of factories/runtime, and each vendored copy must
 * load standalone (no require may escape the plugin dir — codex cache
 * isolation, INV P7).
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
  MASTER_DIR,
  VENDOR_DIRS,
  BANNER_PREFIX,
  banner,
  listMasterFiles,
  expectedContent,
  check,
  sync,
} = require(SYNC_SCRIPT);

const MASTER_FILES = listMasterFiles(REPO_ROOT);

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function copyMasterInto(root) {
  fs.mkdirSync(path.join(root, MASTER_DIR), { recursive: true });
  for (const name of MASTER_FILES) {
    fs.copyFileSync(path.join(REPO_ROOT, MASTER_DIR, name), path.join(root, MASTER_DIR, name));
  }
}

// Scratch trees live under os.tmpdir() and are deliberately never removed.
function makeTempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `vendored-parity-${label}-`));
}

describe('vendored copies match factories/runtime (sha256)', () => {
  it('master dir has the expected module set', () => {
    assert.deepEqual(MASTER_FILES, [
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
    ]);
  });

  for (const vendorDir of VENDOR_DIRS) {
    for (const name of MASTER_FILES) {
      it(`${vendorDir}/${name} is banner + master bytes`, () => {
        const vendored = fs.readFileSync(path.join(REPO_ROOT, vendorDir, name), 'utf8');
        assert.equal(sha256(vendored), sha256(expectedContent(name, REPO_ROOT)));
      });
    }

    it(`${vendorDir} has no stale .js files`, () => {
      const extras = fs
        .readdirSync(path.join(REPO_ROOT, vendorDir))
        .filter((f) => f.endsWith('.js') && !MASTER_FILES.includes(f));
      assert.deepEqual(extras, []);
    });
  }

  it('every vendored file carries the GENERATED banner', () => {
    for (const vendorDir of VENDOR_DIRS) {
      for (const name of MASTER_FILES) {
        const vendored = fs.readFileSync(path.join(REPO_ROOT, vendorDir, name), 'utf8');
        assert.ok(
          vendored.startsWith(banner(name)),
          `${vendorDir}/${name} must start with "${BANNER_PREFIX}${MASTER_DIR}/${name} …"`
        );
      }
    }
  });

  it('check(REPO_ROOT) reports parity', () => {
    assert.deepEqual(check(REPO_ROOT), []);
  });
});

describe('parity self-test — injected drift fails the check', () => {
  it('flags a hand-edited vendored file (module API and --check CLI agree)', () => {
    const root = makeTempRoot('drift');
    copyMasterInto(root);
    const { written, stale } = sync(root);
    assert.equal(written.length, MASTER_FILES.length * VENDOR_DIRS.length);
    assert.deepEqual(stale, []);
    assert.deepEqual(check(root), []);

    const drifted = path.join(root, VENDOR_DIRS[0], 'emit.js');
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
    copyMasterInto(root);
    sync(root);
    // Recreate the tree minus one file rather than deleting from it.
    const gapped = makeTempRoot('missing-gap');
    copyMasterInto(gapped);
    for (const vendorDir of VENDOR_DIRS) {
      fs.mkdirSync(path.join(gapped, vendorDir), { recursive: true });
      for (const name of MASTER_FILES) {
        if (vendorDir === VENDOR_DIRS[1] && name === 'tools.js') continue;
        fs.copyFileSync(path.join(root, vendorDir, name), path.join(gapped, vendorDir, name));
      }
    }
    const problems = check(gapped);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /tools\.js: missing/);
  });

  it('flags a stale vendored file with no master counterpart', () => {
    const root = makeTempRoot('stale');
    copyMasterInto(root);
    sync(root);
    fs.writeFileSync(path.join(root, VENDOR_DIRS[2], 'orphan.js'), '// leftover\n');
    const problems = check(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /orphan\.js: stale/);
  });

  it('--check exits 0 and sync is idempotent on a clean tree', () => {
    const root = makeTempRoot('clean');
    copyMasterInto(root);
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
  for (const vendorDir of VENDOR_DIRS) {
    it(`${vendorDir} requires cleanly with no factories/ in the tree`, () => {
      const root = makeTempRoot('standalone');
      const target = path.join(root, vendorDir);
      fs.mkdirSync(target, { recursive: true });
      for (const name of MASTER_FILES) {
        fs.copyFileSync(path.join(REPO_ROOT, vendorDir, name), path.join(target, name));
      }
      assert.equal(fs.existsSync(path.join(root, 'factories')), false);
      const script = MASTER_FILES.map(
        (name) => `require(${JSON.stringify(path.join(target, name))});`
      ).join('');
      const res = spawnSync(process.execPath, ['-e', script], {
        cwd: path.join(root, vendorDir.split('/').slice(0, 2).join(path.sep)),
        encoding: 'utf8',
      });
      assert.equal(res.status, 0, `require failed: ${res.stderr}`);
    });
  }
});
