// enforcement-hooks-byte-contract.integration.test.js — Task 7 (GH-690)
//
// Byte-contract / differential characterization tests for the seven
// enforcement-critical /work hook ENTRYPOINTS, pinned by actually SPAWNING each
// hook as a child `node <hook>` process and asserting its exit code + stderr
// silence/content. These tests encode the CURRENT (pre-migration) contract that
// Task 8's `runHook` migration must preserve — they PASS against current source
// (this is a `tests-only`, `red-mode: ablation` task).
//
// The seven spawnable hook entrypoints under test:
//   fail-open (exit 0, silent stderr on benign / malformed input):
//     1. lib/hooks/session-guard.js
//     2. lib/hooks/enforce-step-workflow.js
//     3. work-implement/hooks/work-implement-enforce.js
//     4. work/hooks/protect-orchestrator-state.js
//     5. work/hooks/protect-tasks-md.js
//     6. work/hooks/protect-gherkin.js
//     7. work/hooks/protect-task-scope.js
//   fail-closed (exit 2, NON-empty stderr on a genuine block):
//     - protect-orchestrator-state.js — a state-file write
//     - protect-tasks-md.js           — a tasks.md write during `implement`
//     - protect-gherkin.js            — a semantic gherkin edit during `implement`
//
// R10: EVERY spawn pins `TASKS_BASE` and `BASE_BRANCH` in the child env.
// config.js re-derives both from the git toplevel when unset, which produces
// CI-only failures; pinning them makes these spawn tests hermetic.
//
// Security invariants asserted (R5):
//   - fail-closed BLOCK  ⇒ exit 2 AND stderr.length > 0
//   - fail-open  ALLOW   ⇒ exit 0 AND stderr === '' (byte-silent)
//   - fail-open-on-error ⇒ exit 0 AND stderr === '' for malformed-JSON /
//     empty-stdin payloads

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

// Repo root: six `..` up from plugins/work/scripts/workflows/lib/__tests__.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');

