// Integration tests for Heimdall scripts/heimdall-list.js shared store
// header + JSON entry.
//
// Discovered by plugins/work/scripts/run-tests.sh.
// Manual: node --test plugins/heimdall/lib/__tests__/list-shared.integration.test.js
//
// Covers GH-541 Task 6 scenarios (R7, AC9):
//   - Human output includes `# shared store —` when a shared store exists.
//   - `--json` output includes an entry with kind === 'shared'.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const listScript = path.resolve(__dirname, '..', '..', 'scripts', 'heimdall-list.js');
const initScript = path.resolve(__dirname, '..', '..', 'scripts', 'heimdall-init.js');
const protectScript = path.resolve(__dirname, '..', '..', 'scripts', 'heimdall-protect.js');

let originalHome;
let base;
let fakeHome;

before(() => {
  originalHome = os.homedir();
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-list-shared-it-'));
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

describe('heimdall-list.js shared store rendering', () => {
  it('human output contains "# shared store —" when a shared store exists', () => {
    const cwd = fs.mkdtempSync(path.join(base, 'proj-human-'));
    const init = run(initScript, ['--kind=shared', `--cwd=${cwd}`], cwd);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);

    const prot = run(
      protectScript,
      [
        '--kind=shared',
        '--phrase=edit shared target',
        '--paths=~/.claude/test-target',
        `--cwd=${cwd}`,
      ],
      cwd
    );
    assert.equal(prot.status, 0, `protect failed: ${prot.stderr}`);

    const res = run(listScript, [`--cwd=${cwd}`], cwd);
    assert.equal(res.status, 0, `list failed: ${res.stderr}`);
    assert.match(
      res.stdout,
      /# shared store —/,
      `stdout should contain "# shared store —"; got: ${res.stdout}`
    );
    // The shared header must include the lock count so users can see at a
    // glance whether a store is empty. Format: "# shared store — <dir> (N locks)".
    assert.match(
      res.stdout,
      /# shared store — \S.*\(1 lock(s)?\)/,
      `shared header should include lock count like "(1 lock)"; got: ${res.stdout}`
    );
  });

  it('--json output includes at least one entry with kind === "shared"', () => {
    const cwd = fs.mkdtempSync(path.join(base, 'proj-json-'));
    const init = run(initScript, ['--kind=shared', `--cwd=${cwd}`], cwd);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);

    const prot = run(
      protectScript,
      [
        '--kind=shared',
        '--phrase=edit shared target',
        '--paths=~/.claude/test-target',
        `--cwd=${cwd}`,
      ],
      cwd
    );
    assert.equal(prot.status, 0, `protect failed: ${prot.stderr}`);

    const res = run(listScript, ['--json', `--cwd=${cwd}`], cwd);
    assert.equal(res.status, 0, `list --json failed: ${res.stderr}`);

    let parsed;
    try {
      parsed = JSON.parse(res.stdout);
    } catch (err) {
      assert.fail(`--json output was not valid JSON: ${err.message}; stdout: ${res.stdout}`);
    }
    assert.ok(Array.isArray(parsed), '--json output should be an array');
    const sharedEntry = parsed.find((e) => e && e.kind === 'shared');
    assert.ok(
      sharedEntry,
      `--json output should include an entry with kind === "shared"; got: ${JSON.stringify(parsed)}`
    );
  });
});
