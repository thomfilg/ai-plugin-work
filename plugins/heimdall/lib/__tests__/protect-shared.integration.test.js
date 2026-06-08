// Integration tests for Heimdall scripts/heimdall-protect.js --kind=shared
// repo-relative path rejection.
//
// Discovered by plugins/work/scripts/run-tests.sh.
// Manual: node --test plugins/heimdall/lib/__tests__/protect-shared.integration.test.js
//
// Covers GH-541 Task 5 scenarios (R12, AC6):
//   - --kind=shared --paths=<repo-relative> exits non-zero; stderr suggests
//     the three alternative kinds: local, worktree, global.
//   - --kind=shared --paths=~/.claude/<something> succeeds (no false reject).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const protectScript = path.resolve(__dirname, '..', '..', 'scripts', 'heimdall-protect.js');
const initScript = path.resolve(__dirname, '..', '..', 'scripts', 'heimdall-init.js');

let originalHome;
let base;
let fakeHome;

before(() => {
  originalHome = os.homedir();
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-protect-shared-it-'));
  fakeHome = path.join(base, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;
});

after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(base, { recursive: true, force: true });
});

function run(script, args, cwd) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: { ...process.env, HOME: fakeHome },
    encoding: 'utf8',
  });
}

describe('heimdall-protect.js --kind=shared rejects repo-relative paths', () => {
  it('exits non-zero and stderr suggests local/worktree/global', () => {
    const cwd = fs.mkdtempSync(path.join(base, 'proj-reject-'));
    // Ensure shared store exists so we don't fail for an unrelated reason.
    const init = run(initScript, ['--kind=shared', `--cwd=${cwd}`], cwd);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);

    const res = run(
      protectScript,
      ['--kind=shared', '--phrase=edit pkg', '--paths=package.json', `--cwd=${cwd}`],
      cwd
    );
    assert.notEqual(
      res.status,
      0,
      `expected non-zero exit, got ${res.status}; stderr: ${res.stderr}`
    );
    assert.match(res.stderr, /local/, `stderr should mention "local": ${res.stderr}`);
    assert.match(res.stderr, /worktree/, `stderr should mention "worktree": ${res.stderr}`);
    assert.match(res.stderr, /global/, `stderr should mention "global": ${res.stderr}`);
  });
});

describe('heimdall-protect.js --kind=shared accepts home-anchored paths', () => {
  it('succeeds with --paths=~/.claude/<something>', () => {
    const cwd = fs.mkdtempSync(path.join(base, 'proj-accept-'));
    const init = run(initScript, ['--kind=shared', `--cwd=${cwd}`], cwd);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);

    const res = run(
      protectScript,
      [
        '--kind=shared',
        '--phrase=edit shared target',
        '--paths=~/.claude/test-target',
        `--cwd=${cwd}`,
      ],
      cwd
    );
    assert.equal(
      res.status,
      0,
      `expected success exit; stderr: ${res.stderr}; stdout: ${res.stdout}`
    );
  });

  it('succeeds with --paths=$HOME/.claude/<something>', () => {
    const cwd = fs.mkdtempSync(path.join(base, 'proj-accept-dollar-'));
    const init = run(initScript, ['--kind=shared', `--cwd=${cwd}`], cwd);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);

    const res = run(
      protectScript,
      [
        '--kind=shared',
        '--phrase=edit shared dollar',
        '--paths=$HOME/.claude/test-dollar',
        `--cwd=${cwd}`,
      ],
      cwd
    );
    assert.equal(
      res.status,
      0,
      `expected success exit; stderr: ${res.stderr}; stdout: ${res.stdout}`
    );
  });

  it('succeeds with --paths=${HOME}/.claude/<something>', () => {
    const cwd = fs.mkdtempSync(path.join(base, 'proj-accept-braces-'));
    const init = run(initScript, ['--kind=shared', `--cwd=${cwd}`], cwd);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);

    const res = run(
      protectScript,
      [
        '--kind=shared',
        '--phrase=edit shared braces',
        '--paths=${HOME}/.claude/test-braces',
        `--cwd=${cwd}`,
      ],
      cwd
    );
    assert.equal(
      res.status,
      0,
      `expected success exit; stderr: ${res.stderr}; stdout: ${res.stdout}`
    );
  });

  it('succeeds with --paths=<absolute homedir path>', () => {
    const cwd = fs.mkdtempSync(path.join(base, 'proj-accept-abs-'));
    const init = run(initScript, ['--kind=shared', `--cwd=${cwd}`], cwd);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);

    const absHomePath = path.join(fakeHome, '.claude', 'test-abs');
    const res = run(
      protectScript,
      ['--kind=shared', '--phrase=edit shared abs', `--paths=${absHomePath}`, `--cwd=${cwd}`],
      cwd
    );
    assert.equal(
      res.status,
      0,
      `expected success exit; stderr: ${res.stderr}; stdout: ${res.stdout}`
    );
  });
});

