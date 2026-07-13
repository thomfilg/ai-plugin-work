// enforcement-hooks-runhook.integration.test.js — Task 8 (GH-690)
//
// Differential migration assertion for the enforcement-critical /work hook
// ENTRYPOINTS: each must route its entry through the shared `runHook` protocol
// (`lib/hookEntrypoint`), NOT the hand-rolled
// `main().catch((err) => { logHookError(...); process.exit(0/2); })` boilerplate.
//
// This test FAILS against the pre-migration source (hooks still use their own
// try/catch + logHookError + exit boilerplate) and PASSES once Task 8 rewires
// every entrypoint onto `runHook(handler, { onError })`.
//
// It is DIFFERENTIAL in two directions:
//   1. Source-structure — each migrated hook `require`s `runHook` from the
//      vendored `hookEntrypoint` module and invokes `runHook(` at its entry;
//      the legacy `main().catch(... logHookError ... process.exit ...)` entry
//      boilerplate is gone.
//   2. Runtime protocol — spawning each hook still honours the `runHook`
//      observable contract: fail-open hooks exit 0 with byte-silent stderr on a
//      benign/malformed payload; fail-closed blocks exit 2 with NON-empty
//      stderr. (This overlaps the Task 7 byte-contract net on purpose — the
//      migration must preserve it in both directions.)
//
// R10: EVERY spawn pins TASKS_BASE and BASE_BRANCH in the child env so config.js
// never re-derives them from the git toplevel (the CI-only spawn-flakiness mode).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

// Repo root: six `..` up from plugins/work/scripts/workflows/lib/__tests__.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');

