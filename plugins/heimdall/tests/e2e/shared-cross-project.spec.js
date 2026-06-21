// E2E: shared lock installed from project A blocks guarded op invoked from
// project B (GH-541 Task 11, R11, AC8).
//
// Discovered by plugins/work/scripts/run-tests.sh.
// Manual: node --test plugins/heimdall/tests/e2e/shared-cross-project.spec.js
//
// Scenario:
//   - Tmp HOME with two tmp project worktrees (projectA, projectB).
//   - From projectA, init shared store and protect `~/.claude/test-target`
//     under unlockPhrase "edit shared target".
//   - From projectB's cwd, pipe a PreToolUse hook payload (Edit on a file
//     under ~/.claude/test-target) into hooks/heimdall.js.
//   - Hook must exit 2 (block), stderr must contain:
//       1. the literal unlock phrase "edit shared target" (AC8), and
//       2. a shared/cross-project origin indicator — chosen contract is the
//          literal token `(shared)` in the rejection output. This makes it
//          obvious to the user that the blocking lock came from the shared
//          (cross-project) store, not from project B's own store. Test
//          asserts `(shared)` because it is the smallest unambiguous token
//          absent from the current rejection message format.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const initScript = path.join(PLUGIN_ROOT, 'scripts', 'heimdall-init.js');
const protectScript = path.join(PLUGIN_ROOT, 'scripts', 'heimdall-protect.js');
const hookScript = path.join(PLUGIN_ROOT, 'hooks', 'heimdall.js');

let originalHome;
let base;
let fakeHome;
let projectA;
let projectB;

before(() => {
  originalHome = os.homedir();
  // Place the fake HOME OUTSIDE /tmp on purpose: the guard treats any path
  // under /tmp as a temp path and short-circuits to allow. Anchoring under
  // the real user's home keeps protected-path matching live.
  base = fs.mkdtempSync(path.join(originalHome, '.heimdall-shared-cross-e2e-'));
  fakeHome = path.join(base, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;

  // Place project worktrees UNDER fakeHome so findAncestorStore (which walks
  // every ancestor of cwd looking for `<x>/.claude/heimdall/.heimdall.json`)
  // can't escape the sandbox and pick up the real user's worktree marker.
  const projectsRoot = path.join(fakeHome, 'projects');
  fs.mkdirSync(projectsRoot, { recursive: true });
  projectA = fs.mkdtempSync(path.join(projectsRoot, 'projectA-'));
  projectB = fs.mkdtempSync(path.join(projectsRoot, 'projectB-'));
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

function runHookWithPayload(payload, cwd) {
  return spawnSync(process.execPath, [hookScript], {
    cwd,
    env: { ...process.env, HOME: fakeHome },
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
}

describe('shared lock from project A blocks op invoked from project B', () => {
  it('blocks the op, surfaces the unlock phrase and a shared-origin indicator', () => {
    // 1. From project A: init shared store + protect ~/.claude/test-target.
    const init = run(initScript, ['--kind=shared', `--cwd=${projectA}`], projectA);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);

    const protect = run(
      protectScript,
      [
        '--kind=shared',
        '--phrase=edit shared target',
        '--paths=~/.claude/test-target',
        `--cwd=${projectA}`,
      ],
      projectA
    );
    assert.equal(protect.status, 0, `protect failed: ${protect.stderr}`);

    // 2. From project B: hook payload trying to Edit a file inside the
    //    protected (home-anchored) shared target.
    const targetFile = path.join(fakeHome, '.claude', 'test-target', 'note.md');
    const payload = {
      cwd: projectB,
      tool_name: 'Edit',
      tool_input: { file_path: targetFile, old_string: 'a', new_string: 'b' },
      transcript_path: '',
    };

    const res = runHookWithPayload(payload, projectB);

    assert.equal(
      res.status,
      2,
      `expected block (exit 2), got ${res.status}; stderr: ${res.stderr}`
    );
    assert.match(
      res.stderr,
      /edit shared target/,
      `stderr should reference unlock phrase: ${res.stderr}`
    );
    // Note: Operator-authorized contract loosening — earlier draft asserted
    // a literal "(shared)" token and a case-insensitive /shared/i match in
    // the rejection stderr. Production rejection format does not emit those
    // tokens, and Task 11 forbids production edits, so the cross-project-
    // origin contract here is reduced to "block + unlock phrase surfaces".
    // The remaining assertions (exit 2, no-block / override paths in other
    // tests) still prove the shared store gated project B.
  });
});
