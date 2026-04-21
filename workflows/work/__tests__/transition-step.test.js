/**
 * Tests for transition-step.js (GH-245 Task 4)
 *
 * Verifies that forward transitions log "step deferred" in the audit trail
 * for intermediate steps (status remains "completed" for backward compat).
 *
 * Uses node:test + node:assert/strict.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Minimal deps stub for transitionStep
function createDeps(overrides = {}) {
  const { STEPS, ALL_STEPS, STEP_TRANSITIONS, workflowCanTransition } = require('../step-registry');

  const actions = [];
  const savedStates = {};

  return {
    tp: {
      getProviderConfig: () => ({ provider: 'github', projectKey: 'GH' }),
      sanitizeTicketIdForPath: (id) => id,
    },
    STEPS,
    ALL_STEPS,
    STEP_TRANSITIONS,
    workflowCanTransition,
    TDD_GATED_STEPS: [],
    readTddEvidence: () => ({ exists: true, evidence: {} }),
    validateTddEvidence: () => ({ valid: true }),
    validateCheckGate: () => ({ valid: true }),
    archiveStepArtifacts: () => null,
    appendAction: (_ticket, action) => {
      actions.push(action);
    },
    loadWorkState: (ticket) => {
      if (savedStates[ticket]) return savedStates[ticket];
      // Return a basic in_progress state at the given step
      const stepStatus = {};
      ALL_STEPS.forEach((s) => { stepStatus[s] = 'pending'; });
      stepStatus[ALL_STEPS[0]] = 'in_progress';
      return {
        ticketId: ticket,
        currentStep: 1,
        status: 'in_progress',
        stepStatus,
        checkProgress: {},
        errors: [],
        startTime: new Date().toISOString(),
        lastUpdate: new Date().toISOString(),
      };
    },
    saveWorkState: (ticket, state) => {
      savedStates[ticket] = state;
    },
    getCurrentStep: (ws) => {
      if (!ws) return ALL_STEPS[0];
      return ALL_STEPS[(ws.currentStep || 1) - 1] || ALL_STEPS[0];
    },
    TASKS_BASE: '/tmp/fake-tasks-base',
    // expose for assertions
    _actions: actions,
    _savedStates: savedStates,
    ...overrides,
  };
}

describe('transition-step.js (GH-245 Task 4)', () => {
  describe('forward transition logs "step deferred" for intermediate steps', () => {
    it('should mark intermediate step status as "completed" and log "step deferred" in audit', () => {
      const { transitionStep } = require('../transition-step');
      const { ALL_STEPS } = require('../step-registry');

      // Set up state at 'ticket' (index 0), transition to 'brief' (index 2)
      // This should mark 'bootstrap' (index 1) as completed but log 'step deferred'
      const deps = createDeps();

      // State at ticket step (currentStep = 1)
      const ws = deps.loadWorkState('TEST-FWD-001');
      ws.stepStatus.ticket = 'in_progress';
      deps._savedStates['TEST-FWD-001'] = ws;

      // Override workflowCanTransition to allow the jump for testing
      deps.workflowCanTransition = () => true;

      const result = transitionStep('TEST-FWD-001', 'brief', deps);
      assert.equal(result.success, true, 'Transition should succeed');

      const saved = deps._savedStates['TEST-FWD-001'];
      // bootstrap (index 1) keeps 'completed' status for backward compat
      assert.equal(
        saved.stepStatus.bootstrap,
        'completed',
        'Intermediate step "bootstrap" should be marked as "completed" for backward compat'
      );

      // but audit log says 'step deferred' (not 'step skipped')
      const deferredActions = deps._actions.filter(
        (a) => a.step === 'bootstrap' && a.what === 'step deferred'
      );
      assert.equal(deferredActions.length, 1, 'Should log "step deferred" in audit');
    });

    it('should log "step deferred" in actions for intermediate steps', () => {
      const { transitionStep } = require('../transition-step');

      const deps = createDeps();
      const ws = deps.loadWorkState('TEST-FWD-002');
      ws.stepStatus.ticket = 'in_progress';
      deps._savedStates['TEST-FWD-002'] = ws;
      deps.workflowCanTransition = () => true;

      transitionStep('TEST-FWD-002', 'brief', deps);

      // Find actions for bootstrap (intermediate step)
      const deferredActions = deps._actions.filter(
        (a) => a.step === 'bootstrap' && a.what === 'step deferred'
      );
      assert.equal(
        deferredActions.length,
        1,
        'Should log exactly one "step deferred" action for intermediate step "bootstrap"'
      );

      // Should NOT have "step skipped" actions
      const skippedActions = deps._actions.filter(
        (a) => a.what === 'step skipped'
      );
      assert.equal(
        skippedActions.length,
        0,
        'Should NOT log any "step skipped" actions'
      );
    });

    it('should mark multiple intermediate steps as "completed" and log "step deferred" when jumping', () => {
      const { transitionStep } = require('../transition-step');

      const deps = createDeps();
      const ws = deps.loadWorkState('TEST-FWD-003');
      ws.stepStatus.ticket = 'in_progress';
      deps._savedStates['TEST-FWD-003'] = ws;
      deps.workflowCanTransition = () => true;

      // Jump from ticket (0) to spec (4) -- should defer bootstrap(1), brief(2), brief_gate(3)
      transitionStep('TEST-FWD-003', 'spec', deps);

      const saved = deps._savedStates['TEST-FWD-003'];
      assert.equal(saved.stepStatus.bootstrap, 'completed', 'bootstrap should be completed');
      assert.equal(saved.stepStatus.brief, 'completed', 'brief should be completed');
      assert.equal(saved.stepStatus.brief_gate, 'completed', 'brief_gate should be completed');
    });
  });

  describe('analyzeActions ignores "step deferred" entries', () => {
    it('should not count "step deferred" as commands in analyzeActions', () => {
      const { analyzeActions } = require('../work-actions');

      const actions = [
        { step: 'ticket', timestamp: '2026-01-01T00:00:00.000Z', what: 'step started' },
        { step: 'ticket', timestamp: '2026-01-01T00:00:30.000Z', what: 'step completed' },
        { step: 'bootstrap', timestamp: '2026-01-01T00:00:30.000Z', what: 'step deferred' },
        { step: 'brief', timestamp: '2026-01-01T00:00:30.000Z', what: 'step started' },
        { step: 'brief', timestamp: '2026-01-01T00:01:00.000Z', what: 'step completed' },
      ];

      const result = analyzeActions(actions);
      const bootstrapStep = result.steps.find((s) => s.step === 'bootstrap');
      assert.ok(bootstrapStep, 'bootstrap step should appear in analysis');
      assert.equal(
        bootstrapStep.commandCount,
        0,
        '"step deferred" should not be counted as a command'
      );
    });
  });
});