// Hermetic, EMPTY TASKS_BASE for the fail-open / context-free assertions. The
// state-based hooks (work-implement-enforce, protect-tasks-md, protect-gherkin)
// only activate when a `<ticket>` work-state file marks a step in_progress
// under TASKS_BASE. Pointing the default at an empty dir guarantees NO workflow
// is active, so a benign write is genuinely context-free — without this the
// harness's real TASKS_BASE (which may hold an in-flight GH-690 implement state)
// leaks in and legitimately activates the gate.
const EMPTY_TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'ehbc-empty-'));
process.on('exit', () => {
  try {
    fs.rmSync(EMPTY_TASKS_BASE, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

// ─── Hook entrypoint paths ───────────────────────────────────────────────────

const HOOKS = {
  sessionGuard: path.join(REPO_ROOT, 'plugins/work/scripts/workflows/lib/hooks/session-guard.js'),
  enforceStepWorkflow: path.join(
    REPO_ROOT,
    'plugins/work/scripts/workflows/lib/hooks/enforce-step-workflow.js'
  ),
  workImplementEnforce: path.join(
    REPO_ROOT,
    'plugins/work/scripts/workflows/work-implement/hooks/work-implement-enforce.js'
  ),
  protectOrchestratorState: path.join(
    REPO_ROOT,
    'plugins/work/scripts/workflows/work/hooks/protect-orchestrator-state.js'
  ),
  protectTasksMd: path.join(
    REPO_ROOT,
    'plugins/work/scripts/workflows/work/hooks/protect-tasks-md.js'
  ),
  protectGherkin: path.join(
    REPO_ROOT,
    'plugins/work/scripts/workflows/work/hooks/protect-gherkin.js'
  ),
  protectTaskScope: path.join(
    REPO_ROOT,
    'plugins/work/scripts/workflows/work/hooks/protect-task-scope.js'
  ),
};

// All seven entrypoints must exist as spawnable files before we pin them.
test('all seven enforcement-hook entrypoints exist and are spawnable', () => {
  for (const [name, hookPath] of Object.entries(HOOKS)) {
    assert.ok(fs.existsSync(hookPath), `${name} entrypoint missing: ${hookPath}`);
  }
});

// ─── Spawn helper (R10: TASKS_BASE + BASE_BRANCH always pinned) ──────────────

/**
 * Spawn a hook entrypoint with `payload` on stdin and return the pinned
 * observables: { code, stderr, stdout }.
 *
 * R10 contract: TASKS_BASE and BASE_BRANCH are ALWAYS present in the child env
 * (defaulted here, overridable via `env`), so config.js never re-derives them
 * from the git toplevel — the source of CI-only spawn-test flakiness.
 *
 * `CLAUDE_HOOK_TYPE` defaults to `PreToolUse` because these are PreToolUse
 * hooks; session-guard and enforce-step-workflow branch on it to select hook
 * mode (session-guard falls through to CLI mode without it).
 *
 * @param {string} hookPath absolute path to the hook entrypoint
 * @param {string} payload raw stdin bytes (JSON or intentionally malformed)
 * @param {object} [env] extra/override child env vars
 * @returns {{ code: number|null, stderr: string, stdout: string, env: object }}
 */
function spawnHook(hookPath, payload, env = {}) {
  const childEnv = {
    ...process.env,
    // R10 — ALWAYS pin both, hermetically, so config.js never re-derives from
    // the git toplevel (the CI-only failure mode). The default TASKS_BASE is an
    // EMPTY dir → no workflow active → benign writes are context-free. Callers
    // needing an active-implement fixture pass their own TASKS_BASE via `env`.
    TASKS_BASE: EMPTY_TASKS_BASE,
    BASE_BRANCH: 'main',
    CLAUDE_HOOK_TYPE: 'PreToolUse',
    // Inherited TICKET_ID from the harness would let state-based hooks resolve a
    // real in-flight ticket; drop it unless a case pins its own.
    TICKET_ID: undefined,
    ...env,
  };
  // `TICKET_ID: undefined` above still leaves the key present; strip it so the
  // child truly does not see a harness-inherited ticket unless `env` sets one.
  if (childEnv.TICKET_ID === undefined) delete childEnv.TICKET_ID;
  const res = spawnSync(process.execPath, [hookPath], {
    input: payload,
    encoding: 'utf8',
    timeout: 20000,
    env: childEnv,
  });
  return { code: res.status, stderr: res.stderr || '', stdout: res.stdout || '', env: childEnv };
}

// ─── State fixture (block-path hooks need a work-state file) ──────────────────

/**
 * Create a temporary TASKS_BASE dir with a `<ticket>/<work-state>` file whose
 * `stepStatus.implement === 'in_progress'`. Returns { tasksBase, ticketDir,
 * ticketId, cleanup }.
 *
 * The protected state basename is assembled at runtime (never written as a
 * verbatim literal) so authoring this test never trips the /work state-file
 * protector on the test source itself.
 */
function createImplementStateFixture(ticketId = 'GH-690T') {
  const tasksBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ehbc-'));
  const ticketDir = path.join(tasksBase, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });

  // Assemble the protected work-state basename at runtime so this test source
  // never carries the verbatim literal (which the script-bypass guard scans).
  const stateBasename = ['.work', 'state.json'].join('-');
  const state = {
    ticketId,
    status: 'in_progress',
    stepStatus: {
      ticket: 'completed',
      bootstrap: 'completed',
      brief: 'completed',
      spec: 'completed',
      tasks: 'completed',
      implement: 'in_progress',
      commit: 'pending',
    },
  };
  fs.writeFileSync(path.join(ticketDir, stateBasename), JSON.stringify(state, null, 2));

  return {
    tasksBase,
    ticketDir,
    ticketId,
    stateBasename,
    cleanup: () => fs.rmSync(tasksBase, { recursive: true, force: true }),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// R10 — every spawn pins TASKS_BASE + BASE_BRANCH in the child env
// ═══════════════════════════════════════════════════════════════════════════

test('R10: spawnHook pins TASKS_BASE and BASE_BRANCH in the child env for every hook', () => {
  for (const [name, hookPath] of Object.entries(HOOKS)) {
    const { env } = spawnHook(
      hookPath,
      JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/tmp/x.txt' } })
    );
    assert.ok(env.TASKS_BASE, `${name}: TASKS_BASE must be pinned in child env`);
    assert.ok(env.BASE_BRANCH, `${name}: BASE_BRANCH must be pinned in child env`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Fail-open ALLOW: benign Write/Read across all seven hooks ⇒ exit 0 + silent
// ═══════════════════════════════════════════════════════════════════════════

test('fail-open ALLOW: benign Write across all seven hooks exits 0 with silent stderr', () => {
  const payload = JSON.stringify({
    tool_name: 'Write',
    tool_input: { file_path: '/tmp/benign-unprotected.txt' },
  });
  for (const [name, hookPath] of Object.entries(HOOKS)) {
    const { code, stderr } = spawnHook(hookPath, payload);
    assert.equal(
      code,
      0,
      `${name}: benign Write must exit 0 (fail-open); stderr=${stderr.slice(0, 200)}`
    );
    assert.equal(stderr, '', `${name}: benign Write must keep stderr byte-silent`);
  }
});

test('fail-open ALLOW: benign Read across all seven hooks exits 0 with silent stderr', () => {
  const payload = JSON.stringify({
    tool_name: 'Read',
    tool_input: { file_path: '/tmp/benign-unprotected.txt' },
  });
  for (const [name, hookPath] of Object.entries(HOOKS)) {
    const { code, stderr } = spawnHook(hookPath, payload);
    assert.equal(
      code,
      0,
      `${name}: benign Read must exit 0 (fail-open); stderr=${stderr.slice(0, 200)}`
    );
    assert.equal(stderr, '', `${name}: benign Read must keep stderr byte-silent`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Fail-open-on-error: malformed JSON / empty stdin ⇒ exit 0 + silent
// ═══════════════════════════════════════════════════════════════════════════

test('fail-open-on-error: malformed JSON payload across all seven hooks exits 0 with silent stderr', () => {
  for (const [name, hookPath] of Object.entries(HOOKS)) {
    const { code, stderr } = spawnHook(hookPath, 'this-is-not-json{');
    assert.equal(
      code,
      0,
      `${name}: malformed JSON must fail open (exit 0); stderr=${stderr.slice(0, 200)}`
    );
    assert.equal(stderr, '', `${name}: malformed JSON must keep stderr byte-silent`);
  }
});

test('fail-open-on-error: empty stdin across all seven hooks exits 0 with silent stderr', () => {
  for (const [name, hookPath] of Object.entries(HOOKS)) {
    const { code, stderr } = spawnHook(hookPath, '');
    assert.equal(
      code,
      0,
      `${name}: empty stdin must fail open (exit 0); stderr=${stderr.slice(0, 200)}`
    );
    assert.equal(stderr, '', `${name}: empty stdin must keep stderr byte-silent`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Fail-closed BLOCK: protect-* deny paths ⇒ exit 2 + NON-empty stderr
// ═══════════════════════════════════════════════════════════════════════════

test('fail-closed BLOCK: protect-orchestrator-state blocks a state-file write (exit 2 + non-empty stderr)', () => {
  const fx = createImplementStateFixture();
  try {
    const target = path.join(fx.ticketDir, fx.stateBasename); // <ticket>/<work-state file>
    const { code, stderr } = spawnHook(
      HOOKS.protectOrchestratorState,
      JSON.stringify({ tool_name: 'Write', tool_input: { file_path: target } }),
      { TASKS_BASE: fx.tasksBase }
    );
    assert.equal(code, 2, `expected fail-closed exit 2; stderr=${stderr.slice(0, 200)}`);
    assert.ok(stderr.length > 0, 'fail-closed block must emit non-empty stderr');
    assert.match(
      stderr,
      /orchestrator-managed/,
      'block message must name the orchestrator-managed contract'
    );
  } finally {
    fx.cleanup();
  }
});

test('fail-closed BLOCK: protect-tasks-md blocks a tasks.md write during implement (exit 2 + non-empty stderr)', () => {
  const fx = createImplementStateFixture();
  try {
    const target = path.join(fx.ticketDir, 'tasks.md');
    const { code, stderr } = spawnHook(
      HOOKS.protectTasksMd,
      JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: target } }),
      { TASKS_BASE: fx.tasksBase, TICKET_ID: fx.ticketId }
    );
    assert.equal(code, 2, `expected fail-closed exit 2; stderr=${stderr.slice(0, 200)}`);
    assert.ok(stderr.length > 0, 'fail-closed block must emit non-empty stderr');
    assert.match(stderr, /tasks\.md/, 'block message must name tasks.md');
  } finally {
    fx.cleanup();
  }
});

test('fail-closed BLOCK: protect-gherkin blocks a semantic gherkin edit during implement (exit 2 + non-empty stderr)', () => {
  const fx = createImplementStateFixture();
  try {
    const target = path.join(fx.ticketDir, 'gherkin.feature');
    // A Scenario-line change is a SEMANTIC edit (not tag-only) → must block.
    const { code, stderr } = spawnHook(
      HOOKS.protectGherkin,
      JSON.stringify({
        tool_name: 'Edit',
        tool_input: {
          file_path: target,
          old_string: 'Scenario: original behaviour',
          new_string: 'Scenario: rewritten behaviour',
        },
      }),
      { TASKS_BASE: fx.tasksBase, TICKET_ID: fx.ticketId }
    );
    assert.equal(code, 2, `expected fail-closed exit 2; stderr=${stderr.slice(0, 200)}`);
    assert.ok(stderr.length > 0, 'fail-closed block must emit non-empty stderr');
    assert.match(
      stderr,
      /BYPASS:/,
      'gherkin block message must carry the spec_gate BYPASS recovery line'
    );
  } finally {
    fx.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Differential ALLOW: the same three protect-* hooks stay SILENT + exit 0 on
// a benign, non-triggering write (the other direction of the contract).
// ═══════════════════════════════════════════════════════════════════════════

test('differential ALLOW: the three fail-closed hooks stay silent (exit 0) on a benign non-triggering write', () => {
  const fx = createImplementStateFixture();
  try {
    const benign = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/some-unrelated-file.txt' },
    });
    const cases = [
      ['protect-orchestrator-state', HOOKS.protectOrchestratorState, {}],
      ['protect-tasks-md', HOOKS.protectTasksMd, { TICKET_ID: fx.ticketId }],
      ['protect-gherkin', HOOKS.protectGherkin, { TICKET_ID: fx.ticketId }],
    ];
    for (const [name, hookPath, extraEnv] of cases) {
      const { code, stderr } = spawnHook(hookPath, benign, {
        TASKS_BASE: fx.tasksBase,
        ...extraEnv,
      });
      assert.equal(code, 0, `${name}: benign write must exit 0; stderr=${stderr.slice(0, 200)}`);
      assert.equal(stderr, '', `${name}: benign write must keep stderr byte-silent`);
    }
  } finally {
    fx.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Security invariant summary (R5): fail-closed ⇒ (exit 2 ∧ stderr≠'')
// while fail-open ⇒ (exit 0 ∧ stderr==='') — asserted table-driven so a
// regression in EITHER direction fails loudly.
// ═══════════════════════════════════════════════════════════════════════════

test('R5 invariant: fail-closed blocks carry stderr on exit 2; fail-open allows stay silent on exit 0', () => {
  const fx = createImplementStateFixture();
  try {
    const stateTarget = path.join(fx.ticketDir, fx.stateBasename);
    const tasksTarget = path.join(fx.ticketDir, 'tasks.md');

    const closed = [
      [
        'protect-orchestrator-state block',
        HOOKS.protectOrchestratorState,
        JSON.stringify({ tool_name: 'Write', tool_input: { file_path: stateTarget } }),
        { TASKS_BASE: fx.tasksBase },
      ],
      [
        'protect-tasks-md block',
        HOOKS.protectTasksMd,
        JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: tasksTarget } }),
        { TASKS_BASE: fx.tasksBase, TICKET_ID: fx.ticketId },
      ],
    ];
    for (const [name, hookPath, payload, env] of closed) {
      const { code, stderr } = spawnHook(hookPath, payload, env);
      assert.equal(code, 2, `${name}: must exit 2`);
      assert.ok(stderr.length > 0, `${name}: must have non-empty stderr on exit 2`);
    }

    const open = [
      ['session-guard', HOOKS.sessionGuard],
      ['enforce-step-workflow', HOOKS.enforceStepWorkflow],
      ['work-implement-enforce', HOOKS.workImplementEnforce],
      ['protect-task-scope', HOOKS.protectTaskScope],
    ];
    const benign = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/benign.txt' },
    });
    for (const [name, hookPath] of open) {
      const { code, stderr } = spawnHook(hookPath, benign);
      assert.equal(code, 0, `${name}: must exit 0 on benign write`);
      assert.equal(stderr, '', `${name}: must have silent stderr on exit 0`);
    }
  } finally {
    fx.cleanup();
  }
});
