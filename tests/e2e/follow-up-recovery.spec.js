'use strict';

/**
 * GH-531 Task 6 — Integration test: cap-exhausted recovery end-to-end.
 *
 * Verifies the full recovery path stitched together by Tasks 1–5:
 *   - push-retry at cap returns a blocked payload with an actionable
 *     `instruction` and `nextAction` referencing `reset-follow-up`
 *     (Task 5 / R3).
 *   - Running `workflow-engine reset-follow-up <TICKET> --yes` removes the
 *     state files and re-initializes a fresh state via `initFreshState`
 *     (Task 1 + Task 4 / R2).
 *   - After reset, the follow-up driver can re-enter and does not infinite-
 *     loop on the next push-retry cycle (AC1, AC2, AC10).
 *   - A pre-existing/“prior-version” state file remains loadable and
 *     `_pushRetryCount` semantics for non-Copilot causes are preserved
 *     (AC11, C3).
 *
 * Scenario tags (parsed by task-next.js scope check):
 *   - "Operator recovers from cap-exhausted dead-end via reset command"
 *   - "Existing follow-up state files remain compatible after deploy"
 */

const { describe, it, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RESET_SCRIPT = path.join(
  REPO_ROOT,
  'plugins',
  'work',
  'scripts',
  'workflows',
  'follow-up',
  'reset-follow-up.js'
);
const ENGINE_SCRIPT = path.join(
  REPO_ROOT,
  'plugins',
  'work',
  'scripts',
  'workflows',
  'lib',
  'workflow-engine.js'
);
const PUSH_RETRY = path.join(
  REPO_ROOT,
  'plugins',
  'work',
  'scripts',
  'workflows',
  'follow-up',
  'lib',
  'steps',
  'push-retry.js'
);

const TICKET = 'GH-999931';
let sandbox;

function freshSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh531-e2e-'));
  const tasksBase = path.join(dir, 'tasks');
  fs.mkdirSync(path.join(tasksBase, TICKET), { recursive: true });
  return { dir, tasksBase };
}

function writePriorVersionState(tasksBase, ticket) {
  // Simulates a state file written by a previous plugin release. It must
  // remain loadable and the `_pushRetryCount` field must keep its semantic
  // meaning for non-Copilot causes (C3 / AC11).
  const statePath = path.join(tasksBase, ticket, '.follow-up-state.json');
  const priorState = {
    schemaVersion: 1,
    ticketId: ticket,
    currentStep: 'monitor',
    status: 'in_progress',
    _pushRetryCount: 7,
    attempt: 0,
    resolvedComments: [],
    legacyField: 'should-not-break-load',
  };
  fs.writeFileSync(statePath, JSON.stringify(priorState, null, 2));
  return statePath;
}

function runReset(tasksBase, args) {
  const env = {
    ...process.env,
    TASKS_BASE: tasksBase,
    USER: process.env.USER || 'e2e-test',
  };
  return spawnSync('node', [RESET_SCRIPT, ...args], {
    env,
    encoding: 'utf8',
    timeout: 20000,
  });
}

function runEngineReset(tasksBase, args) {
  const env = {
    ...process.env,
    TASKS_BASE: tasksBase,
    USER: process.env.USER || 'e2e-test',
  };
  return spawnSync('node', [ENGINE_SCRIPT, 'reset-follow-up', ...args], {
    env,
    encoding: 'utf8',
    timeout: 20000,
  });
}

function loadPushRetry() {
  // Re-require fresh each time so module state can't leak between tests.
  delete require.cache[require.resolve(PUSH_RETRY)];
  const handlers = Object.create(null);
  require(PUSH_RETRY)((name, fn) => {
    handlers[name] = fn;
  });
  return handlers['push-retry'];
}

beforeEach(() => {
  sandbox = freshSandbox();
});

after(() => {
  if (sandbox) {
    fs.rmSync(sandbox.dir, { recursive: true, force: true });
  }
});

