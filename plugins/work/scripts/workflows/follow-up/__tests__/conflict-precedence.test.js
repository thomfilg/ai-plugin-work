'use strict';

// Skip delays in tests
process.env.FOLLOW_UP2_NO_DELAY = '1';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Regression: a merge conflict on the PR must preempt EVERYTHING else in
 * /follow-up. The structured signal `state._isConflicting` (set by
 * monitor.js with a bounded UNKNOWN retry) carries the truth across all
 * steps, so triage, fix-reviews, and report all route to fix-ci when it
 * is true — independent of whether `lastMonitorResult.output` happens to
 * contain a literal "merge conflict" string.
 *
 * Observed failure mode (ECHO-4577): monitor's first cycle saw
 * `mergeable: UNKNOWN` (GitHub mid-recompute after a sibling merge),
 * formatReport didn't emit the CONFLICTS line, triage routed to
 * fix-reviews, agent paused on a blocked "review skipped" instruction
 * while the real blocker was a conflict in app/api/trpc/routers/explore.ts.
 */

const handlers = Object.create(null);
function registerStep(name, fn) {
  handlers[name] = fn;
}
require('../lib/steps/triage')(registerStep);
require('../lib/steps/fix-reviews')(registerStep);
require('../lib/steps/report')(registerStep);
require('../lib/steps/fix-ci')(registerStep);
const triage = handlers['triage'];
const fixReviews = handlers['fix-reviews'];
const report = handlers['report'];
const fixCi = handlers['fix-ci'];

function makeCtx() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-conflict-'));
  return {
    tmp,
    ctx: {
      tasksDir: tmp,
      worktreeDir: tmp,
      workScriptsDir: '/no/such/path',
    },
  };
}

describe('follow-up: merge conflict has absolute precedence', () => {
  it('triage routes to fix-ci on _isConflicting EVEN WHEN output has no conflict text', () => {
    const state = {
      ticketId: 'ECHO-CONF',
      prNumber: 1611,
      currentStep: 'triage',
      attempt: 0,
      _isConflicting: true,
      lastMonitorResult: {
        exitCode: 1,
        output: 'CI: PASSED (all 5 checks)\nReviews: 1 BLOCKING\n  ✗ @cursor[bot] some comment',
      },
      failureCategory: null,
    };
    const result = triage(state, {});
    assert.equal(result, null);
    assert.equal(state.failureCategory, 'conflict');
    assert.equal(state.currentStep, 'fix-ci');
  });

  it('triage prefers conflict over blocking reviews when both signaled', () => {
    const state = {
      ticketId: 'ECHO-CONF',
      prNumber: 1611,
      currentStep: 'triage',
      attempt: 0,
      _isConflicting: true,
      lastMonitorResult: {
        exitCode: 1,
        output:
          'CI: PASSED\nCONFLICTS: Merge conflicts detected\nReviews: 1 BLOCKING\n  ✗ @cursor[bot]',
      },
      failureCategory: null,
    };
    triage(state, {});
    assert.equal(state.currentStep, 'fix-ci');
    assert.equal(state.failureCategory, 'conflict');
  });

  it('fix-reviews refuses to dispatch when _isConflicting; reroutes to fix-ci', () => {
    const { tmp, ctx } = makeCtx();
    try {
      const state = {
        ticketId: 'ECHO-CONF',
        prNumber: 1611,
        currentStep: 'fix-reviews',
        _isConflicting: true,
      };
      const result = fixReviews(state, ctx);
      // null = no instruction emitted, currentStep was redirected
      assert.equal(result, null);
      assert.equal(state.currentStep, 'fix-ci');
      assert.equal(state.failureCategory, 'conflict');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('fix-reviews proceeds normally when _isConflicting is false (would dispatch snapshot)', () => {
    const { tmp, ctx } = makeCtx();
    try {
      const state = {
        ticketId: 'ECHO-OK',
        prNumber: 1234,
        currentStep: 'fix-reviews',
        _isConflicting: false,
      };
      // The snapshot subprocess will fail (workScriptsDir doesn't exist),
      // but the important assertion is that we got PAST the conflict guard.
      const result = fixReviews(state, ctx);
      // Expect either a blocked snapshot-failure instruction or a comment-fetch attempt,
      // but never the conflict re-route.
      assert.notEqual(state.currentStep, 'fix-ci');
      assert.notEqual(state.failureCategory, 'conflict');
      // result is whatever fix-reviews dispatched; either an instruction or null,
      // not the conflict-reroute (which would return null + currentStep='fix-ci').
      if (result && result.reason) {
        assert.ok(typeof result.reason === 'string');
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('fix-ci HARD STOPS with a blocked instruction when conflicted (no auto-rebase dispatch)', () => {
    const { tmp, ctx } = makeCtx();
    try {
      const state = {
        ticketId: 'ECHO-CONF',
        prNumber: 1611,
        currentStep: 'fix-ci',
        attempt: 0,
        _isConflicting: true,
        failureCategory: 'conflict',
      };
      const result = fixCi(state, ctx);
      assert.ok(result, 'fix-ci must return an instruction when conflicted');
      assert.equal(result.action, 'blocked');
      assert.match(result.reason, /Merge conflicts found/i);
      assert.match(result.reason, /sync your branch/i);
      assert.match(result.reason, /#1611/);
      // Crucially: no delegate. The agent does NOT get an auto-rebase dispatch.
      assert.equal(result.delegate, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('report routes to fix-ci on _isConflicting even when output is clear', () => {
    const { tmp, ctx } = makeCtx();
    try {
      const state = {
        ticketId: 'ECHO-CONF',
        prNumber: 1611,
        currentStep: 'report',
        _isConflicting: true,
        lastMonitorResult: {
          exitCode: 0,
          output: 'CI: PASSED (all 31 checks)\nReviews: CLEAR',
        },
      };
      const result = report(state, ctx);
      assert.equal(result, null);
      assert.equal(state.currentStep, 'fix-ci');
      assert.equal(state.failureCategory, 'conflict');
      // No accountability report when we bail back to fix-ci
      assert.equal(fs.existsSync(path.join(tmp, 'review-accountability.json')), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
