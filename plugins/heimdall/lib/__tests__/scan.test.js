// Tests for the install-time scan: catalog → existing-path suggestions.
//
// Discovered by plugins/work/scripts/run-tests.sh (searches plugins/heimdall/).
// Manual: node --test plugins/heimdall/lib/__tests__/scan.test.js
//
// In-process (require the lib, no subprocess/git spawns) so the test adds no
// parallel-process load to the full suite.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scan } = require(path.resolve(__dirname, '..', 'scan'));
const { writeConfig, FOLDER } = require(path.resolve(__dirname, '..', 'lock-store'));

let repo;

// No git init needed: getRepoRoot() falls back to cwd when cwd is not a git
// repo, which is exactly what we want here. Under os.tmpdir() so the worktree
// ancestor-walk can't discover an ambient real store.
const scanIds = (kind) =>
  scan({ cwd: repo, kind })
    .map((s) => s.id)
    .sort();

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-scan-it-'));
  fs.mkdirSync(path.join(repo, '.claude'));
  fs.mkdirSync(path.join(repo, '.github'));
  fs.writeFileSync(path.join(repo, 'package.json'), '{}\n');
  // NOTE: packages/ui intentionally absent.
});

after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('scan', () => {
  it('suggests only existing repo paths for a local install', () => {
    assert.deepEqual(scanIds('local'), ['claude-config', 'github-dir', 'root-package-json']);
  });

  it('does not suggest packages/ui because it does not exist', () => {
    assert.ok(!scan({ cwd: repo, kind: 'local' }).some((s) => s.id === 'packages-ui'));
  });

  it('never suggests the home-anchored ~/.claude for a local install', () => {
    const cc = scan({ cwd: repo, kind: 'local' }).find((s) => s.id === 'claude-config');
    assert.deepEqual(cc.protect, ['.claude'], 'only the repo .claude, not ~/.claude');
  });

  it('carries allowedPaths/trustedSubdirs on the claude-config suggestion', () => {
    const cc = scan({ cwd: repo, kind: 'local' }).find((s) => s.id === 'claude-config');
    assert.ok(cc.allowedPaths.includes('plans'));
    assert.ok(cc.trustedSubdirs.includes('hooks'));
  });

  it('drops suggestions already covered by an existing lock', () => {
    writeConfig(path.join(repo, '.claude', FOLDER), {
      kind: 'local',
      locks: [{ protect: ['.github'], unlockPhrase: 'edit .github' }],
    });
    assert.ok(!scanIds('local').includes('github-dir'), '.github now protected → not re-suggested');
  });
});