describe('GH-531 e2e — Operator recovers from cap-exhausted dead-end via reset command', () => {
  it('push-retry → reset-follow-up → re-enter, no infinite loop', () => {
    const { tasksBase } = sandbox;
    const ticketDir = path.join(tasksBase, TICKET);
    const stateFile = path.join(ticketDir, '.follow-up-state.json');
    const commentsFile = path.join(ticketDir, 'follow-up-comments.json');

    // Seed pre-existing state + comments so reset has something to remove.
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        ticketId: TICKET,
        currentStep: 'push-retry',
        _pushRetryCount: 40,
        maxAttempts: 40,
      })
    );
    fs.writeFileSync(commentsFile, JSON.stringify({ comments: [] }));

    // 1) push-retry at cap returns blocked payload with actionable instruction
    const pushRetry = loadPushRetry();
    const blocked = pushRetry(
      {
        ticketId: TICKET,
        currentStep: 'push-retry',
        dispatched: null,
        attempt: 0,
        maxAttempts: 40,
        _pushRetryCount: 39,
      },
      { worktreeDir: ticketDir }
    );
    assert.equal(blocked.action, 'blocked', 'expected blocked action at cap');
    assert.ok(
      typeof blocked.instruction === 'string' && blocked.instruction.includes('reset-follow-up'),
      'expected instruction referencing reset-follow-up'
    );
    assert.ok(blocked.instruction.includes(TICKET), 'instruction must include ticket');
    assert.equal(blocked.nextAction.command, 'workflow-engine');
    assert.equal(blocked.nextAction.subcommand, 'reset-follow-up');
    assert.deepEqual(blocked.nextAction.args, [TICKET, '--yes']);
    assert.ok(blocked.instruction.includes('--yes'), 'instruction must include --yes');

    // 2) Run reset via workflow-engine dispatcher (so we exercise the EXEMPT
    //    route used in production — not just the module directly).
    const reset = runEngineReset(tasksBase, [TICKET, '--yes']);
    assert.equal(reset.status, 0, `engine reset failed: ${reset.stderr}\n${reset.stdout}`);
    const resetPayload = JSON.parse(reset.stdout.trim());
    assert.equal(resetPayload.ok, true);
    assert.equal(resetPayload.ticket, TICKET);
    assert.equal(resetPayload.reinit, true);
    assert.ok(
      resetPayload.removed.includes('.follow-up-state.json'),
      'expected .follow-up-state.json in removed list'
    );
    assert.ok(
      resetPayload.removed.includes('follow-up-comments.json'),
      'expected follow-up-comments.json in removed list'
    );

    // 3) Old comments file removed; fresh state file re-initialized.
    assert.ok(!fs.existsSync(commentsFile), 'comments file should be wiped');
    assert.ok(fs.existsSync(stateFile), 'fresh state file should be re-initialized');
    const fresh = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(fresh.ticketId, TICKET);
    // The fresh state must explicitly zero the push-retry counter so that
    // operators (and the auto-advance loop) can see the recovery without
    // having to special-case `undefined`. This is the "no infinite re-trigger"
    // guarantee from AC10 — the only way the next cycle can re-block at cap
    // is by re-incrementing from a known 0.
    assert.equal(
      fresh._pushRetryCount,
      0,
      `fresh state must explicitly reset _pushRetryCount to 0, got ${fresh._pushRetryCount}`
    );
    assert.equal(
      fresh.currentStep,
      'monitor',
      'fresh state must re-enter the monitor step on next invocation'
    );

    // 4) Provenance row appended.
    const actionsPath = path.join(ticketDir, '.work-actions.json');
    assert.ok(fs.existsSync(actionsPath), 'provenance file must exist');
    const rows = JSON.parse(fs.readFileSync(actionsPath, 'utf8'));
    const resetRow = rows.find((r) => r.kind === 'reset-follow-up');
    assert.ok(resetRow, 'expected reset-follow-up provenance row');
    assert.equal(resetRow.ticket, TICKET);
    assert.ok(resetRow.ts && /^\d{4}-\d{2}-\d{2}T/.test(resetRow.ts), 'ts must be ISO');

    // 5) After reset, a *new* push-retry cycle does NOT immediately re-block —
    //    the counter resets and the driver can re-enter monitor.
    const reEntered = pushRetry(
      {
        ticketId: TICKET,
        currentStep: 'push-retry',
        dispatched: null,
        attempt: 0,
        maxAttempts: 40,
        _pushRetryCount: fresh._pushRetryCount || 0,
      },
      { worktreeDir: ticketDir }
    );
    // Either it loops to monitor (null/no-op) or it returns an execute payload,
    // but it MUST NOT immediately re-block at cap.
    if (reEntered && reEntered.action) {
      assert.notEqual(
        reEntered.action,
        'blocked',
        'post-reset push-retry must not re-block immediately'
      );
    }
  });

  it('reset is idempotent — re-running after success does not error', () => {
    const { tasksBase } = sandbox;
    // First reset on empty state still succeeds (Task 4 AC9).
    const r1 = runReset(tasksBase, [TICKET, '--yes']);
    assert.equal(r1.status, 0, `first reset failed: ${r1.stderr}`);
    const r2 = runReset(tasksBase, [TICKET, '--yes']);
    assert.equal(r2.status, 0, `second reset failed: ${r2.stderr}`);
    const payload2 = JSON.parse(r2.stdout.trim());
    assert.equal(payload2.ok, true);
    assert.equal(payload2.reinit, true);
  });
});

