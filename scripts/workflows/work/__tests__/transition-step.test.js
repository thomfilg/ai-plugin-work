/**
 * Tests for transition-step.js (GH-245 Task 4, GH-260)
 *
 * Verifies that forward transitions log "step deferred" in the audit trail
 * for intermediate steps (status remains "completed" for backward compat).
 *
 * GH-260: Tests generic step-verify gate that enforces verify() functions
 * from workflow-definition.js before allowing forward transitions out of
 * non-soft steps.
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
      ALL_STEPS.forEach((s) => {
        stepStatus[s] = 'pending';
      });
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
    // GH-260: generic step-verify gate deps (default: no soft steps, no commandMap)
    softSteps: new Set(),
    commandMap: [],
    // GH-299: getHeadSha dep (default: returns a fixed SHA)
    getHeadSha: () => 'a'.repeat(40),
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
      const skippedActions = deps._actions.filter((a) => a.what === 'step skipped');
      assert.equal(skippedActions.length, 0, 'Should NOT log any "step skipped" actions');
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

describe('transition-step.js (GH-260): generic step-verify gate', () => {
  it('should block forward transition when verify() returns false for non-soft step', () => {
    const { transitionStep } = require('../transition-step');
    const { STEPS, ALL_STEPS } = require('../step-registry');

    // Put state at follow_up step
    const followUpIdx = ALL_STEPS.indexOf(STEPS.follow_up);
    const deps = createDeps({
      workflowCanTransition: () => true,
      softSteps: new Set([
        STEPS.ticket,
        STEPS.ready,
        STEPS.task_review,
        STEPS.reports,
        STEPS.complete,
      ]),
      commandMap: [
        { step: STEPS.follow_up, verify: () => false }, // verify fails
      ],
    });

    const ws = deps.loadWorkState('TEST-VERIFY-001');
    ws.currentStep = followUpIdx + 1; // 1-indexed
    ws.stepStatus[STEPS.follow_up] = 'in_progress';
    deps._savedStates['TEST-VERIFY-001'] = ws;

    const result = transitionStep('TEST-VERIFY-001', STEPS.ci, deps);
    assert.equal(result.error, true, 'Should block transition');
    assert.equal(result.gate, 'step-verify', 'Gate should be step-verify');
    assert.ok(result.message.includes('follow_up not verified'), 'Message should name the step');
  });

  it('should allow forward transition when verify() returns true for non-soft step', () => {
    const { transitionStep } = require('../transition-step');
    const { STEPS, ALL_STEPS } = require('../step-registry');

    const followUpIdx = ALL_STEPS.indexOf(STEPS.follow_up);
    const deps = createDeps({
      workflowCanTransition: () => true,
      softSteps: new Set([
        STEPS.ticket,
        STEPS.ready,
        STEPS.task_review,
        STEPS.reports,
        STEPS.complete,
      ]),
      commandMap: [
        { step: STEPS.follow_up, verify: () => true }, // verify passes
      ],
    });

    const ws = deps.loadWorkState('TEST-VERIFY-002');
    ws.currentStep = followUpIdx + 1;
    ws.stepStatus[STEPS.follow_up] = 'in_progress';
    deps._savedStates['TEST-VERIFY-002'] = ws;

    const result = transitionStep('TEST-VERIFY-002', STEPS.ci, deps);
    assert.equal(result.success, true, 'Should allow transition');
  });

  it('should skip verify gate for soft steps', () => {
    const { transitionStep } = require('../transition-step');
    const { STEPS, ALL_STEPS } = require('../step-registry');

    const reportsIdx = ALL_STEPS.indexOf(STEPS.reports);
    const deps = createDeps({
      workflowCanTransition: () => true,
      softSteps: new Set([
        STEPS.ticket,
        STEPS.ready,
        STEPS.task_review,
        STEPS.reports,
        STEPS.complete,
      ]),
      commandMap: [
        { step: STEPS.reports, verify: () => false }, // verify would fail, but reports is soft
      ],
    });

    const ws = deps.loadWorkState('TEST-VERIFY-003');
    ws.currentStep = reportsIdx + 1;
    ws.stepStatus[STEPS.reports] = 'in_progress';
    deps._savedStates['TEST-VERIFY-003'] = ws;

    const result = transitionStep('TEST-VERIFY-003', STEPS.complete, deps);
    assert.equal(result.success, true, 'Soft step should not be blocked by verify');
  });

  it('should skip verify gate for backward transitions', () => {
    const { transitionStep } = require('../transition-step');
    const { STEPS, ALL_STEPS } = require('../step-registry');

    const ciIdx = ALL_STEPS.indexOf(STEPS.ci);
    const deps = createDeps({
      workflowCanTransition: () => true,
      softSteps: new Set([
        STEPS.ticket,
        STEPS.ready,
        STEPS.task_review,
        STEPS.reports,
        STEPS.complete,
      ]),
      commandMap: [
        { step: STEPS.ci, verify: () => false }, // verify fails but backward should be allowed
      ],
    });

    const ws = deps.loadWorkState('TEST-VERIFY-004');
    ws.currentStep = ciIdx + 1;
    ws.stepStatus[STEPS.ci] = 'in_progress';
    deps._savedStates['TEST-VERIFY-004'] = ws;

    const result = transitionStep('TEST-VERIFY-004', STEPS.implement, deps);
    assert.equal(result.success, true, 'Backward transition should not be blocked by verify');
  });

  it('should allow forward transition when step has no verify function', () => {
    const { transitionStep } = require('../transition-step');
    const { STEPS, ALL_STEPS } = require('../step-registry');

    const cleanupIdx = ALL_STEPS.indexOf(STEPS.cleanup);
    const deps = createDeps({
      workflowCanTransition: () => true,
      softSteps: new Set([
        STEPS.ticket,
        STEPS.ready,
        STEPS.task_review,
        STEPS.reports,
        STEPS.complete,
      ]),
      commandMap: [], // no verify for cleanup
    });

    const ws = deps.loadWorkState('TEST-VERIFY-005');
    ws.currentStep = cleanupIdx + 1;
    ws.stepStatus[STEPS.cleanup] = 'in_progress';
    deps._savedStates['TEST-VERIFY-005'] = ws;

    const result = transitionStep('TEST-VERIFY-005', STEPS.reports, deps);
    assert.equal(result.success, true, 'Step with no verify should be allowed');
  });

  it('should throw when softSteps is missing from deps', () => {
    const { transitionStep } = require('../transition-step');
    const { STEPS, ALL_STEPS } = require('../step-registry');

    const followUpIdx = ALL_STEPS.indexOf(STEPS.follow_up);
    const deps = createDeps({
      workflowCanTransition: () => true,
      commandMap: [],
    });
    delete deps.softSteps;

    const ws = deps.loadWorkState('TEST-VERIFY-REQ-001');
    ws.currentStep = followUpIdx + 1;
    ws.stepStatus[STEPS.follow_up] = 'in_progress';
    deps._savedStates['TEST-VERIFY-REQ-001'] = ws;

    assert.throws(
      () => transitionStep('TEST-VERIFY-REQ-001', STEPS.ci, deps),
      (err) => err instanceof TypeError,
      'Should throw TypeError when softSteps is missing'
    );
  });

  it('should block ci → cleanup when CI verify returns false', () => {
    const { transitionStep } = require('../transition-step');
    const { STEPS, ALL_STEPS } = require('../step-registry');

    const ciIdx = ALL_STEPS.indexOf(STEPS.ci);
    const deps = createDeps({
      workflowCanTransition: () => true,
      softSteps: new Set([
        STEPS.ticket,
        STEPS.ready,
        STEPS.task_review,
        STEPS.reports,
        STEPS.complete,
      ]),
      commandMap: [
        { step: STEPS.ci, verify: () => false }, // CI not passing
      ],
    });

    const ws = deps.loadWorkState('TEST-VERIFY-006');
    ws.currentStep = ciIdx + 1;
    ws.stepStatus[STEPS.ci] = 'in_progress';
    deps._savedStates['TEST-VERIFY-006'] = ws;

    const result = transitionStep('TEST-VERIFY-006', STEPS.cleanup, deps);
    assert.equal(result.error, true, 'Should block ci -> cleanup');
    assert.equal(result.gate, 'step-verify');
    assert.ok(result.message.includes('ci not verified'));
  });

  it('should block forward transition when verify() throws an error', () => {
    const { transitionStep } = require('../transition-step');
    const { STEPS, ALL_STEPS } = require('../step-registry');

    const followUpIdx = ALL_STEPS.indexOf(STEPS.follow_up);
    const deps = createDeps({
      workflowCanTransition: () => true,
      softSteps: new Set([
        STEPS.ticket,
        STEPS.ready,
        STEPS.task_review,
        STEPS.reports,
        STEPS.complete,
      ]),
      commandMap: [
        {
          step: STEPS.follow_up,
          verify: () => {
            throw new Error('isPRGateReady exploded');
          },
        },
      ],
    });

    const ws = deps.loadWorkState('TEST-VERIFY-THROW-001');
    ws.currentStep = followUpIdx + 1;
    ws.stepStatus[STEPS.follow_up] = 'in_progress';
    deps._savedStates['TEST-VERIFY-THROW-001'] = ws;

    const result = transitionStep('TEST-VERIFY-THROW-001', STEPS.ci, deps);
    assert.equal(result.error, true, 'Should block transition when verify throws');
    assert.equal(result.gate, 'step-verify', 'Gate should be step-verify');
    assert.ok(result.message.includes('verify threw'), 'Message should indicate verify threw');
  });
});

// ─── GH-299: check-drift gate tests ─────────────────────────────────────────
describe('transition-step.js (GH-299): check-drift gate', () => {
  /** Helper: create deps with state at a given step, with checkPassedSha set */
  function depsAtStep(stepName, opts = {}) {
    const { STEPS, ALL_STEPS } = require('../step-registry');
    const stepIdx = ALL_STEPS.indexOf(stepName);
    const sha = opts.checkPassedSha !== undefined ? opts.checkPassedSha : 'a'.repeat(40);
    const headSha = opts.headSha !== undefined ? opts.headSha : 'a'.repeat(40);

    const deps = createDeps({
      workflowCanTransition: () => true,
      getHeadSha: () => headSha,
      ...opts.extraDeps,
    });

    const ws = deps.loadWorkState(opts.ticket || 'TEST-DRIFT');
    ws.currentStep = stepIdx + 1;
    ws.stepStatus[stepName] = 'in_progress';
    if (sha !== undefined) {
      ws.checkPassedSha = sha;
    }
    if (opts.checkInterruptedStep !== undefined) {
      ws.checkInterruptedStep = opts.checkInterruptedStep;
    }
    deps._savedStates[opts.ticket || 'TEST-DRIFT'] = ws;

    return { deps, STEPS, ALL_STEPS };
  }

  it('should proceed normally when SHA matches on forward transition from post-check step', () => {
    const { transitionStep } = require('../transition-step');
    const matchingSha = 'b'.repeat(40);
    const { deps } = depsAtStep('pr', {
      ticket: 'TEST-DRIFT-MATCH',
      checkPassedSha: matchingSha,
      headSha: matchingSha,
    });

    const result = transitionStep('TEST-DRIFT-MATCH', 'ready', deps);
    assert.equal(result.success, true, 'Should proceed when SHA matches');
    assert.equal(result.from, 'pr');
    assert.equal(result.to, 'ready');
  });

  it('should redirect to check when SHA differs on forward transition from post-check step', () => {
    const { transitionStep } = require('../transition-step');
    const { deps, STEPS } = depsAtStep('pr', {
      ticket: 'TEST-DRIFT-DIFF',
      checkPassedSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    });

    const result = transitionStep('TEST-DRIFT-DIFF', 'ready', deps);
    assert.equal(result.success, true, 'Should succeed (redirected)');
    assert.equal(result.to, STEPS.check, 'Should redirect to check');
    assert.equal(result.gate, 'check-drift', 'Gate should be check-drift');
    assert.ok(
      result.message.includes('New commits detected'),
      'Message should mention new commits'
    );
  });

  it('should skip gate on backward transitions', () => {
    const { transitionStep } = require('../transition-step');
    const { deps, STEPS } = depsAtStep('pr', {
      ticket: 'TEST-DRIFT-BACK',
      checkPassedSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40), // SHA differs but backward should skip gate
    });

    const result = transitionStep('TEST-DRIFT-BACK', STEPS.check, deps);
    assert.equal(result.success, true, 'Backward transition should succeed');
    assert.equal(result.to, STEPS.check);
    // Should NOT have gate='check-drift' — backward transitions skip the gate
    assert.notEqual(result.gate, 'check-drift', 'Backward should not trigger drift gate');
  });

  it('should skip gate when checkPassedSha is missing from work state', () => {
    const { transitionStep } = require('../transition-step');
    const { deps } = depsAtStep('pr', {
      ticket: 'TEST-DRIFT-NOSHA',
      checkPassedSha: undefined,
      headSha: 'b'.repeat(40),
    });
    // Remove checkPassedSha explicitly
    delete deps._savedStates['TEST-DRIFT-NOSHA'].checkPassedSha;

    const result = transitionStep('TEST-DRIFT-NOSHA', 'ready', deps);
    assert.equal(result.success, true, 'Should proceed without checkPassedSha');
  });

  it('should skip gate (fail-open) when getHeadSha returns null', () => {
    const { transitionStep } = require('../transition-step');
    const { deps } = depsAtStep('pr', {
      ticket: 'TEST-DRIFT-NULL',
      checkPassedSha: 'a'.repeat(40),
      headSha: null,
    });

    const result = transitionStep('TEST-DRIFT-NULL', 'ready', deps);
    assert.equal(result.success, true, 'Should fail-open when getHeadSha returns null');
  });

  it('should record checkPassedSha on check → pr transition', () => {
    const { transitionStep } = require('../transition-step');
    const { STEPS, ALL_STEPS } = require('../step-registry');
    const expectedSha = 'c'.repeat(40);

    const checkIdx = ALL_STEPS.indexOf(STEPS.check);
    const deps = createDeps({
      workflowCanTransition: () => true,
      getHeadSha: () => expectedSha,
    });

    const ws = deps.loadWorkState('TEST-DRIFT-RECORD');
    ws.currentStep = checkIdx + 1;
    ws.stepStatus[STEPS.check] = 'in_progress';
    deps._savedStates['TEST-DRIFT-RECORD'] = ws;

    const result = transitionStep('TEST-DRIFT-RECORD', STEPS.pr, deps);
    assert.equal(result.success, true, 'check -> pr should succeed');

    const saved = deps._savedStates['TEST-DRIFT-RECORD'];
    assert.equal(saved.checkPassedSha, expectedSha, 'checkPassedSha should be recorded');
  });

  it('should clear checkInterruptedStep on check → pr transition', () => {
    const { transitionStep } = require('../transition-step');
    const { STEPS, ALL_STEPS } = require('../step-registry');

    const checkIdx = ALL_STEPS.indexOf(STEPS.check);
    const deps = createDeps({
      workflowCanTransition: () => true,
      getHeadSha: () => 'd'.repeat(40),
    });

    const ws = deps.loadWorkState('TEST-DRIFT-CLEAR');
    ws.currentStep = checkIdx + 1;
    ws.stepStatus[STEPS.check] = 'in_progress';
    ws.checkInterruptedStep = 'pr'; // was previously interrupted
    deps._savedStates['TEST-DRIFT-CLEAR'] = ws;

    const result = transitionStep('TEST-DRIFT-CLEAR', STEPS.pr, deps);
    assert.equal(result.success, true);

    const saved = deps._savedStates['TEST-DRIFT-CLEAR'];
    assert.equal(saved.checkInterruptedStep, null, 'checkInterruptedStep should be cleared');
  });

  it('should set checkInterruptedStep on drift detection', () => {
    const { transitionStep } = require('../transition-step');
    const { deps, STEPS } = depsAtStep('follow_up', {
      ticket: 'TEST-DRIFT-INTERRUPT',
      checkPassedSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    });

    const result = transitionStep('TEST-DRIFT-INTERRUPT', STEPS.ci, deps);
    assert.equal(result.gate, 'check-drift');

    const saved = deps._savedStates['TEST-DRIFT-INTERRUPT'];
    assert.equal(
      saved.checkInterruptedStep,
      'follow_up',
      'checkInterruptedStep should be set to current step'
    );
    assert.equal(saved.checkPassedSha, null, 'checkPassedSha should be cleared on drift');
  });

  it('should call appendAction with re-check message on drift', () => {
    const { transitionStep } = require('../transition-step');
    const { deps, STEPS } = depsAtStep('ci', {
      ticket: 'TEST-DRIFT-ACTION',
      checkPassedSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    });

    transitionStep('TEST-DRIFT-ACTION', STEPS.cleanup, deps);

    const recheckActions = deps._actions.filter(
      (a) => a.what === 'check re-triggered: new commits detected'
    );
    assert.equal(recheckActions.length, 1, 'Should log re-check action');
    assert.equal(recheckActions[0].step, 'ci', 'Action step should be current step');
  });
});
