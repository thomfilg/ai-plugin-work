// Integration tests for `scan({ cwd, kind: 'shared' })` anchor filtering.
//
// Discovered by plugins/work/scripts/run-tests.sh.
// Manual: node --test plugins/heimdall/lib/__tests__/scan.integration.test.js
//
// Covers GH-541 Task 4 / AC3 / R5:
//   - scan filters home-anchored catalog entries INTO `shared`
//   - scan filters repo-anchored catalog entries OUT OF `shared`
//   - regression: `global` still surfaces home-anchored entries

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scan } = require(path.resolve(__dirname, '..', 'scan'));

let originalHome;
let base;
let fakeHome;
let repo;

before(() => {
  originalHome = os.homedir();
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-scan-shared-it-'));
  fakeHome = path.join(base, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  // os.homedir() on POSIX reads HOME via env; reassign to redirect ~ lookups.
  process.env.HOME = fakeHome;

  // Seed home-anchored target (~/.claude) so the catalog "claude-config"
  // home target resolves to an existing path.
  fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });

  // Seed repo with repo-anchored targets that EXIST so the only thing
  // filtering them out is the anchor/kind predicate (not the existsSync check).
  repo = fs.mkdtempSync(path.join(base, 'repo-'));
  fs.mkdirSync(path.join(repo, '.claude'));
  fs.mkdirSync(path.join(repo, '.github'));
  fs.writeFileSync(path.join(repo, 'package.json'), '{}\n');
});

after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(base, { recursive: true, force: true });
});

describe("scan kind='shared'", () => {
  it('scan filters home-anchored catalog entries into shared', () => {
    const suggestions = scan({ cwd: repo, kind: 'shared' });
    const cc = suggestions.find((s) => s.id === 'claude-config');
    assert.ok(cc, "expected 'claude-config' in shared scan suggestions");
    assert.ok(
      cc.protect.includes('~/.claude'),
      `expected '~/.claude' in cc.protect, got ${JSON.stringify(cc.protect)}`,
    );
  });

  it('excludes repo-anchored catalog entries from shared scan', () => {
    const ids = scan({ cwd: repo, kind: 'shared' }).map((s) => s.id);
    assert.ok(
      !ids.includes('root-package-json'),
      `repo-anchored 'root-package-json' must NOT be suggested for shared, got ${JSON.stringify(ids)}`,
    );
    assert.ok(
      !ids.includes('github-dir'),
      `repo-anchored 'github-dir' must NOT be suggested for shared, got ${JSON.stringify(ids)}`,
    );
  });

  it("does not include the repo-anchored '.claude' path in the shared claude-config suggestion", () => {
    const cc = scan({ cwd: repo, kind: 'shared' }).find((s) => s.id === 'claude-config');
    assert.ok(cc);
    assert.ok(
      !cc.protect.includes('.claude'),
      `repo-anchored '.claude' must NOT appear in shared protect list, got ${JSON.stringify(cc.protect)}`,
    );
  });
});

describe("scan kind='global' regression", () => {
  it('still surfaces home-anchored targets for global', () => {
    const cc = scan({ cwd: repo, kind: 'global' }).find((s) => s.id === 'claude-config');
    assert.ok(cc, "expected 'claude-config' in global scan suggestions");
    assert.ok(
      cc.protect.includes('~/.claude'),
      `expected '~/.claude' in global cc.protect, got ${JSON.stringify(cc.protect)}`,
    );
  });

  it('still surfaces repo-anchored targets for local', () => {
    const ids = scan({ cwd: repo, kind: 'local' }).map((s) => s.id);
    assert.ok(
      ids.includes('root-package-json'),
      `expected 'root-package-json' in local scan, got ${JSON.stringify(ids)}`,
    );
  });
});
