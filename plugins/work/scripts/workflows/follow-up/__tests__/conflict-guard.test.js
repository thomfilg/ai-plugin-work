'use strict';

// Skip delays in tests
process.env.FOLLOW_UP2_NO_DELAY = '1';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Regression: follow-up must NOT declare a PR "complete" while merge
 * conflicts remain. ECHO-4611 ended with status=complete despite the
 * monitor output containing "CONFLICTS: Merge conflicts detected".
 *
 * Two safety nets exercised here:
 *   1. monitor.js — exitCode 0 only when mergeable is not CONFLICTING/DIRTY
 *      (covered indirectly via the report.js test below; direct unit test of
 *      monitor.js would need to stub gh/git which is out of scope here).
 *   2. report.js — must route back to fix-ci when lastMonitorResult.output
 *      still contains a "merge conflict" marker, even on entry to report.
 */

const handlers = Object.create(null);
function registerStep(name, fn) {
  handlers[name] = fn;
}
require('../lib/steps/report')(registerStep);
const report = handlers['report'];

function makeCtx() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'followup-report-'));
  return { tmp, ctx: { tasksDir: tmp } };
}

describe('report step: conflict safety net', () => {
  it('refuses to complete when monitor output still shows a merge conflict', () => {
    const { tmp, ctx } = makeCtx();
    try {
      const state = {
        ticketId: 'ECHO-CONF',
        prNumber: 1586,
        currentStep: 'report',
        attempt: 1,
        lastMonitorResult: {
          exitCode: 0,
          output:
            'CI: PASSED (all 31 checks)\nCONFLICTS: Merge conflicts detected — rebase required\nReviews: CLEAR',
        },
      };
      const result = report(state, ctx);
      assert.equal(
        result,
        null,
        'report must not return complete-instruction when conflict still present'
      );
      assert.equal(state.currentStep, 'fix-ci');
      assert.equal(state.failureCategory, 'conflict');
      // review-accountability.json must NOT have been written
      assert.equal(fs.existsSync(path.join(tmp, 'review-accountability.json')), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('completes normally when monitor output is clear of conflicts', () => {
    const { tmp, ctx } = makeCtx();
    try {
      const state = {
        ticketId: 'ECHO-OK',
        prNumber: 1234,
        currentStep: 'report',
        attempt: 1,
        lastMonitorResult: {
          exitCode: 0,
          output: 'CI: PASSED (all 31 checks)\nReviews: CLEAR',
        },
      };
      const result = report(state, ctx);
      assert.ok(result, 'report must return a complete-instruction in the happy path');
      assert.equal(result.action, 'complete');
      assert.equal(state.status, 'complete');
      assert.equal(fs.existsSync(path.join(tmp, 'review-accountability.json')), true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('also catches "cannot be merged" phrasing', () => {
    const { tmp, ctx } = makeCtx();
    try {
      const state = {
        ticketId: 'ECHO-CONF2',
        prNumber: 4242,
        currentStep: 'report',
        attempt: 1,
        lastMonitorResult: {
          exitCode: 0,
          output: 'PR cannot be merged. Branch is out of date with the base branch.',
        },
      };
      const result = report(state, ctx);
      assert.equal(result, null);
      assert.equal(state.currentStep, 'fix-ci');
      assert.equal(state.failureCategory, 'conflict');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
