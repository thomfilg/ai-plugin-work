'use strict';

/**
 * R15 (GH-508): when CI turns green and an infra-retry attempt is still
 * pending, monitor must route to the infra-retry step so
 * maybeHandleRetrySuccess fires and the canonical
 * "auto-retry: infra flake confirmed" telemetry is emitted. When there is
 * no pending attempt, monitor must route to report (preserving the
 * normal happy-path behavior).
 *
 * Cursor review (PR #542): the previous code unconditionally routed to
 * 'report' on exitCode === 0, so the retry success path never ran in the
 * normal retry flow and R14/R15 telemetry was wrong.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  __test__: { computeNextStepOnGreen },
} = require('../lib/steps/monitor');

describe('monitor — CI green routing (R15)', () => {
  it('routes to infra-retry when last attempt outcome is pending', () => {
    const state = {
      infraRetry: {
        attempts: [{ outcome: 'pending', n: 1 }],
      },
    };
    assert.equal(computeNextStepOnGreen(state), 'infra-retry');
  });

  it('routes to report when there are no infra-retry attempts', () => {
    const state = { infraRetry: { attempts: [] } };
    assert.equal(computeNextStepOnGreen(state), 'report');
  });

  it('routes to report when infraRetry is missing entirely', () => {
    assert.equal(computeNextStepOnGreen({}), 'report');
    assert.equal(computeNextStepOnGreen(null), 'report');
    assert.equal(computeNextStepOnGreen(undefined), 'report');
  });

  it('routes to report when the last attempt already succeeded', () => {
    const state = {
      infraRetry: {
        attempts: [
          { outcome: 'pending', n: 1 },
          { outcome: 'succeeded', n: 2 },
        ],
      },
    };
    assert.equal(computeNextStepOnGreen(state), 'report');
  });

  it('routes to report when the last attempt failed', () => {
    const state = {
      infraRetry: {
        attempts: [{ outcome: 'failed', n: 1 }],
      },
    };
    assert.equal(computeNextStepOnGreen(state), 'report');
  });
});
