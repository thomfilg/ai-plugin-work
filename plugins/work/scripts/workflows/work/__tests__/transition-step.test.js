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
      const { transitionStep } = require('../engine/transition-step');
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
      const { transitionStep } = require('../engine/transition-step');

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
      const { transitionStep } = require('../engine/transition-step');

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
      const { analyzeActions } = require('../lib/work-actions');

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
    const { transitionStep } = require('../engine/transition-step');
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
    const { transitionStep } = require('../engine/transition-step');
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
    const { transitionStep } = require('../engine/transition-step');
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
    const { transitionStep } = require('../engine/transition-step');
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
    const { transitionStep } = require('../engine/transition-step');
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
    const { transitionStep } = require('../engine/transition-step');
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
    const { transitionStep } = require('../engine/transition-step');
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
    const { transitionStep } = require('../engine/transition-step');
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
    const { transitionStep } = require('../engine/transition-step');
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
    const { transitionStep } = require('../engine/transition-step');
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
    const { transitionStep } = require('../engine/transition-step');
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
    const { transitionStep } = require('../engine/transition-step');
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
    const { transitionStep } = require('../engine/transition-step');
    const { deps } = depsAtStep('pr', {
      ticket: 'TEST-DRIFT-NULL',
      checkPassedSha: 'a'.repeat(40),
      headSha: null,
    });

    const result = transitionStep('TEST-DRIFT-NULL', 'ready', deps);
    assert.equal(result.success, true, 'Should fail-open when getHeadSha returns null');
  });

  it('should record checkPassedSha on check → pr transition', () => {
    const { transitionStep } = require('../engine/transition-step');
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
    const { transitionStep } = require('../engine/transition-step');
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
    const { transitionStep } = require('../engine/transition-step');
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
    const { transitionStep } = require('../engine/transition-step');
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

// ─── GH-329: check-drift archives stale .check.md reports ───────────────────
describe('transition-step.js (GH-329): check-drift archives stale check reports', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');

  /** Build a deps object with a real TASKS_BASE temp dir and a fake archive helper. */
  function makeDriftDeps({
    ticket = 'TEST-DRIFT-329',
    headSha = 'b'.repeat(40),
    checkPassedSha = 'a'.repeat(40),
    startStep = 'pr',
    writeReports = true,
  } = {}) {
    const { STEPS, ALL_STEPS } = require('../step-registry');
    const tasksBase = fs.mkdtempSync(path.join(os.tmpdir(), 'gh329-'));
    const tasksDir = path.join(tasksBase, ticket);
    fs.mkdirSync(tasksDir, { recursive: true });

    const reportFiles = [
      'qa.check.md',
      'code-review.check.md',
      'tests.check.md',
      'completion.check.md',
    ];
    if (writeReports) {
      for (const f of reportFiles) {
        fs.writeFileSync(path.join(tasksDir, f), '# stale report\n');
      }
    }

    // Fake archiveStepArtifacts: moves matching *.check.md files into runs/run1
    // and returns the relative archive path; returns null when nothing matched.
    const archiveCalls = [];
    function fakeArchive(dir, steps) {
      archiveCalls.push({ dir, steps: [...steps] });
      if (!steps.includes(STEPS.check)) return null;
      let entries = [];
      try {
        entries = fs.readdirSync(dir).filter((f) => /^.*\.check\.md$/.test(f));
      } catch {
        return null;
      }
      if (entries.length === 0) return null;
      const runDir = path.join(dir, 'runs', 'run1');
      fs.mkdirSync(runDir, { recursive: true });
      for (const f of entries) {
        fs.renameSync(path.join(dir, f), path.join(runDir, f));
      }
      return 'runs/run1';
    }

    const stepIdx = ALL_STEPS.indexOf(startStep);
    const deps = createDeps({
      workflowCanTransition: () => true,
      getHeadSha: () => headSha,
      TASKS_BASE: tasksBase,
      archiveStepArtifacts: fakeArchive,
    });
    deps._archiveCalls = archiveCalls;
    deps._tasksDir = tasksDir;
    deps._reportFiles = reportFiles;

    const ws = deps.loadWorkState(ticket);
    ws.currentStep = stepIdx + 1;
    ws.stepStatus[startStep] = 'in_progress';
    if (checkPassedSha !== undefined) ws.checkPassedSha = checkPassedSha;
    deps._savedStates[ticket] = ws;

    return { deps, STEPS, ALL_STEPS, ticket, tasksDir };
  }

  function reportsStillPresent(tasksDir, files) {
    return files.every((f) => fs.existsSync(path.join(tasksDir, f)));
  }
  function reportsRemoved(tasksDir, files) {
    return files.every((f) => !fs.existsSync(path.join(tasksDir, f)));
  }

  it('check-drift redirect archives stale .check.md reports', () => {
    const { transitionStep } = require('../engine/transition-step');
    const { deps, STEPS, ticket, tasksDir } = makeDriftDeps();
    const result = transitionStep(ticket, 'ready', deps);

    assert.equal(result.gate, 'check-drift', 'redirect must annotate gate=check-drift');
    assert.equal(result.to, STEPS.check, 'redirect targets check');
    assert.ok(
      deps._archiveCalls.some(
        (c) => c.dir === tasksDir && c.steps.includes(STEPS.check)
      ),
      'archiveStepArtifacts must be called with tasksDir + [STEPS.check]'
    );
    assert.ok(
      reportsRemoved(tasksDir, deps._reportFiles),
      'stale .check.md files must no longer be readable at their original paths'
    );
    const saved = deps._savedStates[ticket];
    assert.equal(saved.checkPassedSha, null, 'checkPassedSha must be cleared on redirect (R6)');
    const archivalRows = deps._actions.filter(
      (a) => typeof a.what === 'string' && a.what.includes('artifacts archived to')
    );
    assert.equal(archivalRows.length, 1, 'exactly one archival audit row on drift with reports');
    assert.ok(
      archivalRows[0].what.includes('(check-drift)'),
      'archival row must carry (check-drift) suffix (R3)'
    );
    const recheckRows = deps._actions.filter(
      (a) => a.what === 'check re-triggered: new commits detected'
    );
    assert.equal(recheckRows.length, 1, 'existing re-triggered audit row preserved (R4)');
  });

  it('forward transition out of check is blocked until fresh reports exist', () => {
    const { transitionStep } = require('../engine/transition-step');
    const { STEPS, ALL_STEPS } = require('../step-registry');
    const { deps, ticket } = makeDriftDeps();
    // First: drift redirect into check
    transitionStep(ticket, 'ready', deps);

    // Position state at check, simulate verify failing because reports are gone
    const ws = deps._savedStates[ticket];
    ws.currentStep = ALL_STEPS.indexOf(STEPS.check) + 1;
    ws.stepStatus[STEPS.check] = 'in_progress';
    deps._savedStates[ticket] = ws;
    // Inject a failing check verify via commandMap (mirrors workflow-definition wiring)
    deps.commandMap = [{ step: STEPS.check, verify: () => false }];
    deps.validateCheckGate = () => ({ valid: false, reasons: ['no fresh reports'] });

    const result = transitionStep(ticket, STEPS.pr, deps);
    assert.equal(result.error, true, 'check -> pr must be BLOCKED after redirect (R2)');
  });

  it('no archival occurs when HEAD has not drifted', () => {
    const { transitionStep } = require('../engine/transition-step');
    const matchingSha = 'a'.repeat(40);
    const { deps, ticket, tasksDir } = makeDriftDeps({
      headSha: matchingSha,
      checkPassedSha: matchingSha,
    });
    const result = transitionStep(ticket, 'ready', deps);

    assert.equal(result.success, true, 'no-drift forward transition should proceed');
    assert.notEqual(result.gate, 'check-drift', 'no drift => no check-drift gate annotation');
    assert.equal(
      deps._archiveCalls.length,
      0,
      'archiveStepArtifacts must NOT be called on no-drift path (R7)'
    );
    assert.ok(
      reportsStillPresent(tasksDir, deps._reportFiles),
      'no-drift path must leave .check.md files in place'
    );
    const archivalRows = deps._actions.filter(
      (a) => typeof a.what === 'string' && a.what.includes('(check-drift)')
    );
    assert.equal(archivalRows.length, 0, 'no (check-drift) audit row on no-drift path');
  });

  it('check-drift fires but no reports exist to archive', () => {
    const { transitionStep } = require('../engine/transition-step');
    const { deps, STEPS, ticket, tasksDir } = makeDriftDeps({ writeReports: false });
    const result = transitionStep(ticket, 'ready', deps);

    assert.equal(result.gate, 'check-drift', 'drift still detected');
    assert.equal(result.to, STEPS.check, 'still redirects to check');
    assert.ok(
      deps._archiveCalls.some((c) => c.steps.includes(STEPS.check)),
      'archive helper still invoked (idempotent no-op)'
    );
    assert.ok(
      reportsRemoved(tasksDir, deps._reportFiles),
      'no files to remove (trivially true)'
    );
    const archivalRows = deps._actions.filter(
      (a) => typeof a.what === 'string' && a.what.includes('artifacts archived to')
    );
    assert.equal(
      archivalRows.length,
      0,
      'no archival audit row when no reports were present (R3 idempotency)'
    );
    const recheckRows = deps._actions.filter(
      (a) => a.what === 'check re-triggered: new commits detected'
    );
    assert.equal(recheckRows.length, 1, 're-triggered row still appended even with no reports (R4)');
  });

  it('backward transition into check still archives via the same helper', () => {
    const { transitionStep } = require('../engine/transition-step');
    const { STEPS } = require('../step-registry');
    const { deps, ticket, tasksDir } = makeDriftDeps({ startStep: 'pr' });
    // Backward transition: pr -> check (existing pre-329 behavior)
    const result = transitionStep(ticket, STEPS.check, deps);

    assert.equal(result.success, true, 'backward transition succeeds');
    // R5 single source: backward path uses the same archiveStepArtifacts helper
    // (it archives the steps being reset, not the target). Confirm the helper
    // was invoked with tasksDir so both call sites share one source of truth.
    assert.ok(
      deps._archiveCalls.some((c) => c.dir === tasksDir),
      'backward path still calls archiveStepArtifacts with tasksDir (R5 single source)'
    );
    // Backward archival rows must NOT carry the (check-drift) suffix —
    // that suffix distinguishes drift redirects from operator-driven backward loops.
    const archivalRows = deps._actions.filter(
      (a) => typeof a.what === 'string' && a.what.includes('artifacts archived to')
    );
    for (const row of archivalRows) {
      assert.ok(
        !row.what.includes('(check-drift)'),
        'backward archival row must NOT carry (check-drift) suffix'
      );
    }
  });

  it('full GH-324 replay — drift detected, agent must re-run /check before reaching pr', () => {
    const { transitionStep } = require('../engine/transition-step');
    const { STEPS, ALL_STEPS } = require('../step-registry');
    const { deps, ticket, tasksDir } = makeDriftDeps({ startStep: 'pr' });

    // Step 1: agent attempts forward pr -> ready while HEAD has drifted
    const redirect = transitionStep(ticket, 'ready', deps);
    assert.equal(redirect.gate, 'check-drift', 'drift detected');
    assert.equal(redirect.to, STEPS.check, 'redirected back to check');
    assert.ok(
      reportsRemoved(tasksDir, deps._reportFiles),
      'stale reports archived during redirect — replays GH-324 fix'
    );

    // Step 2: agent (without re-running check) tries to push forward to pr
    const ws = deps._savedStates[ticket];
    ws.currentStep = ALL_STEPS.indexOf(STEPS.check) + 1;
    ws.stepStatus[STEPS.check] = 'in_progress';
    deps._savedStates[ticket] = ws;
    deps.commandMap = [{ step: STEPS.check, verify: () => false }];
    deps.validateCheckGate = () => ({ valid: false, reasons: ['stale reports archived'] });

    const blocked = transitionStep(ticket, STEPS.pr, deps);
    assert.equal(blocked.error, true, 'check -> pr blocked without fresh reports (AC2)');

    // Step 3: fresh /check run writes new reports, verify passes, transition succeeds
    for (const f of deps._reportFiles) {
      fs.writeFileSync(path.join(tasksDir, f), '# fresh report\n');
    }
    deps.commandMap = [{ step: STEPS.check, verify: () => true }];
    deps.validateCheckGate = () => ({ valid: true });
    const success = transitionStep(ticket, STEPS.pr, deps);
    assert.equal(success.success, true, 'check -> pr succeeds after fresh reports written');
  });
});
