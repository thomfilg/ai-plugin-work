/**
 * Tests for workflows/work/plan-generator.js — GH-215 Task 6.2
 *
 * Verifies that the plan generator emits `brief_gate` between `brief` and
 * `spec` entries. This closes the loop between:
 *   - Task 3 (STEPS.brief_gate constant + ALL_STEPS ordering), and
 *   - Task 4 (briefGateStep implementation)
 * by proving the gate is actually observable in generatePlan() output.
 *
 * Strategy: call generatePlan() directly with mocked deps and state rather
 * than spawning the CLI — this keeps the assertion fast, deterministic, and
 * focused purely on step ordering in the returned plan array.
 *
 * Run: node --test workflows/work/__tests__/plan-generator-brief-gate.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { generatePlan } = require(path.join(__dirname, '..', 'plan-generator'));
const { STEPS } = require(path.join(__dirname, '..', 'step-registry'));

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a minimal deps object for generatePlan(). None of the step modules
 * under test (brief, brief_gate, spec) need the heavier dependencies for the
 * ordering assertion — we only care that each emits a plan entry with the
 * correct `step` name, in the correct order.
 */
function makeDeps(overrides = {}) {
  return {
    tp: {
      sanitizeTicketIdForPath: (t) => t,
      getProviderConfig: () => ({}),
      getCreateTicketAgentType: () => 'general-purpose',
      getCreateTicketPrompt: () => null,
      getFetchTicketPrompt: () => 'Fetch ticket TEST-100 details.',
      getTransitionPrompt: () => 'Move ticket to In Development',
    },
    TDD_PROTOCOL: '',
    TDD_GATED_STEPS: [],
    STEPS,
    parseTasks: () => [],
    buildTaskPrompt: () => '',
    fileExists: () => false,
    run: () => '',
    WORKTREES_BASE: '/tmp/worktrees',
    TASKS_BASE: '/tmp/tasks',
    MAIN_WORKTREE_FOLDER: 'my-project',
    ...overrides,
  };
}

/**
 * Minimal inspected state — enough for every step module to make a DEFER
 * decision without reading real files. The key flag under test is hasBrief,
 * which controls whether brief_gate emits DEFER ("No brief.md present") or
 * attempts to read brief.md.
 */
function makeState(overrides = {}) {
  return {
    worktreeExists: true,
    tasksDirExists: true,
    hasStateFile: false,
    currentStep: 'brief',
    worktreeDir: '/tmp/worktrees/my-project-TEST-100',
    tasksDir: '/tmp/tasks/TEST-100',
    branch: null,
    headSha: null,
    hasDiffVsMain: false,
    diffSummary: '',
    hasCommitWithTicket: false,
    hasUncommitted: false,
    uncommittedCount: 0,
    hasUnpushed: false,
    lastCommitMsg: '',
    pr: { number: 1 },
    reports: {},
    allReportsPass: true,
    missingReports: [],
    failedReports: [],
    prUpdateSha: null,
    postPrUpdateSha: null,
    prEverUpdated: false,
    prShaMatch: false,
    hasBrief: false,
    hasSpec: false,
    hasTasks: false,
    hasDevSession: false,
    workState: null,
    stepIs: () => 'unknown',
    ...overrides,
  };
}

function stepIndex(plan, stepName) {
  return plan.findIndex((entry) => entry.step === stepName);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('plan-generator brief_gate ordering (GH-215 Task 6.2)', () => {
  it('emits brief_gate when brief is not yet present (DEFER path)', () => {
    const state = makeState({ hasBrief: false });
    const { plan } = generatePlan(
      'TEST-100',
      null,
      state,
      /* rework */ false,
      /* callerProviderCfg */ null,
      /* suffix */ null,
      makeDeps()
    );

    const briefIdx = stepIndex(plan, STEPS.brief);
    const gateIdx = stepIndex(plan, STEPS.brief_gate);
    const specIdx = stepIndex(plan, STEPS.spec);

    assert.ok(briefIdx >= 0, 'plan should contain a brief entry');
    assert.ok(gateIdx >= 0, 'plan should contain a brief_gate entry');
    assert.ok(specIdx >= 0, 'plan should contain a spec entry');
    assert.equal(gateIdx, briefIdx + 1, 'brief_gate must come directly after brief');
    assert.equal(specIdx, gateIdx + 1, 'spec must come directly after brief_gate');
  });

  it('emits brief_gate when hasBrief is true (gate evaluates brief.md)', () => {
    // With hasBrief=true, the gate will try to read brief.md via fs and
    // fail-open to RUN ("brief.md unreadable — regenerate brief...") because we use a bogus path.
    // That is fine for the ordering assertion — we only care that a
    // brief_gate entry appears between brief and spec.
    const state = makeState({ hasBrief: true });
    const { plan } = generatePlan('TEST-100', null, state, false, null, null, makeDeps());

    const briefIdx = stepIndex(plan, STEPS.brief);
    const gateIdx = stepIndex(plan, STEPS.brief_gate);
    const specIdx = stepIndex(plan, STEPS.spec);

    assert.ok(briefIdx >= 0, 'plan should contain a brief entry');
    assert.ok(gateIdx >= 0, 'plan should contain a brief_gate entry when hasBrief is true');
    assert.ok(specIdx >= 0, 'plan should contain a spec entry');
    assert.equal(gateIdx, briefIdx + 1);
    assert.equal(specIdx, gateIdx + 1);
  });

  it('keeps brief_gate in the plan even when WORK_BRIEF_ENABLED=0 (toggle is ignored)', () => {
    // GH-253 Task 4: WORK_BRIEF_ENABLED toggle removed — setting it to '0'
    // has no effect. Both entries must still appear in order so the workflow
    // state machine can advance through brief_gate.
    const prev = process.env.WORK_BRIEF_ENABLED;
    process.env.WORK_BRIEF_ENABLED = '0';
    try {
      const { plan } = generatePlan('TEST-100', null, makeState(), false, null, null, makeDeps());

      const briefIdx = stepIndex(plan, STEPS.brief);
      const gateIdx = stepIndex(plan, STEPS.brief_gate);
      const specIdx = stepIndex(plan, STEPS.spec);

      assert.ok(briefIdx >= 0);
      assert.ok(gateIdx >= 0);
      assert.ok(specIdx >= 0);
      assert.equal(gateIdx, briefIdx + 1);
      assert.equal(specIdx, gateIdx + 1);
    } finally {
      if (prev === undefined) delete process.env.WORK_BRIEF_ENABLED;
      else process.env.WORK_BRIEF_ENABLED = prev;
    }
  });
});
