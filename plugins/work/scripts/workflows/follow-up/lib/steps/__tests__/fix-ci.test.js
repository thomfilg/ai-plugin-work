'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

/**
 * GH-572: buildConflictBlocked's `reason` must give the FULL remediation
 * sequence (sync exposes conflicts -> resolve listed files -> push ->
 * re-run /follow-up <ticket>), interpolate the real PR number when
 * state.prNumber is set, and preserve the target-branch + conflicting-file
 * context. The returned object keeps shape { type, action: 'blocked',
 * reason, state } with no delegate (HARD STOP control flow unchanged).
 */

const handlers = Object.create(null);
function registerStep(name, fn) {
  handlers[name] = fn;
}
require('../fix-ci')(registerStep);
const fixCi = handlers['fix-ci'];

function buildBlocked(overrides) {
  const state = {
    ticketId: 'ECHO-CONF',
    prNumber: 1611,
    currentStep: 'fix-ci',
    attempt: 0,
    _isConflicting: true,
    failureCategory: 'conflict',
    _mergeStatus: {
      baseBranch: 'main',
      localConflictFiles: ['a.js', 'b.js'],
    },
    ...overrides,
  };
  return fixCi(state, {});
}

describe('GH-572 buildConflictBlocked remediation message', () => {
  it('instructs the full sync -> resolve -> push -> re-run remediation sequence', () => {
    const result = buildBlocked();
    const reason = result.reason;
    // (a) sync with the target branch
    assert.match(reason, /sync your branch with the target branch/i);
    // (b) resolve the conflicts in the listed files
    assert.match(reason, /resolve the conflicts/i);
    // (c) push
    assert.match(reason, /push/i);
    // (d) re-run /follow-up <ticket>
    assert.match(reason, /re-run \/follow-up ECHO-CONF/);
  });

  it('makes clear that syncing only EXPOSES the conflicts (no rebase-loop dead-end)', () => {
    const reason = buildBlocked().reason;
    assert.match(reason, /expos\w+ the conflicts/i);
  });

  it('interpolates the real PR number and never says #unknown when prNumber is set', () => {
    const reason = buildBlocked().reason;
    assert.match(reason, /PR #1611/);
    assert.doesNotMatch(reason, /#unknown/);
  });

  it('falls back to #unknown only when prNumber is absent', () => {
    const reason = buildBlocked({ prNumber: undefined }).reason;
    assert.match(reason, /#unknown/);
  });

  it('preserves the target branch and conflicting-file context', () => {
    const reason = buildBlocked().reason;
    assert.match(reason, /main/);
    assert.match(reason, /a\.js/);
    assert.match(reason, /b\.js/);
  });

  it('keeps the HARD STOP object shape: action blocked, no delegate', () => {
    const result = buildBlocked();
    assert.equal(result.type, 'follow_up_instruction');
    assert.equal(result.action, 'blocked');
    assert.equal(result.delegate, undefined);
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.state);
  });
});
