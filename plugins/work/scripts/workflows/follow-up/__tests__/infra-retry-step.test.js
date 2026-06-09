'use strict';

/**
 * Tests for the infra-retry step handler.
 *
 * Short-circuit / bypass cases:
 *  1. failureCategory='conflict' → return null, no classify.
 *  2. failureCategory='review_failure' → return null, no classify.
 *  3. classify() returns 'code-failure' → return null.
 *
 * Note: the WORK_AUTO_RETRY_INFRA opt-in flag was removed (GH-508 design
 * decision). Auto-retry is always on, gated by signal floor + retry cap +
 * exhaustion surface.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Resolve target modules so we can patch them via the require cache.
const STEP_PATH = require.resolve('../lib/steps/infra-retry');
const CLASSIFIER_PATH = require.resolve('../lib/infra-classifier');
const GET_CONFIG_PATH = require.resolve(path.resolve(__dirname, '..', '..', 'lib', 'get-config'));

function loadStep({ classifyImpl } = {}) {
  // Clear caches so each test gets a fresh module wired to fresh mocks.
  delete require.cache[STEP_PATH];
  delete require.cache[CLASSIFIER_PATH];
  delete require.cache[GET_CONFIG_PATH];

  const classifyCalls = [];
  const classify = (...args) => {
    classifyCalls.push(args);
    return classifyImpl
      ? classifyImpl(...args)
      : { classification: 'code-failure', signals: [], evidence: {} };
  };

  // Patch the infra-classifier module via cache injection.
  require.cache[CLASSIFIER_PATH] = {
    id: CLASSIFIER_PATH,
    filename: CLASSIFIER_PATH,
    loaded: true,
    exports: { classify, __test__: {} },
  };

  // Stub get-config — opt-in flag was removed, only WORK_INFRA_RETRY_FALLBACK
  // remains (defaulted via undefined).
  require.cache[GET_CONFIG_PATH] = {
    id: GET_CONFIG_PATH,
    filename: GET_CONFIG_PATH,
    loaded: true,
    exports: () => undefined,
  };

  const stepModule = require(STEP_PATH);
  const handlers = Object.create(null);
  const register = (name, fn) => {
    handlers[name] = fn;
  };
  stepModule(register);
  return { handler: handlers['infra-retry'], classifyCalls };
}

describe('infra-retry step — short-circuits and bypasses', () => {
  it('case 1: failureCategory=conflict → returns null and never calls classify', () => {
    const { handler, classifyCalls } = loadStep();
    const state = { failureCategory: 'conflict' };
    const result = handler(state, {});
    assert.equal(result, null);
    assert.equal(classifyCalls.length, 0, 'merge conflicts bypass classifier entirely');
  });

  it('case 2: failureCategory=review_failure → returns null and never calls classify', () => {
    const { handler, classifyCalls } = loadStep();
    const state = { failureCategory: 'review_failure' };
    const result = handler(state, {});
    assert.equal(result, null);
    assert.equal(classifyCalls.length, 0, 'review failures bypass classifier entirely');
  });

  it('case 3: classify returns code-failure → returns null (no retry dispatched)', () => {
    const { handler, classifyCalls } = loadStep({
      classifyImpl: () => ({ classification: 'code-failure', signals: [], evidence: {} }),
    });
    const state = {
      failureCategory: 'ci_failure',
      runId: '12345',
      infraRetry: { count: 0, attempts: [] },
    };
    const result = handler(state, {});
    assert.equal(result, null);
    assert.equal(classifyCalls.length, 1, 'classifier must be consulted exactly once');
  });
});

describe('infra-retry step — retry state machine (R2/R3/R4)', () => {
  const infraSuspected = () => ({
    classification: 'infra-suspected',
    signals: ['signal1', 'signal2'],
    evidence: { signal1: {}, signal2: {}, signal3: {}, signal4: { jobCount: 0 } },
  });

  it('case 5: attempt 0 → 1 — records attempt, currentStep=monitor, delegate calls `gh run rerun <id> --failed`', () => {
    const { handler } = loadStep({ classifyImpl: infraSuspected });
    const state = {
      ticketId: 'GH-508',
      failureCategory: 'ci_failure',
      runId: '12345',
      infraRetry: { count: 0, attempts: [] },
    };
    const result = handler(state, {});
    assert.ok(result, 'expected a delegate instruction');
    assert.equal(result.action, 'execute', 'dispatches delegate');
    assert.equal(state.infraRetry.count, 1, 'count incremented');
    assert.equal(state.infraRetry.attempts.length, 1, 'one attempt recorded');
    assert.equal(state.infraRetry.attempts[0].attemptNumber, 1);
    assert.equal(state.infraRetry.attempts[0].runId, '12345');
    assert.equal(state.infraRetry.attempts[0].retryMethod, 'rerun-failed');
    assert.equal(state.infraRetry.attempts[0].outcome, 'pending');
    assert.ok(state.infraRetry.attempts[0].timestamp, 'attempt has timestamp');
    assert.equal(state.currentStep, 'monitor', 'loops back to monitor');
    assert.match(
      result.delegate && result.delegate.command,
      /gh run rerun 12345 --failed/,
      'delegate runs `gh run rerun --failed <runId>`'
    );
  });

  it('case 6: attempt 1 → 2', () => {
    const { handler } = loadStep({ classifyImpl: infraSuspected });
    const state = {
      ticketId: 'GH-508',
      failureCategory: 'ci_failure',
      runId: '22222',
      _ciStatusFreshness: { pid: process.pid, at: new Date().toISOString() },
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
    const result = handler(state, {});
    assert.ok(result);
    assert.equal(state.infraRetry.count, 2);
    assert.equal(state.infraRetry.attempts.length, 2);
    assert.equal(state.infraRetry.attempts[1].attemptNumber, 2);
    assert.equal(state.currentStep, 'monitor');
  });

  it('case 7: attempt 2 → 3', () => {
    const { handler } = loadStep({ classifyImpl: infraSuspected });
    const state = {
      ticketId: 'GH-508',
      failureCategory: 'ci_failure',
      runId: '33333',
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
    const result = handler(state, {});
    assert.ok(result);
    assert.equal(state.infraRetry.count, 3);
    assert.equal(state.infraRetry.attempts.length, 3);
    assert.equal(state.infraRetry.attempts[2].attemptNumber, 3);
  });

  it('case 8: attempt 3 → exhausted (surface + failureCategory=infra-stuck, no fix-ci)', () => {
    const { handler } = loadStep({ classifyImpl: infraSuspected });
    const state = {
      ticketId: 'GH-508',
      failureCategory: 'ci_failure',
      runId: '44444',
      _ciStatusFreshness: { pid: process.pid, at: new Date().toISOString() },
      infraRetry: {
        count: 3,
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
          {
            attemptNumber: 3,
            timestamp: 't3',
            runId: '3',
            signals: [],
            retryMethod: 'rerun-failed',
            outcome: 'pending',
          },
        ],
      },
    };
    const result = handler(state, {});
    assert.ok(result, 'must surface');
    assert.equal(result.action, 'surface');
    assert.equal(state.failureCategory, 'infra-stuck', 'failureCategory updated');
    assert.equal(state.infraRetry.exhausted, true, 'exhausted flag set');
    assert.equal(state.infraRetry.count, 3, 'count NOT incremented past the cap');
    assert.equal(state.infraRetry.attempts.length, 3, 'no new attempt appended');
    // Bug D+E (GH-508): surface payload now nests reason under .payload to
    // match the auto-advance hook contract, and reason is 'infra-stuck' so
    // report.js fires the diagnostic bundle.
    assert.equal(result.payload && result.payload.reason, 'infra-stuck');
    assert.notEqual(result.action, 'execute', 'fix-ci must NOT be dispatched on infra-stuck');
  });

  it('case 9b (Bug 542-28): retry-success clears ci_cancelled_blocking too, not just ci_failure', () => {
    // triage.js routes both `ci_failure` and `ci_cancelled_blocking` to
    // infra-retry. The post-success category clear must cover both, otherwise
    // report.js refuses to mark complete and surfaces the stale category.
    const { handler } = loadStep({ classifyImpl: infraSuspected });
    const state = {
      ticketId: 'GH-508',
      failureCategory: 'ci_cancelled_blocking',
      runId: '99999',
      _ciStatusFreshness: { pid: process.pid, at: new Date().toISOString() },
      infraRetry: {
        count: 1,
        attempts: [
          {
            attemptNumber: 1,
            timestamp: 't0',
            runId: '88888',
            signals: ['signal1', 'signal2'],
            retryMethod: 'rerun-failed',
            outcome: 'pending',
          },
        ],
      },
    };
    handler(state, { ciStatus: 'success' });
    assert.equal(state.currentStep, 'report', 'routed to report on success');
    assert.equal(
      state.failureCategory,
      null,
      'ci_cancelled_blocking must be cleared so report marks complete'
    );
  });

  it('case 5d (Bug 542-26): closes prior pending attempt as failed before dispatching the next retry', () => {
    // After retry #1 the attempt is pending. If monitor reports CI still
    // failing and infra-suspected re-fires, the next dispatch must close the
    // prior pending entry (outcome=failed) so per-retry verdicts aren\'t lost.
    const { handler } = loadStep({ classifyImpl: infraSuspected });
    const state = {
      ticketId: 'GH-508',
      failureCategory: 'ci_failure',
      runId: '22222',
      _ciStatusFreshness: { pid: process.pid, at: new Date().toISOString() },
      infraRetry: {
        count: 1,
        attempts: [
          {
            attemptNumber: 1,
            timestamp: 't1',
            runId: '11111',
            signals: ['signal1', 'signal2'],
            retryMethod: 'rerun-failed',
            outcome: 'pending',
          },
        ],
      },
    };
    const result = handler(state, {}); // ctx.ciStatus undefined → not success
    assert.ok(result, 'dispatches retry #2');
    assert.equal(result.action, 'execute');
    assert.equal(state.infraRetry.count, 2);
    assert.equal(state.infraRetry.attempts.length, 2);
    assert.equal(
      state.infraRetry.attempts[0].outcome,
      'failed',
      'prior pending attempt closed as failed'
    );
    assert.equal(state.infraRetry.attempts[1].outcome, 'pending', 'new attempt is pending');
  });

  it('case 5c: missing runId → returns null (orchestrator advances), does NOT throw', () => {
    // Bug 542-22: a missing/non-numeric runId used to throw TypeError out of
    // buildRetryDelegate. The follow-up loop had no catch, so the whole
    // workflow aborted. Now the step returns null and the orchestrator
    // advances to fix-ci.
    const { handler } = loadStep({ classifyImpl: infraSuspected });
    const state = {
      ticketId: 'GH-508',
      failureCategory: 'ci_failure',
      _ciFailedJobs: [{ name: 'e2e [shard-4]' }], // no runId
      infraRetry: { count: 0, attempts: [] },
    };
    let result;
    assert.doesNotThrow(() => {
      result = handler(state, {});
    });
    assert.equal(result, null, 'must return null to let orchestrator advance');
    assert.equal(state.infraRetry.count, 0, 'retry count NOT consumed');
    assert.equal(state.infraRetry.attempts.length, 0, 'no attempt recorded');
  });

  it('case 5b: derives runId from state._ciFailedJobs[0].runId when state.runId is unset', () => {
    const { handler } = loadStep({ classifyImpl: infraSuspected });
    const state = {
      ticketId: 'GH-508',
      failureCategory: 'ci_failure',
      // NOTE: no state.runId — monitor.js stores runIds on _ciFailedJobs only.
      _ciFailedJobs: [{ name: 'e2e [shard-4]', runId: '987654' }],
      infraRetry: { count: 0, attempts: [] },
    };
    const result = handler(state, {});
    assert.ok(result, 'must dispatch a retry delegate');
    assert.equal(result.action, 'execute');
    assert.match(
      result.delegate && result.delegate.command,
      /gh run rerun 987654 --failed/,
      'delegate must use runId from _ciFailedJobs[0]'
    );
    assert.equal(state.infraRetry.attempts[0].runId, '987654');
  });

  it('case 9: prior retry succeeded → marks last attempt outcome=succeeded and advances normally', () => {
    const { handler, classifyCalls } = loadStep({ classifyImpl: infraSuspected });
    const state = {
      ticketId: 'GH-508',
      failureCategory: 'ci_failure',
      runId: '55555',
      _ciStatusFreshness: { pid: process.pid, at: new Date().toISOString() },
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
    const result = handler(state, { ciStatus: 'success' });
    assert.equal(result, null, 'success branch returns null (advance normally)');
    assert.equal(
      state.infraRetry.attempts[0].outcome,
      'succeeded',
      'last attempt marked succeeded'
    );
    assert.equal(
      classifyCalls.length,
      0,
      'retry-success short-circuit must NOT consult classifier again'
    );
    assert.equal(
      state.currentStep,
      'report',
      'retry-success routes directly to report (not fix-ci)'
    );
    assert.notEqual(
      state.failureCategory,
      'ci_failure',
      'stale ci_failure category cleared so fix-ci does not fire'
    );
  });
});
