'use strict';

/**
 * Bug B (GH-508): monitor.js must populate state._ciAllJobs, _ciFailedLogs,
 * and _ciStatus so the infra-classifier has the production context it
 * expects. Before this fix only `_ciFailedJobs` was set and the classifier
 * received empty arrays for the three sibling fields.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  __test__: { mapCiStatus },
} = require('../lib/steps/monitor');

describe('monitor — classifier ctx (Bug B)', () => {
  it('mapCiStatus translates passing → success', () => {
    assert.equal(mapCiStatus('passing'), 'success');
  });
  it('mapCiStatus translates no-checks → success', () => {
    assert.equal(mapCiStatus('no-checks'), 'success');
  });
  it('mapCiStatus translates failing → failure', () => {
    assert.equal(mapCiStatus('failing'), 'failure');
  });
  it('mapCiStatus translates pending → in_progress', () => {
    assert.equal(mapCiStatus('pending'), 'in_progress');
  });
  it('mapCiStatus translates unknown / undefined → in_progress', () => {
    assert.equal(mapCiStatus(undefined), 'in_progress');
    assert.equal(mapCiStatus('whatever'), 'in_progress');
  });
});