// Cursor bot PR #545 (comment 3354852147): the home-anchored guard must also
// fire when --kind is OMITTED and the resolved store happens to be shared
// (e.g. shared is the only active store). Without the fix, `dirs[0]` returns
// the shared store via precedence/discovery and repo-relative paths like
// `package.json` would be written into the cross-project marker.
describe('heimdall-protect.js --kind=shared rejects `..` traversal and bare relative paths', () => {
  // Regression: a `path.resolve(p)` happy-path acceptance check would let
  // `--paths=.claude` from a cwd under HOME silently succeed (cwd lives under
  // home → resolves under home), and `$HOME/../etc` would slip past the
  // prefix regex. Both must reject.
  it('rejects --paths=.github (bare relative path)', () => {
    const cwd = fs.mkdtempSync(path.join(fakeHome, 'proj-bare-relative-'));
    const init = run(initScript, ['--kind=shared', `--cwd=${cwd}`], cwd);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);

    const res = run(
      protectScript,
      ['--kind=shared', '--phrase=edit gh', '--paths=.github', `--cwd=${cwd}`],
      cwd
    );
    assert.notEqual(res.status, 0, `expected non-zero exit; stderr: ${res.stderr}`);
    assert.match(res.stderr, /home-anchored/);
  });

  it('rejects --paths=$HOME/../etc (traversal escapes home)', () => {
    const cwd = fs.mkdtempSync(path.join(base, 'proj-traversal-'));
    const init = run(initScript, ['--kind=shared', `--cwd=${cwd}`], cwd);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);

    const res = run(
      protectScript,
      ['--kind=shared', '--phrase=edit esc', '--paths=$HOME/../etc', `--cwd=${cwd}`],
      cwd
    );
    assert.notEqual(res.status, 0, `expected non-zero exit; stderr: ${res.stderr}`);
    assert.match(res.stderr, /home-anchored/);
  });

  it('rejects --paths=~/foo/../../etc (traversal under tilde prefix)', () => {
    const cwd = fs.mkdtempSync(path.join(base, 'proj-traversal-tilde-'));
    const init = run(initScript, ['--kind=shared', `--cwd=${cwd}`], cwd);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);

    const res = run(
      protectScript,
      ['--kind=shared', '--phrase=edit tilde-esc', '--paths=~/foo/../../etc', `--cwd=${cwd}`],
      cwd
    );
    assert.notEqual(res.status, 0, `expected non-zero exit; stderr: ${res.stderr}`);
    assert.match(res.stderr, /home-anchored/);
  });
});

describe('heimdall-protect.js without --kind rejects repo-relative when resolved store is shared', () => {
  it('rejects --paths=package.json when only shared store is active', () => {
    const cwd = fs.mkdtempSync(path.join(base, 'proj-implicit-shared-'));
    // Initialize ONLY the shared store — no local/worktree/global markers.
    const init = run(initScript, ['--kind=shared', `--cwd=${cwd}`], cwd);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);

    // Invoke protect WITHOUT --kind=shared; discoverStores will return the
    // shared store as the only active one, so dirs[0] is the shared dir.
    const res = run(
      protectScript,
      ['--phrase=edit pkg implicit', '--paths=package.json', `--cwd=${cwd}`],
      cwd
    );
    assert.notEqual(
      res.status,
      0,
      `expected non-zero exit (resolved store is shared), got ${res.status}; stderr: ${res.stderr}; stdout: ${res.stdout}`
    );
    assert.match(
      res.stderr,
      /home-anchored/,
      `stderr should mention "home-anchored": ${res.stderr}`
    );
    assert.match(res.stderr, /local/, `stderr should mention "local": ${res.stderr}`);
    assert.match(res.stderr, /worktree/, `stderr should mention "worktree": ${res.stderr}`);
    assert.match(res.stderr, /global/, `stderr should mention "global": ${res.stderr}`);
  });
});
