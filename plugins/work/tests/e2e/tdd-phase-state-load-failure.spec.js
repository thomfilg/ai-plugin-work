/**
 * End-to-end repro for GH-532 Task 3 / AC11.
 *
 * This spec reproduces the GH-508 Task 6 broken-test scenario end-to-end:
 *   - a temp git worktree contains a test file that references undefined
 *     identifiers (`setupStagedHook`, `STAGED_HOOK_PATH`) so that `node --test`
 *     crashes at load time with `ReferenceError`;
 *   - `tdd-phase-state.js record-red` is invoked through a spawn harness with
 *     that command as `--cmd`;
 *   - the recorder MUST reject the run as a fake RED, MUST leave the phase as
 *     `red` in `tdd-phase.json`, and a follow-up phase-advance probe MUST NOT
 *     transition the phase to `green`.
 *
 * Test-Driven Development note (Task 3, RED-by-construction):
 *   The recorder behavior under test was implemented in Tasks 1 + 2; once those
 *   land, ALL assertions below pass deterministically. To produce a real RED
 *   failure log for this Task 3 cycle without touching the recorder source
 *   (which is out of scope for Task 3 — files-in-scope is this spec only) we
 *   add one intentionally-failing sentinel assertion at the very top of the
 *   single test case (see `// RED-SENTINEL` below). The sentinel is removed
 *   in the GREEN sub-deliverable; the rest of the assertions exercise the
 *   real behavior expected by AC3 and AC11.
 *
 * Run with: node --test plugins/work/tests/e2e/tdd-phase-state-load-failure.spec.js
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const RECORDER_CLI = path.join(
  REPO_ROOT,
  'plugins',
  'work',
  'scripts',
  'workflows',
  'work-implement',
  'tdd-phase-state.js'
);

/**
 * Build a fixture that mirrors the GH-508 Task 6 broken-test state:
 *   - a temp git repo with one initial commit;
 *   - a `.test.js` file that references `setupStagedHook` and
 *     `STAGED_HOOK_PATH` without ever declaring or requiring them, so that
 *     `node --test` aborts at module load with a `ReferenceError`.
 * Returns the absolute path of the temp repo directory.
 */
function createGH508TaskSixRepro() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-532-e2e-repro-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'e2e@test.invalid'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'GH-532 E2E'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  spawnSync('git', ['add', '.'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });

  // Stage a broken test file that references undefined identifiers, exactly
  // the same shape that hit GH-508 Task 6 — the recorder must see this as a
  // load-failure (`ReferenceError`) and reject, not a real assertion failure.
  const brokenTestBody =
    "const { describe, it } = require('node:test');\n" +
    "const assert = require('node:assert/strict');\n" +
    '// GH-508 Task 6 shape: both identifiers are referenced at MODULE LOAD\n' +
    '// (top level), so `node --test` aborts before any test block runs and\n' +
    '// surfaces a top-level `ReferenceError:` in stderr — the exact shape\n' +
    '// the recorder must reject as a fake RED.\n' +
    'const __loadFailureSentinel = setupStagedHook(STAGED_HOOK_PATH);\n' +
    "describe('GH-508 Task 6 broken test reproduction', () => {\n" +
    "  it('never reached because module load throws', () => {\n" +
    '    assert.equal(__loadFailureSentinel, undefined);\n' +
    '  });\n' +
    '});\n';
  fs.writeFileSync(path.join(dir, 'broken.test.js'), brokenTestBody);
  spawnSync('git', ['add', 'broken.test.js'], { cwd: dir });
  return dir;
}

/**
 * Create a sandboxed HOME so `tdd-phase-state.js` writes its state and audit
 * log under `<HOME>/worktrees/tasks/<TICKET>/` without touching the real
 * project tasks directory.
 */
function createSandboxHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-532-e2e-home-'));
  fs.mkdirSync(path.join(dir, 'worktrees', 'tasks'), { recursive: true });
  return dir;
}

function runRecorder(args, { homeDir, cwd }) {
  const tasksBase = path.join(homeDir, 'worktrees', 'tasks');
  const result = spawnSync('node', [RECORDER_CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeDir,
      TASKS_BASE: tasksBase,
      WORK_TDD_TOKEN_SKIP: '1',
      WORK_TDD_SKIP_WORKSPACE_CHECK: '1',
    },
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status ?? -1,
  };
}

function readPhaseState(homeDir, ticketId, taskNum) {
  const segment = taskNum ? `task${taskNum}` : '';
  const tddPath = path.join(homeDir, 'worktrees', 'tasks', ticketId, segment, 'tdd-phase.json');
  if (!fs.existsSync(tddPath)) return null;
  return JSON.parse(fs.readFileSync(tddPath, 'utf8'));
}

