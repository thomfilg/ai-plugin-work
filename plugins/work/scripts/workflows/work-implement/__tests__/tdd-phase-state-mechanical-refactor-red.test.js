'use strict';

/**
 * tdd-phase-state.js record-red — mechanical-refactor + bare-CLI fixes
 * (GH-528 round-2 follow-up, Cursor[bot] comments).
 *
 * Bug 1 (mechanical-refactor RED wedge):
 *   gateContractFor('mechanical-refactor') returns redRequiresTestFiles=false,
 *   so task-next.js takes the RED fallback when no test files are in scope.
 *   But docsExemptForward is driven by rcdEmptyTrap===false (NOT by
 *   redRequiresTestFiles) — so for mechanical-refactor (rcdEmptyTrap=true)
 *   the recorder gets docsExempt=false and rejects the call with "No test
 *   files changed". Verifier-only mechanical-refactor tasks wedge.
 *
 *   Fix: add a separate `--red-skip-file-guard` flag that relaxes ONLY the
 *   RED "no test files changed" guard, independent of `--docs-exempt`
 *   (which still controls the RC-D empty-output trap at GREEN/REFACTOR).
 *
 * Bug 2 (bare CLI exits zero silently):
 *   `node tdd-phase-state.js` with no subcommand currently calls
 *   process.exit(0) when argv.length < 3 — to support `node --test`
 *   loading the file. Operators / wrappers misread a no-arg invocation as
 *   success.
 *
 *   Fix: distinguish "loaded by node --test" (require.main !== module)
 *   from "directly invoked with no args" (require.main === module &&
 *   argv.length < 3). Only the former is silent; the latter errors.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'tdd-phase-state.js');
const TICKET = 'TEST-528-MR';

function makeTasksBase(type = 'mechanical-refactor') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-mr-'));
  fs.mkdirSync(path.join(dir, TICKET, 'task1'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, TICKET, '.work' + '-state.json'),
    JSON.stringify({ ticketId: TICKET })
  );
  // GH-528 round-2 follow-up: the recorder now reads the active task's
  // Type from tasks.md to gate `--red-skip-file-guard` and `record-skip-red`.
  // Write a minimal tasks.md with the requested Type.
  const tasksMd = [
    '## Task 1 — sample',
    '',
    '### Type',
    type,
    '',
    '### Files in scope',
    '- src/**',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, TICKET, 'tasks.md'), tasksMd);
  return dir;
}

function runCli(args, tasksBase, extraEnv = {}) {
  // Run from a non-git cwd so `git diff` inside record-red returns no
  // changed files — otherwise the project's own dirty tree leaks in and
  // the testFiles guard never triggers.
  return spawnSync('node', [CLI, ...args], {
    cwd: tasksBase,
    encoding: 'utf8',
    env: {
      ...process.env,
      TASKS_BASE: tasksBase,
      WORK_TDD_TOKEN_SKIP: '1',
      WORK_TDD_SKIP_WORKSPACE_CHECK: '1',
      ...extraEnv,
    },
  });
}

// ── Bug 1: mechanical-refactor RED wedge ────────────────────────────────────

describe('tdd-phase-state record-red — mechanical-refactor / verifier-only', () => {
  let tasksBase;
  beforeEach(() => {
    tasksBase = makeTasksBase();
    const init = runCli(['init', TICKET, '--task', '1'], tasksBase);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);
  });
  afterEach(() => {
    if (tasksBase) fs.rmSync(tasksBase, { recursive: true, force: true });
  });

  it('record-red without --docs-exempt and without test-file changes is REJECTED (current contract)', () => {
    // Sanity: confirm the wedge condition exists today — no test files
    // changed + no relaxation flag → errorExit.
    const r = runCli(
      ['record-red', TICKET, '--task', '1', '--cmd', 'node -e "process.exit(1)"'],
      tasksBase
    );
    assert.notEqual(r.status, 0, `expected non-zero exit; stderr=${r.stderr}`);
    assert.match(r.stderr, /No test files changed/);
  });

  it('record-red --red-skip-file-guard accepts RED when test command fails but no test files changed', () => {
    // The new flag relaxes the "No test files changed" guard for Types
    // whose contract sets redRequiresTestFiles=false (mechanical-refactor,
    // tests-only fallback, etc.). The test command must still FAIL.
    const r = runCli(
      [
        'record-red',
        TICKET,
        '--task',
        '1',
        '--cmd',
        'node -e "process.exit(1)"',
        '--red-skip-file-guard',
      ],
      tasksBase
    );
    assert.equal(r.status, 0, `expected accept; stderr=${r.stderr} stdout=${r.stdout}`);
  });

  it('record-red --red-skip-file-guard still requires the test command to FAIL', () => {
    // Critical contract: the flag relaxes the file-guard, NOT the
    // exit-code guard. RED still means "verifier fails before the
    // refactor / fix".
    const r = runCli(
      [
        'record-red',
        TICKET,
        '--task',
        '1',
        '--cmd',
        'node -e "process.exit(0)"',
        '--red-skip-file-guard',
      ],
      tasksBase
    );
    assert.notEqual(r.status, 0, `expected reject when cmd passes; stderr=${r.stderr}`);
    assert.match(r.stderr, /Tests must FAIL/);
  });
});

// ── Bug 3: record-skip-red must require Type=tests-only (Cursor[bot] HIGH) ──

describe('tdd-phase-state record-skip-red — Type gate', () => {
  let tasksBase;
  afterEach(() => {
    if (tasksBase) {
      fs.rmSync(tasksBase, { recursive: true, force: true });
      tasksBase = null;
    }
  });

  it('record-skip-red is REJECTED for Type=tdd-code (closes self-report surface)', () => {
    tasksBase = makeTasksBase('tdd-code');
    const init = runCli(['init', TICKET, '--task', '1'], tasksBase);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);
    const r = runCli(
      ['record-skip-red', TICKET, '--task', '1', '--reason', 'agent claims tests-only'],
      tasksBase
    );
    assert.notEqual(
      r.status,
      0,
      `record-skip-red must reject non-tests-only Types; stderr=${r.stderr}`
    );
    assert.match(r.stderr, /tests-only|Type/);
  });

  it('record-skip-red is REJECTED for Type=mechanical-refactor', () => {
    tasksBase = makeTasksBase('mechanical-refactor');
    const init = runCli(['init', TICKET, '--task', '1'], tasksBase);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);
    const r = runCli(
      ['record-skip-red', TICKET, '--task', '1', '--reason', 'bypass attempt'],
      tasksBase
    );
    assert.notEqual(r.status, 0, `stderr=${r.stderr}`);
  });

  it('record-skip-red is ACCEPTED for Type=tests-only (contract still works)', () => {
    tasksBase = makeTasksBase('tests-only');
    const init = runCli(['init', TICKET, '--task', '1'], tasksBase);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);
    const r = runCli(
      ['record-skip-red', TICKET, '--task', '1', '--reason', 'tests-only task'],
      tasksBase
    );
    assert.equal(r.status, 0, `expected accept; stderr=${r.stderr}`);
  });
});

// ── Bug 4: --red-skip-file-guard must require contract-allowed Type (Cursor[bot] HIGH) ──

describe('tdd-phase-state record-red --red-skip-file-guard — Type gate', () => {
  let tasksBase;
  afterEach(() => {
    if (tasksBase) {
      fs.rmSync(tasksBase, { recursive: true, force: true });
      tasksBase = null;
    }
  });

  it('--red-skip-file-guard is IGNORED for Type=tdd-code (file guard re-fires)', () => {
    // For tdd-code, gateContractFor.redRequiresTestFiles === true. A direct
    // CLI call with --red-skip-file-guard from an allow-listed agent must
    // NOT relax the guard — agent self-report on the file guard is the exact
    // shape no-fake-tdd-evidence guards against.
    tasksBase = makeTasksBase('tdd-code');
    const init = runCli(['init', TICKET, '--task', '1'], tasksBase);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);
    const r = runCli(
      [
        'record-red',
        TICKET,
        '--task',
        '1',
        '--cmd',
        'node -e "process.exit(1)"',
        '--red-skip-file-guard',
      ],
      tasksBase
    );
    assert.notEqual(
      r.status,
      0,
      `--red-skip-file-guard must be ignored for tdd-code; stderr=${r.stderr}`
    );
    assert.match(r.stderr, /No test files changed|tests-only|Type/);
  });

  it('--red-skip-file-guard is HONORED for Type=mechanical-refactor', () => {
    // mechanical-refactor.redRequiresTestFiles === false → flag is valid.
    tasksBase = makeTasksBase('mechanical-refactor');
    const init = runCli(['init', TICKET, '--task', '1'], tasksBase);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);
    const r = runCli(
      [
        'record-red',
        TICKET,
        '--task',
        '1',
        '--cmd',
        'node -e "process.exit(1)"',
        '--red-skip-file-guard',
      ],
      tasksBase
    );
    assert.equal(r.status, 0, `expected accept; stderr=${r.stderr}`);
  });
});

// ── Bug 5: --docs-exempt must require contract+scope (Cursor[bot] HIGH/Medium) ──
//
// Same shape as --red-skip-file-guard and record-skip-red: the recorder
// honors `--docs-exempt` from argv alone across all three record phases
// (record-red, record-green, record-refactor) without consulting the active
// task's Type. A tokened agent can pass --docs-exempt on a tdd-code task to
// skip the RED file guard or the GREEN/REFACTOR RC-D empty-output trap.
//
// Gate the flag on `gateContractFor(type).rcdEmptyTrap === false` (matches
// the orchestrator's `contractAllowsDocsExempt` discriminator). Visual-only
// Storybook scope is an orthogonal allow path covered by reading the task's
// Files in scope from tasks.md.

function makeTasksBaseWithScope(type, scope) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-de-'));
  fs.mkdirSync(path.join(dir, TICKET, 'task1'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, TICKET, '.work' + '-state.json'),
    JSON.stringify({ ticketId: TICKET })
  );
  const lines = [
    '## Task 1 — sample',
    '',
    '### Type',
    type,
    '',
    '### Files in scope',
    ...scope.map((s) => `- ${s}`),
    '',
  ];
  fs.writeFileSync(path.join(dir, TICKET, 'tasks.md'), lines.join('\n'));
  return dir;
}

describe('tdd-phase-state record-red --docs-exempt — Type gate', () => {
  let tasksBase;
  afterEach(() => {
    if (tasksBase) {
      fs.rmSync(tasksBase, { recursive: true, force: true });
      tasksBase = null;
    }
  });

  it('--docs-exempt is REJECTED at record-red for Type=tdd-code', () => {
    tasksBase = makeTasksBaseWithScope('tdd-code', ['src/**']);
    const init = runCli(['init', TICKET, '--task', '1'], tasksBase);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);
    const r = runCli(
      ['record-red', TICKET, '--task', '1', '--cmd', 'node -e "process.exit(1)"', '--docs-exempt'],
      tasksBase
    );
    assert.notEqual(r.status, 0, `--docs-exempt must be rejected for tdd-code; stderr=${r.stderr}`);
    assert.match(r.stderr, /docs-exempt|tdd-code|Type/);
  });

  it('--docs-exempt is HONORED at record-red for Type=docs', () => {
    tasksBase = makeTasksBaseWithScope('docs', ['README.md']);
    const init = runCli(['init', TICKET, '--task', '1'], tasksBase);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);
    const r = runCli(
      ['record-red', TICKET, '--task', '1', '--cmd', 'node -e "process.exit(1)"', '--docs-exempt'],
      tasksBase
    );
    assert.equal(r.status, 0, `expected accept; stderr=${r.stderr}`);
  });

  it('--docs-exempt is HONORED for visual-only Storybook scope (any Type)', () => {
    // Visual-only Storybook tasks have all scope entries matching
    // *.stories.[jt]sx? — orchestrator forwards --docs-exempt regardless
    // of Type. Recorder must honor the same allow-path.
    tasksBase = makeTasksBaseWithScope('tdd-code', [
      'src/Button.stories.tsx',
      'src/Card.stories.tsx',
    ]);
    const init = runCli(['init', TICKET, '--task', '1'], tasksBase);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);
    const r = runCli(
      ['record-red', TICKET, '--task', '1', '--cmd', 'node -e "process.exit(1)"', '--docs-exempt'],
      tasksBase
    );
    assert.equal(r.status, 0, `visual-only scope must allow --docs-exempt; stderr=${r.stderr}`);
  });
});

describe('tdd-phase-state record-green --docs-exempt — Type gate', () => {
  let tasksBase;
  afterEach(() => {
    if (tasksBase) {
      fs.rmSync(tasksBase, { recursive: true, force: true });
      tasksBase = null;
    }
  });

  it('--docs-exempt is REJECTED at record-green for Type=tdd-code', () => {
    tasksBase = makeTasksBaseWithScope('tdd-code', ['src/**']);
    const init = runCli(['init', TICKET, '--task', '1'], tasksBase);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);
    // Advance to green via record-red with redSkipFileGuard for setup
    // would require mechanical-refactor — instead, transition directly.
    const transition = runCli(['transition', TICKET, 'green', '--task', '1'], tasksBase);
    // Transition may fail in test fixture; what we care about is the
    // docs-exempt rejection at record-green. Force currentPhase via direct
    // file edit if transition refused — keep test focused on the gate.
    if (transition.status !== 0) {
      const statePath = path.join(tasksBase, TICKET, 'task1', 'tdd-phase.json');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      state.currentPhase = 'green';
      fs.writeFileSync(statePath, JSON.stringify(state));
    }
    const r = runCli(
      [
        'record-green',
        TICKET,
        '--task',
        '1',
        '--cmd',
        'node -e "console.log(\'ok\')"',
        '--docs-exempt',
      ],
      tasksBase
    );
    assert.notEqual(r.status, 0, `--docs-exempt must be rejected for tdd-code; stderr=${r.stderr}`);
    assert.match(r.stderr, /docs-exempt|tdd-code|Type/);
  });
});

describe('tdd-phase-state --docs-exempt — no-task bypass closed (Cursor[bot] HIGH)', () => {
  // Earlier draft of ITEM 8 fell through for no-task callers — that left
  // the gate exploitable by omitting --task. The legacy compat shim is
  // removed; missing --task fails closed.
  let tasksBase;
  afterEach(() => {
    if (tasksBase) {
      fs.rmSync(tasksBase, { recursive: true, force: true });
      tasksBase = null;
    }
  });

  it('--docs-exempt without --task is REJECTED (no legacy bypass)', () => {
    tasksBase = makeTasksBaseWithScope('tdd-code', ['src/**']);
    // Init at ticket root (no --task) so the legacy ticket-root state path
    // exists and currentPhase is RED.
    const init = runCli(['init', TICKET], tasksBase);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);
    const r = runCli(
      ['record-red', TICKET, '--cmd', 'node -e "process.exit(1)"', '--docs-exempt'],
      tasksBase
    );
    assert.notEqual(
      r.status,
      0,
      `--docs-exempt without --task must be rejected; stderr=${r.stderr}`
    );
    assert.match(r.stderr, /--task|docs-exempt/);
  });
});

describe('tdd-phase-state record-refactor --docs-exempt — Type gate', () => {
  let tasksBase;
  afterEach(() => {
    if (tasksBase) {
      fs.rmSync(tasksBase, { recursive: true, force: true });
      tasksBase = null;
    }
  });

  it('--docs-exempt is REJECTED at record-refactor for Type=tdd-code', () => {
    tasksBase = makeTasksBaseWithScope('tdd-code', ['src/**']);
    const init = runCli(['init', TICKET, '--task', '1'], tasksBase);
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);
    // Force currentPhase to refactor — focus the test on the gate, not
    // the full RED→GREEN→REFACTOR ramp.
    const statePath = path.join(tasksBase, TICKET, 'task1', 'tdd-phase.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.currentPhase = 'refactor';
    fs.writeFileSync(statePath, JSON.stringify(state));
    const r = runCli(
      [
        'record-refactor',
        TICKET,
        '--task',
        '1',
        '--cmd',
        'node -e "console.log(\'ok\')"',
        '--docs-exempt',
      ],
      tasksBase
    );
    assert.notEqual(r.status, 0, `--docs-exempt must be rejected for tdd-code; stderr=${r.stderr}`);
    assert.match(r.stderr, /docs-exempt|tdd-code|Type/);
  });
});

// ── Bug 2: bare CLI exits zero silently ─────────────────────────────────────

describe('tdd-phase-state CLI — bare invocation', () => {
  it('node tdd-phase-state.js with no args exits non-zero (no silent success)', () => {
    const r = spawnSync('node', [CLI], {
      encoding: 'utf8',
      env: { ...process.env, WORK_TDD_TOKEN_SKIP: '1', WORK_TDD_SKIP_WORKSPACE_CHECK: '1' },
    });
    assert.notEqual(
      r.status,
      0,
      `bare CLI must not silently succeed; stdout=${r.stdout} stderr=${r.stderr}`
    );
  });

  it('node tdd-phase-state.js prints a usage hint on bare invocation', () => {
    const r = spawnSync('node', [CLI], {
      encoding: 'utf8',
      env: { ...process.env, WORK_TDD_TOKEN_SKIP: '1', WORK_TDD_SKIP_WORKSPACE_CHECK: '1' },
    });
    const combined = (r.stderr || '') + (r.stdout || '');
    assert.match(
      combined,
      /Usage|subcommand|init|record-red/i,
      `expected usage hint on bare invocation; got: ${combined}`
    );
  });
});
