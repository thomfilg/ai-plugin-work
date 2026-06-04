'use strict';

/**
 * Regression (Bug 3): when a step returns action:'surface' with a reason
 * (e.g. 'github-actions-outage'), the orchestrator must persist that reason
 * onto state.failureCategory so a subsequent /follow-up invocation does NOT
 * silently mark the workflow complete via report.js.
 *
 * Before this fix, follow-up-next.js only set state.currentStep='report' on
 * surface — failureCategory stayed null, report.js fell through to the
 * status='complete' branch, and the outage was effectively erased.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FOLLOW_UP_NEXT_PATH = require.resolve('../follow-up-next.js');
const STEP_REGISTRY_PATH = require.resolve('../lib/step-registry.js');
const REPORT_PATH = require.resolve('../lib/steps/report.js');
const STATE_FILE = '.' + 'follow-up' + '-state.json';

function setupTmpState(stateFixture) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-surface-'));
  const tasksBase = path.join(tmp, 'tasks');
  fs.mkdirSync(path.join(tasksBase, 'GH-SURF'), { recursive: true });
  fs.writeFileSync(
    path.join(tasksBase, 'GH-SURF', STATE_FILE),
    JSON.stringify(stateFixture, null, 2)
  );
  process.env.TASKS_BASE = tasksBase;
  process.env.WORKTREES_BASE = tmp;
  return { tmp, tasksBase };
}

function loadNextWithSurfacingStep(currentStep) {
  delete require.cache[FOLLOW_UP_NEXT_PATH];
  delete require.cache[STEP_REGISTRY_PATH];
  require.cache[STEP_REGISTRY_PATH] = {
    id: STEP_REGISTRY_PATH,
    filename: STEP_REGISTRY_PATH,
    loaded: true,
    exports: {
      STEPS: ['monitor', 'triage', 'infra-retry', 'fix-ci', 'fix-reviews', 'push-retry', 'report'],
      runStep: (stepName) => {
        if (stepName === currentStep) {
          return {
            type: 'follow_up_instruction',
            action: 'surface',
            payload: { reason: 'github-actions-outage', signals: ['signal4'] },
            reason: 'github-actions-outage',
          };
        }
        return null;
      },
    },
  };
  return require(FOLLOW_UP_NEXT_PATH);
}

describe('follow-up-next.js — surface persists failureCategory (Bug 3)', () => {
  it('persists failureCategory when a step surfaces with a reason', () => {
    const initial = {
      ticketId: 'GH-SURF',
      prNumber: 100,
      currentStep: 'infra-retry',
      status: 'in_progress',
      attempt: 1,
      maxAttempts: 40,
      failureCategory: null,
    };
    const { tasksBase } = setupTmpState(initial);
    const mod = loadNextWithSurfacingStep('infra-retry');
    const result = mod.getNextInstruction('GH-SURF', 100);
    assert.equal(result.action, 'surface');

    const persisted = JSON.parse(
      fs.readFileSync(path.join(tasksBase, 'GH-SURF', STATE_FILE), 'utf8')
    );
    assert.equal(
      persisted.failureCategory,
      'github-actions-outage',
      'surface reason must be saved onto state.failureCategory'
    );
    assert.equal(persisted.currentStep, 'report');
    assert.notEqual(persisted.status, 'complete');
  });

  it('Bug E: report renders infra-stuck bundle after infra-retry exhausts (reason=infra-stuck)', () => {
    // Simulate infra-retry surfacing exhausted: failureCategory already set to
    // 'infra-stuck' by maybeSurfaceExhausted, infraRetry.attempts populated.
    delete require.cache[REPORT_PATH];
    const handlers = Object.create(null);
    require(REPORT_PATH)((name, fn) => {
      handlers[name] = fn;
    });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'report-infra-stuck-'));
    const state = {
      ticketId: 'GH-SURF',
      prNumber: 100,
      attempt: 3,
      currentStep: 'report',
      failureCategory: 'infra-stuck',
      repoOwner: 'thomfilg',
      repoName: 'claude-plugin-work',
      infraRetry: {
        count: 3,
        attempts: [
          {
            attemptNumber: 1,
            timestamp: 't1',
            runId: '111',
            signals: ['signal1', 'signal2'],
            retryMethod: 'rerun-failed',
          },
        ],
      },
      lastMonitorResult: { exitCode: 1, output: 'CI: FAILED' },
    };
    const result = handlers['report'](state, { tasksDir: tmp });
    assert.equal(result.action, 'surface');
    assert.equal(result.payload && result.payload.reason, 'infra-stuck');
    assert.match(result.summary, /Infra-stuck after 1 retries/);
    assert.notEqual(state.status, 'complete');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('report.js does NOT mark status=complete when failureCategory=github-actions-outage', () => {
    delete require.cache[REPORT_PATH];
    const handlers = Object.create(null);
    require(REPORT_PATH)((name, fn) => {
      handlers[name] = fn;
    });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'report-surface-'));
    const state = {
      ticketId: 'GH-SURF',
      prNumber: 100,
      attempt: 1,
      currentStep: 'report',
      failureCategory: 'github-actions-outage',
      infraRetry: { count: 0, attempts: [] },
      lastMonitorResult: { exitCode: 1, output: 'CI: FAILED' },
    };
    const result = handlers['report'](state, { tasksDir: tmp });
    assert.ok(result, 'report must return a surfacing instruction, not null');
    assert.equal(result.action, 'surface');
    assert.notEqual(state.status, 'complete');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