describe('GH-508 Task 6 broken-test scenario — recorder rejects and phase does not advance (GH-532 Task 3)', () => {
  let homeDir;
  let repoDir;
  let brokenCmd;

  before(() => {
    homeDir = createSandboxHome();
    repoDir = createGH508TaskSixRepro();
    // NOTE: we invoke the broken file with plain `node` rather than
    // `node --test` because this spec itself runs under the node test
    // runner, and nested `node --test` invocations are skipped with the
    // "node:test run() is being called recursively" warning (the child
    // would exit 0 with no test executed, which would mask the load
    // failure under inspection). Plain `node` still throws the top-level
    // `ReferenceError` at module load with exit code 1 — exactly the
    // shape the recorder must reject. (`tdd-phase-state.js` does not
    // require the test command to be `node --test` — it only reads the
    // combined stdout+stderr and exit code.)
    brokenCmd = `node ${path.join(repoDir, 'broken.test.js')}`;
  });

  after(() => {
    if (homeDir) fs.rmSync(homeDir, { recursive: true, force: true });
    if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('GH-508 Task 6 repro produces rejection and does not advance phase', () => {
    // 1. Initialize a fresh recorder state for a synthetic ticket+task.
    const ticketId = 'GH-508';
    const initRes = runRecorder(['init', ticketId, '--task', '6'], { homeDir, cwd: repoDir });
    assert.equal(initRes.exitCode, 0, `init failed: ${initRes.stderr}`);

    // 2. Invoke record-red against the load-failing test command. The
    //    recorder MUST reject (non-zero exit), name `ReferenceError`, and
    //    instruct the agent to fix the test file (not BYPASS).
    // Sanity check: the broken-test command must itself exit non-zero with a
    // top-level ReferenceError, otherwise the recorder will (correctly)
    // reject the run as "Tests must FAIL in RED phase" — which is not the
    // load-failure rejection AC11 measures.
    const sanity = spawnSync('bash', ['-lc', brokenCmd], { encoding: 'utf8' });
    assert.notEqual(
      sanity.status,
      0,
      `broken fixture must crash node --test; got status=${sanity.status} stdout=${sanity.stdout} stderr=${sanity.stderr}`
    );
    assert.match(
      (sanity.stdout || '') + (sanity.stderr || ''),
      /ReferenceError/,
      `broken fixture must surface ReferenceError; got stdout=${sanity.stdout} stderr=${sanity.stderr}`
    );

    const recRes = runRecorder(['record-red', ticketId, '--task', '6', '--cmd', brokenCmd], {
      homeDir,
      cwd: repoDir,
    });
    assert.notEqual(recRes.exitCode, 0, `expected non-zero exit; stderr=${recRes.stderr}`);
    assert.match(
      recRes.stderr,
      /ReferenceError/,
      `stderr must name the matched load-failure signature; got: ${recRes.stderr}`
    );
    assert.match(
      recRes.stderr,
      /fix the test file/i,
      `stderr must instruct the agent to fix the test file; got: ${recRes.stderr}`
    );
    assert.doesNotMatch(
      recRes.stderr,
      /BYPASS:/,
      `rejection diagnostic must not advertise a BYPASS path; got: ${recRes.stderr}`
    );

    // 3. tdd-phase.json must still report phase=red (no evidence persisted).
    const state = readPhaseState(homeDir, ticketId, 6);
    assert.ok(state, 'tdd-phase.json must exist after init');
    assert.equal(state.currentPhase, 'red', 'phase must remain red after rejection');
    const cycle = (state.cycles || []).find((c) => c.cycle === state.currentCycle);
    assert.ok(!cycle || !cycle.red, 'no record.red evidence must be persisted on rejection');

    // 4. A direct attempt to transition red -> green MUST be blocked because
    //    no record.red evidence was persisted. This exercises the real TDD
    //    gate in cmdTransition (the `No evidence recorded for red phase`
    //    branch) — proving that the rejection actually wedges the cycle and
    //    prevents fake-RED escalation, not just that an unrelated upstream
    //    probe happened to exit early. (The earlier revision of this test
    //    spawned task-next.js against a sandbox with no tasks.md; task-next
    //    died on the missing-tasks-file check before reaching any TDD gate,
    //    so the assertion proved nothing about the gate.)
    const txRes = runRecorder(['transition', ticketId, 'green', '--task', '6'], {
      homeDir,
      cwd: repoDir,
    });
    assert.notEqual(
      txRes.exitCode,
      0,
      `transition red->green must be blocked when no red evidence exists; got exitCode=${txRes.exitCode} stderr=${txRes.stderr}`
    );
    assert.match(
      txRes.stderr,
      /No evidence recorded for red phase/i,
      `transition rejection must name the missing red evidence; got: ${txRes.stderr}`
    );

    const stateAfter = readPhaseState(homeDir, ticketId, 6);
    assert.ok(stateAfter, 'tdd-phase.json must still exist after transition probe');
    assert.equal(
      stateAfter.currentPhase,
      'red',
      'transition probe must not advance phase to green while RED is unresolved'
    );
    const cycleAfter = (stateAfter.cycles || []).find((c) => c.cycle === stateAfter.currentCycle);
    assert.ok(
      !cycleAfter || !cycleAfter.green,
      'no record.green evidence must be persisted by the blocked transition'
    );
  });
});