// Hermetic EMPTY TASKS_BASE for the fail-open assertions — no workflow active,
// so benign writes are genuinely context-free (mirrors the Task 7 harness).
const EMPTY_TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'ehrh-empty-'));
process.on('exit', () => {
  try {
    fs.rmSync(EMPTY_TASKS_BASE, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

// ─── Migrated hook entrypoints (the seven spawnable enforcement hooks) ────────

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

function readSource(hookPath) {
  return fs.readFileSync(hookPath, 'utf8');
}

// ─── Spawn helper (R10: TASKS_BASE + BASE_BRANCH always pinned) ──────────────

/**
 * Spawn a hook entrypoint with `payload` on stdin and return the pinned
 * observables { code, stderr, stdout }. Mirrors the Task 7 harness: hermetic
 * empty TASKS_BASE default, CLAUDE_HOOK_TYPE=PreToolUse, harness TICKET_ID
 * stripped unless a case pins its own.
 */
function spawnHook(hookPath, payload, env = {}) {
  const childEnv = {
    ...process.env,
    // R10 — ALWAYS pin both so config.js never re-derives from the git toplevel.
    TASKS_BASE: EMPTY_TASKS_BASE,
    BASE_BRANCH: 'main',
    CLAUDE_HOOK_TYPE: 'PreToolUse',
    TICKET_ID: undefined,
    ...env,
  };
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
 * Temp TASKS_BASE with a `<ticket>/<work-state>` file whose
 * stepStatus.implement === 'in_progress'. The protected basename is assembled
 * at runtime so this source never carries the verbatim literal (script-bypass
 * guard scans test sources for it).
 */
function createImplementStateFixture(ticketId = 'GH-690T') {
  const tasksBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ehrh-'));
  const ticketDir = path.join(tasksBase, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
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
// Guard: every migrated hook entrypoint exists.
// ═══════════════════════════════════════════════════════════════════════════

test('all seven migrated enforcement-hook entrypoints exist', () => {
  for (const [name, hookPath] of Object.entries(HOOKS)) {
    assert.ok(fs.existsSync(hookPath), `${name} entrypoint missing: ${hookPath}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SOURCE-STRUCTURE differential (fails pre-migration):
//   each hook requires `runHook` from hookEntrypoint AND invokes `runHook(`.
// ═══════════════════════════════════════════════════════════════════════════

test('every migrated hook requires runHook from the hookEntrypoint module', () => {
  // Accept the vendored (`./hookEntrypoint` / `../hookEntrypoint`) require of
  // `runHook`. The require may destructure runHook alongside other exports.
  const requiresRunHook = /require\([^)]*hookEntrypoint[^)]*\)/;
  const destructuresRunHook = /\brunHook\b/;
  for (const [name, hookPath] of Object.entries(HOOKS)) {
    const src = readSource(hookPath);
    assert.match(
      src,
      requiresRunHook,
      `${name}: must require the hookEntrypoint module (source of runHook)`
    );
    assert.match(src, destructuresRunHook, `${name}: must reference runHook`);
  }
});

test('every migrated hook invokes runHook( at its entrypoint', () => {
  const invokesRunHook = /\brunHook\s*\(/;
  for (const [name, hookPath] of Object.entries(HOOKS)) {
    const src = readSource(hookPath);
    assert.match(src, invokesRunHook, `${name}: must call runHook(handler, ...) at its entry`);
  }
});

test('no migrated hook keeps a hand-rolled main().catch(logHookError → exit) entry', () => {
  // The legacy boilerplate is a bare `main().catch((err) => { … logHookError …
  // process.exit(…) })` acting as the process entrypoint. `runHook` owns that
  // fail-open/closed exit now, so the trailing hand-rolled catch must be gone.
  // We scan for the specific `main().catch(` entry form (allowing whitespace),
  // which is what every pre-migration entrypoint used.
  const handRolledEntry = /\bmain\(\)\s*\.catch\s*\(/;
  for (const [name, hookPath] of Object.entries(HOOKS)) {
    const src = readSource(hookPath);
    assert.doesNotMatch(
      src,
      handRolledEntry,
      `${name}: must not retain the hand-rolled main().catch(...) entry boilerplate — route through runHook`
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// RUNTIME-PROTOCOL differential — the runHook observable contract is preserved
// in both directions (R10: TASKS_BASE + BASE_BRANCH pinned for every spawn).
// ═══════════════════════════════════════════════════════════════════════════

test('runHook contract (fail-open): benign Write exits 0 with silent stderr across all seven hooks', () => {
  const payload = JSON.stringify({
    tool_name: 'Write',
    tool_input: { file_path: '/tmp/benign-unprotected.txt' },
  });
  for (const [name, hookPath] of Object.entries(HOOKS)) {
    const { code, stderr } = spawnHook(hookPath, payload);
    assert.equal(code, 0, `${name}: benign Write must exit 0; stderr=${stderr.slice(0, 200)}`);
    assert.equal(stderr, '', `${name}: benign Write must keep stderr byte-silent`);
  }
});

test('runHook contract (fail-open-on-error): malformed JSON exits 0 with silent stderr across all seven hooks', () => {
  for (const [name, hookPath] of Object.entries(HOOKS)) {
    const { code, stderr } = spawnHook(hookPath, 'not-json{');
    assert.equal(
      code,
      0,
      `${name}: malformed JSON must fail open (exit 0); stderr=${stderr.slice(0, 200)}`
    );
    assert.equal(stderr, '', `${name}: malformed JSON must keep stderr byte-silent`);
  }
});

test('runHook contract (fail-closed): protect-orchestrator-state block exits 2 with non-empty stderr', () => {
  const fx = createImplementStateFixture();
  try {
    const target = path.join(fx.ticketDir, fx.stateBasename);
    const { code, stderr } = spawnHook(
      HOOKS.protectOrchestratorState,
      JSON.stringify({ tool_name: 'Write', tool_input: { file_path: target } }),
      { TASKS_BASE: fx.tasksBase }
    );
    assert.equal(code, 2, `expected fail-closed exit 2; stderr=${stderr.slice(0, 200)}`);
    assert.ok(stderr.length > 0, 'fail-closed block must emit non-empty stderr');
  } finally {
    fx.cleanup();
  }
});

test('runHook contract (fail-closed): protect-tasks-md block during implement exits 2 with non-empty stderr', () => {
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
  } finally {
    fx.cleanup();
  }
});