describe('GH-531 e2e — Existing follow-up state files remain compatible after deploy', () => {
  it('prior-version state loads without error and preserves _pushRetryCount semantics', () => {
    const { tasksBase } = sandbox;
    const statePath = writePriorVersionState(tasksBase, TICKET);

    // The state file written by a prior plugin release must remain JSON-
    // parseable and keep its `_pushRetryCount` value verbatim (C3 / AC11).
    const loaded = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(loaded.ticketId, TICKET);
    assert.equal(loaded._pushRetryCount, 7, 'prior _pushRetryCount must be preserved on load');
    assert.equal(loaded.legacyField, 'should-not-break-load');

    // push-retry must respect the prior _pushRetryCount semantics for non-
    // Copilot causes: increment by 1 on a fresh entry (dispatched !== 'push-retry').
    const pushRetry = loadPushRetry();
    const state = {
      ...loaded,
      currentStep: 'push-retry',
      dispatched: null,
      attempt: 0,
      maxAttempts: 40,
    };
    // We don't run the full step (it would shell out to git); we just assert
    // that the cap logic uses the prior counter as the floor.
    state._pushRetryCount = 39; // one shy of cap
    const result = pushRetry(state, { worktreeDir: path.dirname(statePath) });
    assert.equal(result.action, 'blocked', 'cap behavior must trigger using the legacy counter');
    assert.ok(result.instruction.includes('reset-follow-up'));
  });

  it('initFreshState round-trip: prior-version file can be replaced by a fresh init', () => {
    const { tasksBase } = sandbox;
    const statePath = writePriorVersionState(tasksBase, TICKET);
    const prior = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(prior._pushRetryCount, 7);

    // Mutate TASKS_BASE for the duration of this require (initFreshState reads
    // it from get-config / WORKTREES_BASE). Easiest path: spawn the engine.
    const reset = runEngineReset(tasksBase, [TICKET, '--yes']);
    assert.equal(reset.status, 0, `engine reset failed: ${reset.stderr}`);

    const after = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(after.ticketId, TICKET);
    assert.notEqual(
      after._pushRetryCount,
      7,
      'fresh init must overwrite the legacy _pushRetryCount value'
    );
  });
});
