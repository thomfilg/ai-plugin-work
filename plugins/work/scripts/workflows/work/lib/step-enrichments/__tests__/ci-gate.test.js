'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Stub pr-mergeable BEFORE ci-gate loads so we can drive its decisions.
// hasActionableBlockers is the real helper — we want the gate to exercise
// its actual filter/guard logic, only assessMergeable's result is stubbed.
const prMergeablePath = require.resolve('../../pr-mergeable.js');
const realPrMergeable = require('../../pr-mergeable.js');
let stubMergeable;
require.cache[prMergeablePath] = {
  id: prMergeablePath,
  filename: prMergeablePath,
  loaded: true,
  exports: {
    assessMergeable() {
      return stubMergeable;
    },
    classify() {
      return stubMergeable;
    },
    hasActionableBlockers: realPrMergeable.hasActionableBlockers,
  },
};

// Stub follow-up-pr (only getPRInfo is called by ci-gate).
let stubPrInfo;
const workDir = path.resolve(__dirname, '..', '..', '..');
const followUpPrPath = path.join(workDir, 'scripts', 'follow-up-pr.js');
require.cache[followUpPrPath] = {
  id: followUpPrPath,
  filename: followUpPrPath,
  loaded: true,
  exports: {
    getPRInfo() {
      return stubPrInfo;
    },
  },
};

// Now load ci-gate.
const { dispatchAdvanceGate } = require('../ci-gate');
const { ALL_STEPS } = require(path.join(workDir, 'step-registry'));

function makeDeps() {
  const states = new Map();
  return {
    workDir,
    loadWorkState(name) {
      return states.has(name)
        ? JSON.parse(JSON.stringify(states.get(name)))
        : {
            stepStatus: {},
          };
    },
    saveWorkState(name, ws) {
      states.set(name, JSON.parse(JSON.stringify(ws)));
    },
    _states: states,
    recursionDepth: 0,
    log: { recurse: () => {} },
  };
}

test('advances ci → cleanup when PR is mergeable AND merged', () => {
  stubPrInfo = { number: 1, state: 'MERGED' };
  stubMergeable = { mergeable: true, blockers: [], signals: {} };
  const deps = makeDeps();
  deps.saveWorkState('TICK', { stepStatus: { ci: 'in_progress' } });
  const r = dispatchAdvanceGate('TICK', {}, deps);
  assert.deepEqual(r, { recurse: true });
  const ws = deps._states.get('TICK');
  assert.equal(ws.stepStatus.ci, 'completed');
  assert.equal(ws.stepStatus.cleanup, 'in_progress');
  assert.equal(ws.currentStep, ALL_STEPS.indexOf('cleanup') + 1);
});

test('rolls back ci → follow_up when PR is OPEN and not mergeable', () => {
  // Case where the PR was waiting at ci, then a new conflict / failing check
  // arrived. ci can't wait for merge that's no longer possible — bounce back
  // to follow_up so it can fix the new problem.
  stubPrInfo = { number: 2, state: 'OPEN' };
  stubMergeable = {
    mergeable: false,
    blockers: [{ kind: 'merge_state_dirty', detail: 'merge conflicts' }],
    signals: {},
  };
  const deps = makeDeps();
  deps.saveWorkState('TICK2', { stepStatus: { ci: 'in_progress' } });
  const r = dispatchAdvanceGate('TICK2', {}, deps);
  assert.deepEqual(r, { recurse: true });
  const ws = deps._states.get('TICK2');
  assert.equal(ws.stepStatus.ci, 'in_progress');
  assert.equal(ws.stepStatus.follow_up, 'in_progress');
  assert.equal(ws.currentStep, ALL_STEPS.indexOf('follow_up') + 1);
});

