/**
 * Tests for GH-253 Task 4: Remove toggle variables from plan-generator.js
 *
 * Verifies:
 * 1. plan-generator.js source does not reference WORK_BRIEF_ENABLED,
 *    WORK_SPEC_ENABLED, or WORK_TASKS_ENABLED
 * 2. planningDocs always includes brief/spec/tasks paths when artifacts
 *    are missing (no "disabled" conditional)
 * 3. No plan entry ever has a reason containing "disabled"
 *
 * Run: node --test workflows/work/__tests__/plan-generator-no-toggles.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { generatePlan } = require(path.join(__dirname, '..', 'plan-generator'));
const { STEPS } = require(path.join(__dirname, '..', 'step-registry'));

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GH-253 Task 4: plan-generator.js toggle removal', () => {
  const planGenSource = fs.readFileSync(path.join(__dirname, '..', 'plan-generator.js'), 'utf8');

  it('does not reference WORK_BRIEF_ENABLED in source code', () => {
    assert.ok(
      !planGenSource.includes('WORK_BRIEF_ENABLED'),
      'plan-generator.js must not contain WORK_BRIEF_ENABLED'
    );
  });

  it('does not reference WORK_SPEC_ENABLED in source code', () => {
    assert.ok(
      !planGenSource.includes('WORK_SPEC_ENABLED'),
      'plan-generator.js must not contain WORK_SPEC_ENABLED'
    );
  });

  it('does not reference WORK_TASKS_ENABLED in source code', () => {
    assert.ok(
      !planGenSource.includes('WORK_TASKS_ENABLED'),
      'plan-generator.js must not contain WORK_TASKS_ENABLED'
    );
  });

  it('does not declare briefEnabled, specEnabled, or tasksEnabled variables', () => {
    assert.ok(
      !planGenSource.includes('briefEnabled'),
      'plan-generator.js must not declare briefEnabled'
    );
    assert.ok(
      !planGenSource.includes('specEnabled'),
      'plan-generator.js must not declare specEnabled'
    );
    assert.ok(
      !planGenSource.includes('tasksEnabled'),
      'plan-generator.js must not declare tasksEnabled'
    );
  });
});

describe('GH-253 Task 4: plan never contains "disabled" reason', () => {
  const savedEnv = {};

  beforeEach(() => {
    savedEnv.WORK_BRIEF_ENABLED = process.env.WORK_BRIEF_ENABLED;
    savedEnv.WORK_SPEC_ENABLED = process.env.WORK_SPEC_ENABLED;
    savedEnv.WORK_TASKS_ENABLED = process.env.WORK_TASKS_ENABLED;
    // Even if someone sets these to '0', the plan should NOT contain "disabled"
    process.env.WORK_BRIEF_ENABLED = '0';
    process.env.WORK_SPEC_ENABLED = '0';
    process.env.WORK_TASKS_ENABLED = '0';
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('no plan entry has a reason containing "disabled" when artifacts missing', () => {
    const state = makeState({ hasBrief: false, hasSpec: false, hasTasks: false });
    const { plan } = generatePlan('TEST-100', null, state, false, null, null, makeDeps());

    const disabledEntries = plan.filter(
      (e) => typeof e.reason === 'string' && e.reason.toLowerCase().includes('disabled')
    );
    assert.equal(
      disabledEntries.length,
      0,
      `No plan entry should have "disabled" in reason, but found: ${JSON.stringify(disabledEntries)}`
    );
  });

  it('always includes RUN entries for brief and spec when artifacts are missing', () => {
    const state = makeState({ hasBrief: false, hasSpec: false, hasTasks: false });
    const { plan } = generatePlan('TEST-100', null, state, false, null, null, makeDeps());

    const briefEntry = plan.find((e) => e.step === STEPS.brief);
    const specEntry = plan.find((e) => e.step === STEPS.spec);
    const tasksEntry = plan.find((e) => e.step === STEPS.tasks);

    assert.ok(briefEntry, 'plan must contain a brief entry');
    assert.ok(specEntry, 'plan must contain a spec entry');
    assert.ok(tasksEntry, 'plan must contain a tasks entry');

    // brief/spec should be RUN when artifacts are missing
    assert.equal(briefEntry.action, 'RUN', 'brief should be RUN when artifact missing');
    assert.equal(specEntry.action, 'RUN', 'spec should be RUN when artifact missing');
    // tasks DEFERs when spec.md is absent (dependency not met) — that is correct behavior
    assert.equal(
      tasksEntry.action,
      'DEFER',
      'tasks should DEFER when spec.md dependency is absent'
    );
  });

  it('includes RUN for tasks when spec exists but tasks.md is missing', () => {
    const state = makeState({ hasBrief: true, hasSpec: true, hasTasks: false });
    // fileExists returns true for spec.md path so tasks step can RUN
    const specPath = '/tmp/tasks/TEST-100/spec.md';
    const { plan } = generatePlan(
      'TEST-100',
      null,
      state,
      false,
      null,
      null,
      makeDeps({
        fileExists: (p) => p === specPath || p === '/tmp/tasks/TEST-100',
      })
    );

    const tasksEntry = plan.find((e) => e.step === STEPS.tasks);
    assert.ok(tasksEntry, 'plan must contain a tasks entry');
    assert.equal(
      tasksEntry.action,
      'RUN',
      'tasks should be RUN when spec exists but tasks.md missing'
    );
  });
});

describe('GH-253 Task 4: .env.example toggle removal', () => {
  const envExampleSource = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', '.env.example'),
    'utf8'
  );

  it('does not contain WORK_BRIEF_ENABLED', () => {
    assert.ok(
      !envExampleSource.includes('WORK_BRIEF_ENABLED'),
      '.env.example must not contain WORK_BRIEF_ENABLED'
    );
  });

  it('does not contain WORK_SPEC_ENABLED', () => {
    assert.ok(
      !envExampleSource.includes('WORK_SPEC_ENABLED'),
      '.env.example must not contain WORK_SPEC_ENABLED'
    );
  });
});
