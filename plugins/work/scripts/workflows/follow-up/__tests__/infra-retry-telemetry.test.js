'use strict';

/**
 * Tests for Task 7 — P1 telemetry, retry-success log, GH Actions cross-check.
 *
 * Deliverable 7.1.1 / 7.2.1 / 7.3.1 (RED):
 *  - 7.1: every classify() call appends { timestamp, signals, decision, outcome }
 *         to state.history[] (default []).
 *  - 7.2: on retry-success branch, stderr contains literal
 *         "auto-retry: infra flake confirmed".
 *  - 7.3: when Signal 4 fires across ≥2 jobs AND github status reports
 *         Actions degraded, step returns action:'surface' with
 *         reason:'github-actions-outage' and does NOT increment retry count
 *         nor invoke gh run rerun.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const STEP_PATH = require.resolve('../lib/steps/infra-retry');
const CLASSIFIER_PATH = require.resolve('../lib/infra-classifier');
const GET_CONFIG_PATH = require.resolve(path.resolve(__dirname, '..', '..', 'lib', 'get-config'));
const GH_ACTIONS_STATUS_PATH = path.resolve(__dirname, '..', 'lib', 'gh-actions-status.js');

function loadStep({ classifyImpl, ghActionsStatusImpl } = {}) {
  delete require.cache[STEP_PATH];
  delete require.cache[CLASSIFIER_PATH];
  delete require.cache[GET_CONFIG_PATH];

  let ghActionsResolved;
  try {
    ghActionsResolved = require.resolve('../lib/gh-actions-status');
  } catch (_err) {
    ghActionsResolved = GH_ACTIONS_STATUS_PATH;
  }
  delete require.cache[ghActionsResolved];

  const classifyCalls = [];
  const classify = (...args) => {
    classifyCalls.push(args);
    return classifyImpl
      ? classifyImpl(...args)
      : { classification: 'code-failure', signals: [], evidence: {} };
  };
  require.cache[CLASSIFIER_PATH] = {
    id: CLASSIFIER_PATH,
    filename: CLASSIFIER_PATH,
    loaded: true,
    exports: { classify, __test__: {} },
  };

  const getConfig = () => undefined;
  require.cache[GET_CONFIG_PATH] = {
    id: GET_CONFIG_PATH,
    filename: GET_CONFIG_PATH,
    loaded: true,
    exports: getConfig,
  };

  const ghActionsCalls = [];
  if (ghActionsStatusImpl) {
    require.cache[ghActionsResolved] = {
      id: ghActionsResolved,
      filename: ghActionsResolved,
      loaded: true,
      exports: {
        checkActionsStatus: (...args) => {
          ghActionsCalls.push(args);
          return ghActionsStatusImpl(...args);
        },
      },
    };
  }

  const stepModule = require(STEP_PATH);
  const handlers = Object.create(null);
  const register = (name, fn) => {
    handlers[name] = fn;
  };
  stepModule(register);
  return { handler: handlers['infra-retry'], classifyCalls, ghActionsCalls };
}

function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  let buf = '';
  process.stderr.write = (chunk) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return buf;
}

describe('infra-retry — Task 7 telemetry / retry-success log / gh-actions outage (RED)', () => {
  it('7.1: appends telemetry entry to state.history[] on classify', () => {
    const { handler } = loadStep({
      classifyImpl: () => ({
        classification: 'infra-suspected',
        signals: ['signal1', 'signal2'],
        evidence: {},
      }),
    });
    const state = {
      failureCategory: 'ci_failure',
      runId: '12345',
      infraRetry: { count: 0, attempts: [] },
    };
    handler(state, {});
    assert.ok(Array.isArray(state.history), 'state.history must be initialized');
    assert.equal(state.history.length, 1, 'one telemetry entry appended');
    const entry = state.history[0];
    assert.ok(entry.timestamp, 'has timestamp');
    assert.deepEqual(entry.signals, ['signal1', 'signal2'], 'records signals');
    assert.equal(entry.decision, 'infra-suspected', 'records decision');
    assert.ok('outcome' in entry, 'has outcome key');
    // Bug 542-24: dispatched retry must flip the latest entry to 'dispatched',
    // not leave it as the default 'pending'.
    assert.equal(entry.outcome, 'dispatched', 'outcome reflects dispatched retry');
  });

  it('7.1b (Bug 542-24): outcome=succeeded recorded on retry-success', () => {
    const { handler } = loadStep({
      classifyImpl: () => ({
        classification: 'infra-suspected',
        signals: ['signal1', 'signal2'],
        evidence: {},
      }),
    });
    const state = {
      failureCategory: 'ci_failure',
      runId: '12345',
      _ciStatusFreshness: { pid: process.pid, at: new Date().toISOString() },
      history: [
        {
          timestamp: 't0',
          signals: ['signal1', 'signal2'],
          decision: 'infra-suspected',
          outcome: 'dispatched',
        },
      ],
      infraRetry: {
        count: 1,
        attempts: [
          {
            attemptNumber: 1,
            timestamp: 't0',
            runId: '12345',
            signals: ['signal1', 'signal2'],
            retryMethod: 'rerun-failed',
            outcome: 'pending',
          },
        ],
      },
    };
    handler(state, { ciStatus: 'success' });
    assert.equal(state.history[0].outcome, 'succeeded', 'history outcome updated on success');
  });

  it('7.1c (Bug 542-24): outcome=exhausted recorded when classify cap-triggers exhaust', () => {
    // Drive the cap-trigger path: count=2 going in, infra-suspected
    // classification → dispatchRetryAttempt bumps count to 3, the NEXT visit
    // hits maybeSurfaceExhausted via the classify pathway, which records the
    // exhausted outcome on the history entry just appended.
    const { handler } = loadStep({
      classifyImpl: () => ({
        classification: 'infra-suspected',
        signals: ['signal1', 'signal2'],
        evidence: {},
      }),
    });
    const state = {
      failureCategory: 'ci_failure',
      runId: '12345',
      _ciStatusFreshness: { pid: process.pid, at: new Date().toISOString() },
      infraRetry: {
        count: 2,
        attempts: [
          {
            attemptNumber: 1,
            timestamp: 't1',
            runId: '1',
            signals: [],
            retryMethod: 'rerun-failed',
            outcome: 'pending',
          },
          {
            attemptNumber: 2,
            timestamp: 't2',
            runId: '2',
            signals: [],
            retryMethod: 'rerun-failed',
            outcome: 'pending',
          },
        ],
      },
    };
    // First visit: dispatches retry #3, history gets entry with outcome=dispatched.
    handler(state, {});
    assert.equal(state.infraRetry.count, 3, 'retry #3 dispatched');
    // Second visit at count=3 + infra-suspected → maybeSurfaceExhausted fires.
    handler(state, {});
    const last = state.history[state.history.length - 1];
    assert.equal(last.outcome, 'exhausted', 'history outcome reflects exhaustion');
  });

  it('7.2: retry-success branch writes "auto-retry: infra flake confirmed" to stderr', () => {
    const { handler } = loadStep({
      classifyImpl: () => ({
        classification: 'infra-suspected',
        signals: ['signal1', 'signal2'],
        evidence: {},
      }),
    });
    // Simulate prior pending attempt; ctx signals CI green => success branch.
    const state = {
      failureCategory: 'ci_failure',
      runId: '12345',
      _ciStatusFreshness: { pid: process.pid, at: new Date().toISOString() },
      infraRetry: {
        count: 1,
        attempts: [
          {
            attemptNumber: 1,
            timestamp: '2026-01-01T00:00:00.000Z',
            runId: '12345',
            signals: ['signal1', 'signal2'],
            retryMethod: 'rerun-failed',
            outcome: 'pending',
          },
        ],
      },
    };
    const ctx = { ciStatus: 'success' };
    const stderr = captureStderr(() => handler(state, ctx));
    assert.match(
      stderr,
      /auto-retry: infra flake confirmed/,
      'stderr must contain the retry-success literal'
    );
  });

  it('7.3: signal4 across ≥2 jobs + gh actions degraded → action:surface, no retry consumed', () => {
    const { handler, ghActionsCalls } = loadStep({
      classifyImpl: () => ({
        classification: 'infra-suspected',
        signals: ['signal4'],
        // Realistic classifier shape: `signals` lists fired signals; per-signal
        // evidence holds only collector-provided fields (no redundant `fired`
        // flag). jobCount comes from the failing-jobs propagation in classify().
        evidence: { signal4: { patterns: ['cache-miss', 'fallback-install-failed'], jobCount: 2 } },
      }),
      ghActionsStatusImpl: () => ({ degraded: true }),
    });
    const state = {
      failureCategory: 'ci_failure',
      runId: '12345',
      infraRetry: { count: 0, attempts: [] },
    };
    const result = handler(state, {});
    assert.ok(result, 'handler must return an instruction');
    assert.equal(result.action, 'surface', 'short-circuits to surface');
    assert.equal(
      result.payload && result.payload.reason,
      'github-actions-outage',
      'reason indicates the outage'
    );
    assert.equal(state.infraRetry.count, 0, 'retry count NOT incremented on outage');
    assert.ok(ghActionsCalls.length >= 1, 'gh actions status was consulted');
  });
});