test('does NOT roll back when PR is MERGED but not (yet) mergeable per predicate', () => {
  // Edge case: predicate says not mergeable (e.g. UNKNOWN merge state on a
  // merged PR — GitHub sometimes reports this transiently). Don't loop;
  // just don't advance. The next tick can retry.
  stubPrInfo = { number: 3, state: 'MERGED' };
  stubMergeable = {
    mergeable: false,
    blockers: [{ kind: 'merge_state_unknown', detail: '' }],
    signals: {},
  };
  const deps = makeDeps();
  deps.saveWorkState('TICK3', { stepStatus: { ci: 'in_progress' } });
  const r = dispatchAdvanceGate('TICK3', {}, deps);
  assert.equal(r, null);
  const ws = deps._states.get('TICK3');
  assert.equal(ws.stepStatus.ci, 'in_progress');
});

test('does NOT roll back when PR is CLOSED-not-merged (terminal failure mode)', () => {
  // A CLOSED PR that isn't merged is a separate failure case (manual
  // abandonment, force-closed, etc.). The follow-up enrichment handles
  // that path; ci-gate stays quiet.
  stubPrInfo = { number: 4, state: 'CLOSED' };
  stubMergeable = {
    mergeable: false,
    blockers: [{ kind: 'merge_state_dirty', detail: '' }],
    signals: {},
  };
  const deps = makeDeps();
  deps.saveWorkState('TICK4', { stepStatus: { ci: 'in_progress' } });
  const r = dispatchAdvanceGate('TICK4', {}, deps);
  assert.equal(r, null);
});

test('no-ops when PR has no number', () => {
  stubPrInfo = null;
  const deps = makeDeps();
  const r = dispatchAdvanceGate('TICK5', {}, deps);
  assert.equal(r, null);
});

test('does NOT roll back when the only blocker is a transient gh_error (network blip)', () => {
  // Regression: assessMergeable catches `gh` CLI failures and reports them
  // as `{kind: 'gh_error'}`. That's "we couldn't verify", not "we verified
  // it's broken". Rolling back the workflow on a transient blip would
  // discard real progress. Only concrete blockers (merge_state_*,
  // checks_running) should trigger the backward edge.
  stubPrInfo = { number: 7, state: 'OPEN' };
  stubMergeable = {
    mergeable: false,
    blockers: [{ kind: 'gh_error', detail: 'gh pr view failed: timeout' }],
    signals: {},
  };
  const deps = makeDeps();
  deps.saveWorkState('TICK7', { stepStatus: { ci: 'in_progress' } });
  const r = dispatchAdvanceGate('TICK7', {}, deps);
  assert.equal(r, null, 'expected no-op on transient gh_error');
  const ws = deps._states.get('TICK7');
  assert.equal(ws.stepStatus.ci, 'in_progress');
  assert.equal(ws.stepStatus.follow_up, undefined);
});

test('DOES roll back when blockers include both gh_error AND a real blocker', () => {
  // gh_error alone is transient; gh_error + merge_state_dirty means we
  // partially verified — the real blocker still applies.
  stubPrInfo = { number: 8, state: 'OPEN' };
  stubMergeable = {
    mergeable: false,
    blockers: [
      { kind: 'gh_error', detail: 'one call failed' },
      { kind: 'merge_state_dirty', detail: 'conflicts' },
    ],
    signals: {},
  };
  const deps = makeDeps();
  deps.saveWorkState('TICK8', { stepStatus: { ci: 'in_progress' } });
  const r = dispatchAdvanceGate('TICK8', {}, deps);
  assert.deepEqual(r, { recurse: true });
  const ws = deps._states.get('TICK8');
  assert.equal(ws.stepStatus.follow_up, 'in_progress');
});

test('mergeable but PR still OPEN → no advance (waiting for merge), no rollback', () => {
  // The happy path while waiting at ci. Don't advance to cleanup yet;
  // don't roll back because nothing is wrong. Just wait.
  stubPrInfo = { number: 6, state: 'OPEN' };
  stubMergeable = { mergeable: true, blockers: [], signals: {} };
  const deps = makeDeps();
  deps.saveWorkState('TICK6', { stepStatus: { ci: 'in_progress' } });
  const r = dispatchAdvanceGate('TICK6', {}, deps);
  assert.equal(r, null);
  const ws = deps._states.get('TICK6');
  assert.equal(ws.stepStatus.ci, 'in_progress');
});
