'use strict';

/**
 * Regression test for the Cursor-bot finding on PR #551 (GH-536):
 * `clearStaleInfraCache` only ran inside the monitor step. After an infra
 * failure, the workflow advances to `triage`, triage blocks on exitCode 2
 * without advancing past itself, and subsequent runs only re-execute
 * triage — so stale infra cache was never cleared and recovery still
 * required `--init`.
 *
 * Fix: lift the stale-cache check into the orchestrator's main loop so it
 * runs before EVERY step. When the cache is invalidated, the orchestrator
 * also rewinds `currentStep` to monitor so the workflow re-executes
 * against fresh inputs.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const ORCHESTRATOR_SRC = fs.readFileSync(require.resolve('../follow-up-next.js'), 'utf8');

describe('orchestrator auto-clears stale infra cache before any step (GH-536 PR #551 round-2)', () => {
  it('checks isInfraFailure + isStale before runStep', () => {
    assert.ok(
      /isInfraFailure\([\s\S]{0,200}?\)\s*&&\s*isStale\(/.test(ORCHESTRATOR_SRC),
      'orchestrator must check isInfraFailure + isStale before runStep'
    );
  });

  it('drops the cached monitor result and timestamp on clear', () => {
    assert.ok(
      ORCHESTRATOR_SRC.includes('delete state.lastMonitorResult'),
      'orchestrator must delete state.lastMonitorResult when stale infra cache detected'
    );
    assert.ok(
      ORCHESTRATOR_SRC.includes('delete state.lastMonitorAt'),
      'orchestrator must delete state.lastMonitorAt when stale infra cache detected'
    );
  });

  it("rewinds currentStep to literal 'monitor' on stale-infra clear", () => {
    // Hardcoded 'monitor' rather than STEPS[0] so a future reorder of the
    // step registry can't silently rewind to a different first step
    // (GH-536 PR #551 review round-3).
    assert.ok(
      /state\.currentStep\s*=\s*['"]monitor['"]/.test(ORCHESTRATOR_SRC),
      "orchestrator must rewind currentStep to the literal 'monitor' so the next iteration re-fetches"
    );
  });

  it('runs the stale-clear BEFORE runStep so triage/fix-ci/report all benefit', () => {
    const clearIdx = ORCHESTRATOR_SRC.search(/delete state\.lastMonitorResult/);
    const runStepIdx = ORCHESTRATOR_SRC.search(/runStep\(state\.currentStep/);
    assert.ok(clearIdx > 0 && runStepIdx > 0, 'both markers must be present');
    assert.ok(
      clearIdx < runStepIdx,
      'stale-clear must run BEFORE runStep so non-monitor steps also benefit'
    );
  });

  it('requires infra-patterns predicates at module load', () => {
    assert.ok(
      /require\([\s\S]{0,80}?'infra-patterns'/.test(ORCHESTRATOR_SRC) ||
        /require\([\s\S]{0,80}?"infra-patterns"/.test(ORCHESTRATOR_SRC),
      'orchestrator must import infra-patterns to share the single source of truth'
    );
  });

  it('predicate behavior is shared with monitor step (smoke check)', () => {
    const { isInfraFailure, isStale } = require('../lib/infra-patterns');
    const staleAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const freshAt = new Date(Date.now() - 5 * 1000).toISOString();
    assert.equal(
      isInfraFailure('Could not resolve to a Repository'),
      true,
      'gh-auth signature is infra-shaped'
    );
    assert.equal(isStale(staleAt), true, '5-minute-old cache is stale');
    assert.equal(isStale(freshAt), false, '5-second-old cache is fresh');
    assert.equal(
      isInfraFailure('CI: FAILING — some test broke'),
      false,
      'CI failure must not be classified as infra (cache preserved)'
    );
  });
});
