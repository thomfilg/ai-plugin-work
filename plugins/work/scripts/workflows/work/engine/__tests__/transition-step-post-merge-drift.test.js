/**
 * Tests for the GH-299 check-drift gate scoping (echo-4465 issue 5).
 *
 * The drift gate redirects post-check forward transitions back to `check`
 * when HEAD moved since check passed. That is correct BEFORE merge
 * (pr/ready/follow_up/ci) but was also firing from post-merge steps
 * (cleanup → reports), where HEAD legitimately moves (merge commit / main
 * pull) — silently rewinding a COMPLETED check to in_progress and looping
 * /check2. The gate must NOT fire from cleanup or reports.
 *
 * Strategy: same DI-stub harness as transition-step-gate-fingerprint.test.js
 * — no real fs/git; getHeadSha stubbed to simulate drift.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { transitionStep } = require(path.join(__dirname, '..', 'transition-step'));

const OLD_SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);

function makeStepRegistry() {
  const STEPS = {
    ticket: 'ticket',
    implement: 'implement',
    check: 'check',
    pr: 'pr',
    ready: 'ready',
    follow_up: 'follow_up',
    ci: 'ci',
    cleanup: 'cleanup',
    reports: 'reports',
    complete: 'complete',
  };
  const ALL_STEPS = [
    STEPS.ticket,
    STEPS.implement,
    STEPS.check,
    STEPS.pr,
    STEPS.ready,
    STEPS.follow_up,
    STEPS.ci,
    STEPS.cleanup,
    STEPS.reports,
    STEPS.complete,
  ];
  const STEP_TRANSITIONS = {
    check: [STEPS.pr],
    pr: [STEPS.ready, STEPS.check],
    ready: [STEPS.follow_up, STEPS.check],
    follow_up: [STEPS.ci, STEPS.check],
    ci: [STEPS.cleanup, STEPS.check],
    cleanup: [STEPS.reports, STEPS.check],
    reports: [STEPS.complete],
  };
  return { STEPS, ALL_STEPS, STEP_TRANSITIONS };
}

function makeWs(ALL_STEPS, currentStep) {
  const stepStatus = {};
  const idx = ALL_STEPS.indexOf(currentStep);
  ALL_STEPS.forEach((s, i) => {
    stepStatus[s] = i < idx ? 'completed' : i === idx ? 'in_progress' : 'pending';
  });
  return {
    ticketId: 'GH-4465',
    currentStep: idx + 1,
    status: 'in_progress',
    stepStatus,
    checkProgress: {},
    errors: [],
    checkPassedSha: OLD_SHA,
  };
}

function makeDeps(registry, ws, savedRef) {
  const { STEPS, ALL_STEPS, STEP_TRANSITIONS } = registry;
  return {
    tp: {
      getProviderConfig: () => ({ provider: 'github' }),
      sanitizeTicketIdForPath: (id) => id,
    },
    STEPS,
    ALL_STEPS,
    STEP_TRANSITIONS,
    workflowCanTransition: (from, to) => (STEP_TRANSITIONS[from] || []).includes(to),
    TDD_GATED_STEPS: [],
    readTddEvidence: () => null,
    validateTddEvidence: () => ({ valid: true }),
    validateCheckGate: () => ({ valid: true, reasons: [], rules: [] }),
    archiveStepArtifacts: () => null,
    appendAction: () => {},
    loadWorkState: () => ws,
    saveWorkState: (_t, state) => {
      savedRef.ws = state;
    },
    getCurrentStep: (state) => {
      for (const s of ALL_STEPS) if (state.stepStatus[s] === 'in_progress') return s;
      return ALL_STEPS[0];
    },
    TASKS_BASE: '/nonexistent-tasks-base',
    softSteps: new Set(ALL_STEPS), // skip generic verify gate — drift gate is the subject
    commandMap: [],
    getHeadSha: () => NEW_SHA, // HEAD drifted vs checkPassedSha in every test
  };
}

describe('check-drift gate — post-merge scoping (echo-4465 issue 5)', () => {
  it('does NOT rewind check when transitioning cleanup → reports with HEAD drift', () => {
    const registry = makeStepRegistry();
    const ws = makeWs(registry.ALL_STEPS, 'cleanup');
    const saved = {};
    const result = transitionStep('GH-4465', 'reports', makeDeps(registry, ws, saved));

    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.to, 'reports', 'must advance to reports, not redirect to check');
    assert.equal(saved.ws.stepStatus.check, 'completed', 'completed check must stay completed');
    assert.equal(saved.ws.stepStatus.reports, 'in_progress');
  });

  it('does NOT rewind check when transitioning reports → complete with HEAD drift', () => {
    const registry = makeStepRegistry();
    const ws = makeWs(registry.ALL_STEPS, 'reports');
    const saved = {};
    const result = transitionStep('GH-4465', 'complete', makeDeps(registry, ws, saved));

    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.to, 'complete');
    assert.equal(saved.ws.stepStatus.check, 'completed');
  });

  it('STILL redirects to check from pre-merge steps (pr → ready) on HEAD drift', () => {
    const registry = makeStepRegistry();
    const ws = makeWs(registry.ALL_STEPS, 'pr');
    const saved = {};
    const result = transitionStep('GH-4465', 'ready', makeDeps(registry, ws, saved));

    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.to, 'check', 'pre-merge drift must still re-trigger check');
    assert.equal(saved.ws.checkPassedSha, null);
    assert.equal(saved.ws.checkInterruptedStep, 'pr');
  });
});
