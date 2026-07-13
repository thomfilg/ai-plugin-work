'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const followUpNext = require('../follow-up-next');

describe('follow-up-next.initState', () => {
  it('exposes initState via the __test__ escape hatch', () => {
    assert.ok(followUpNext.__test__, 'expected follow-up-next.js to expose a __test__ object');
    assert.equal(
      typeof followUpNext.__test__.initState,
      'function',
      'expected __test__.initState to be a function'
    );
  });

  it('initial state contains lastMonitorResult: null AND lastMonitorAt: null', () => {
    const { initState } = followUpNext.__test__;
    const state = initState('GH-536', 42);

    assert.equal(
      state.lastMonitorResult,
      null,
      'expected lastMonitorResult to be null on fresh state'
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(state, 'lastMonitorAt'),
      'expected initState() output to declare a lastMonitorAt property'
    );
    assert.equal(state.lastMonitorAt, null, 'expected lastMonitorAt to be null on fresh state');
  });
});
