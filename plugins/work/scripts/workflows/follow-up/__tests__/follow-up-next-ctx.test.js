'use strict';

/**
 * Regression: follow-up-next.js must build a ctx that the classifier and the
 * infra-retry step can actually use. Before this fix, ctx had only
 * { tasksDir, worktreeDir, TASKS_BASE, workScriptsDir } — so classifier saw
 * no allJobs / prDiffFiles / rawLogs / exec / jobId / ciStatus and trivially
 * returned code-failure, defeating the whole feature.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FOLLOW_UP_NEXT_PATH = require.resolve('../follow-up-next.js');
const STEP_REGISTRY_PATH = require.resolve('../lib/step-registry.js');

function loadWithStubs(stateFixture, captured) {
  delete require.cache[FOLLOW_UP_NEXT_PATH];
  delete require.cache[STEP_REGISTRY_PATH];

  // Build a state file the loader will read.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-next-ctx-'));
  const tasksBase = path.join(tmp, 'tasks');
  fs.mkdirSync(path.join(tasksBase, 'GH-CTX'), { recursive: true });
  fs.writeFileSync(
    path.join(tasksBase, 'GH-CTX', '.' + 'follow-up' + '-state.json'),
    JSON.stringify(stateFixture, null, 2)
  );
  process.env.TASKS_BASE = tasksBase;
  process.env.WORKTREES_BASE = tmp;

  // Stub the step registry with a single capture step matching the state's
  // currentStep.
  require.cache[STEP_REGISTRY_PATH] = {
    id: STEP_REGISTRY_PATH,
    filename: STEP_REGISTRY_PATH,
    loaded: true,
    exports: {
      STEPS: [stateFixture.currentStep, 'report'],
      runStep: (stepName, state, ctx) => {
        captured.stepName = stepName;
        captured.ctx = ctx;
        captured.state = state;
        // Return a non-null instruction so the loop exits immediately.
        return { type: 'follow_up_instruction', action: 'blocked', reason: 'captured' };
      },
    },
  };

  return require(FOLLOW_UP_NEXT_PATH);
}

describe('follow-up-next.js — ctx wiring (Bug 2)', () => {
  it('passes ciStatus, exec, jobId, prDiffFiles, allJobs, rawLogs to step handlers', () => {
    const captured = {};
    const state = {
      ticketId: 'GH-508',
      prNumber: 542,
      currentStep: 'infra-retry',
      status: 'in_progress',
      attempt: 1,
      maxAttempts: 40,
      // monitor.js stores `jobId` (databaseId from gh API), not `id`. Bug C
      // (GH-508) aligned buildClassifierCtx with the field monitor actually writes.
      _ciFailedJobs: [{ name: 'e2e [shard-4]', runId: '987654', jobId: '111' }],
      _ciStatus: 'failing',
      _ciFailedLogs: 'cache: MISS\nfallback install FAILED\n',
      _ciAllJobs: [{ name: 'e2e [shard-1]' }, { name: 'e2e [shard-4]' }],
      failureCategory: null,
    };
    const mod = loadWithStubs(state, captured);
    mod.getNextInstruction('GH-CTX', 542);

    assert.ok(captured.ctx, 'ctx must be passed to the step handler');
    const ctx = captured.ctx;

    // Existing fields preserved.
    assert.ok(ctx.tasksDir, 'tasksDir');
    assert.ok(ctx.workScriptsDir, 'workScriptsDir');

    // New fields the classifier needs.
    assert.equal(typeof ctx.exec, 'function', 'ctx.exec must be a function');
    assert.ok('ciStatus' in ctx, 'ctx.ciStatus must be present (read by maybeHandleRetrySuccess)');
    assert.ok('jobId' in ctx, 'ctx.jobId must be present (read by signal2)');
    assert.ok(Array.isArray(ctx.prDiffFiles), 'ctx.prDiffFiles must be an array');
    assert.ok(Array.isArray(ctx.allJobs), 'ctx.allJobs must be an array');
    assert.equal(typeof ctx.rawLogs, 'string', 'ctx.rawLogs must be a string');

    // jobId from the first failed job's id field.
    assert.equal(ctx.jobId, '111');
    // allJobs from state._ciAllJobs.
    assert.equal(ctx.allJobs.length, 2);
    // rawLogs from state._ciFailedLogs.
    assert.match(ctx.rawLogs, /cache: MISS/);
  });

  it('Bug 4: infra-retry step sees ctx.ciStatus=success from state._ciStatus and detects retry-success', () => {
    // Use the production ctx builder to drive the REAL infra-retry handler.
    // Reset registries so the real step-registry is loaded (no stub).
    delete require.cache[FOLLOW_UP_NEXT_PATH];
    delete require.cache[STEP_REGISTRY_PATH];

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-next-ctx-bug4-'));
    const tasksBase = path.join(tmp, 'tasks');
    fs.mkdirSync(path.join(tasksBase, 'GH-CTX4'), { recursive: true });

    const state = {
      ticketId: 'GH-CTX4',
      prNumber: 542,
      currentStep: 'infra-retry',
      status: 'in_progress',
      attempt: 1,
      maxAttempts: 40,
      _ciFailedJobs: [],
      _ciStatus: 'success',
      _ciStatusFreshness: { pid: process.pid, at: new Date().toISOString() },
      failureCategory: 'ci_failure',
      infraRetry: {
        count: 1,
        attempts: [
          {
            attemptNumber: 1,
            timestamp: '2026-01-01T00:00:00.000Z',
            runId: '11111',
            signals: ['signal1', 'signal2'],
            retryMethod: 'rerun-failed',
            outcome: 'pending',
          },
        ],
      },
    };
    fs.writeFileSync(
      path.join(tasksBase, 'GH-CTX4', '.' + 'follow-up' + '-state.json'),
      JSON.stringify(state, null, 2)
    );
    process.env.TASKS_BASE = tasksBase;
    process.env.WORKTREES_BASE = tmp;

    const mod = require(FOLLOW_UP_NEXT_PATH);
    mod.getNextInstruction('GH-CTX4', 542);

    const persisted = JSON.parse(
      fs.readFileSync(path.join(tasksBase, 'GH-CTX4', '.' + 'follow-up' + '-state.json'), 'utf8')
    );
    assert.equal(
      persisted.infraRetry.attempts[0].outcome,
      'succeeded',
      'pending attempt must be marked succeeded when _ciStatus=success in state'
    );
  });

  it('PR #542: rebuilds ctx inside the loop so a step that mutates state._ciStatus is visible to the next step', () => {
    delete require.cache[FOLLOW_UP_NEXT_PATH];
    delete require.cache[STEP_REGISTRY_PATH];

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-next-ctx-loop-'));
    const tasksBase = path.join(tmp, 'tasks');
    fs.mkdirSync(path.join(tasksBase, 'GH-LOOP'), { recursive: true });

    const state = {
      ticketId: 'GH-LOOP',
      prNumber: 542,
      currentStep: 'monitor',
      status: 'in_progress',
      attempt: 1,
      maxAttempts: 40,
      _ciStatus: 'failing',
      _ciAllJobs: [],
      _ciFailedLogs: '',
      failureCategory: null,
    };
    fs.writeFileSync(
      path.join(tasksBase, 'GH-LOOP', '.' + 'follow-up' + '-state.json'),
      JSON.stringify(state, null, 2)
    );
    process.env.TASKS_BASE = tasksBase;
    process.env.WORKTREES_BASE = tmp;

    const observed = [];
    require.cache[STEP_REGISTRY_PATH] = {
      id: STEP_REGISTRY_PATH,
      filename: STEP_REGISTRY_PATH,
      loaded: true,
      exports: {
        STEPS: ['monitor', 'infra-retry'],
        runStep: (stepName, st, ctx) => {
          observed.push({ stepName, ciStatus: ctx.ciStatus, rawLogs: ctx.rawLogs });
          if (stepName === 'monitor') {
            // Simulate monitor refreshing CI state mid-loop.
            st._ciStatus = 'success';
            st._ciFailedLogs = 'cache HIT\n';
            return null; // advance to next step
          }
          // Terminal so the loop exits.
          return { type: 'follow_up_instruction', action: 'blocked', reason: 'captured' };
        },
      },
    };

    const mod = require(FOLLOW_UP_NEXT_PATH);
    mod.getNextInstruction('GH-LOOP', 542);

    assert.equal(observed.length, 2, 'both steps must run in one invocation');
    assert.equal(observed[0].stepName, 'monitor');
    assert.equal(observed[0].ciStatus, 'failing', 'monitor sees the pre-mutation snapshot');
    assert.equal(observed[1].stepName, 'infra-retry');
    assert.equal(
      observed[1].ciStatus,
      'success',
      'infra-retry must see the post-monitor _ciStatus, not the snapshot taken before the loop'
    );
    assert.match(
      observed[1].rawLogs,
      /cache HIT/,
      'infra-retry must see the post-monitor _ciFailedLogs'
    );
  });
});
