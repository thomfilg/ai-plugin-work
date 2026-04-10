/**
 * Tests for step modules extracted from generatePlan().
 *
 * Strategy: snapshot the current generatePlan() output for various states,
 * then verify that the refactored step-module-based generatePlan() produces
 * identical output.
 *
 * Run: node --test workflows/work/steps/__tests__/step-modules.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { STEPS } = require('../../step-registry');

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build the context object that generatePlan() uses internally.
 * This mirrors the shape produced by inspect() + generatePlan() locals.
 */
function makeCtx(overrides = {}) {
  return {
    STEPS,
    ticket: 'TEST-100',
    description: null,
    rework: false,
    suffix: null,
    safeName: 'TEST-100',
    safeBase: 'TEST-100',
    worktreeDir: '/tmp/worktrees/my-project-TEST-100',
    tasksDir: '/tmp/tasks/TEST-100',
    t: 'TEST-100',
    ...overrides,
  };
}

function makeState(overrides = {}) {
  return {
    worktreeExists: false,
    tasksDirExists: false,
    hasStateFile: false,
    currentStep: 'ticket',
    worktreeDir: '/tmp/worktrees/my-project-TEST-100',
    tasksDir: '/tmp/tasks/TEST-100',
    branch: null,
    headSha: null,
    hasDiffVsMain: false,
    diffSummary: 'no worktree',
    hasCommitWithTicket: false,
    hasUncommitted: false,
    uncommittedCount: 0,
    hasUnpushed: false,
    lastCommitMsg: '',
    pr: null,
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

// ─── Step Module Contract Tests ─────────────────────────────────────────────

describe('step modules', () => {
  describe('each module exports a function', () => {
    const stepDir = path.join(__dirname, '..');
    const expectedModules = [
      'ticket',
      'bootstrap',
      'transition',
      'brief',
      'spec',
      'tasks',
      'implement',
      'commit',
      'check',
      'task-advance',
      'pr',
      'ready',
      'follow-up',
      'ci',
      'cleanup',
      'reports',
      'complete',
    ];

    for (const mod of expectedModules) {
      it(`${mod}.js exports a function`, () => {
        const stepModule = require(path.join(stepDir, `${mod}.js`));
        assert.equal(typeof stepModule, 'function', `${mod}.js should export a function`);
      });
    }
  });

  describe('ticket step', () => {
    let ticketStep;
    before(() => {
      ticketStep = require(path.join(__dirname, '..', 'ticket.js'));
    });

    it('should add RUN with general-purpose when ticket exists', () => {
      const entries = [];
      const add = (step, action, command, reason, extra) =>
        entries.push({ step, action, command, reason, ...extra });
      const ctx = makeCtx();
      const s = makeState();
      // Mock providerConfig and tp
      ctx.providerConfig = {};
      ctx.tp = {
        getCreateTicketAgentType: () => 'general-purpose',
        getCreateTicketPrompt: () => null,
        getFetchTicketPrompt: () => `Fetch ticket TEST-100 details.`,
      };
      ticketStep(add, s, ctx);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].step, 'ticket');
      assert.equal(entries[0].action, 'RUN');
      assert.equal(entries[0].agentType, 'general-purpose');
    });

    it('should add RUN with create agent when no ticket (description mode)', () => {
      const entries = [];
      const add = (step, action, command, reason, extra) =>
        entries.push({ step, action, command, reason, ...extra });
      const ctx = makeCtx({ ticket: null, description: 'add login feature', t: '{TICKET}' });
      const s = makeState();
      ctx.providerConfig = {};
      ctx.tp = {
        getCreateTicketAgentType: () => 'general-purpose',
        getCreateTicketPrompt: () => 'Create a ticket from this description: "add login feature"',
        getFetchTicketPrompt: () => null,
      };
      ticketStep(add, s, ctx);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].action, 'RUN');
      assert.ok(entries[0].agentPrompt.includes('add login feature'));
    });
  });

  describe('bootstrap step', () => {
    let bootstrapStep;
    before(() => {
      bootstrapStep = require(path.join(__dirname, '..', 'bootstrap.js'));
    });

    it('should SKIP when worktree + PR exist', () => {
      const entries = [];
      const add = (step, action, command, reason, extra) =>
        entries.push({ step, action, command, reason, ...extra });
      const s = makeState({ worktreeExists: true, pr: { number: 1 } });
      const ctx = makeCtx();
      bootstrapStep(add, s, ctx);
      assert.equal(entries[0].action, 'SKIP');
    });

    it('should RUN with /bootstrap when no worktree', () => {
      const entries = [];
      const add = (step, action, command, reason, extra) =>
        entries.push({ step, action, command, reason, ...extra });
      const s = makeState();
      const ctx = makeCtx();
      bootstrapStep(add, s, ctx);
      assert.equal(entries[0].action, 'RUN');
      assert.ok(entries[0].agentPrompt.includes('/bootstrap'));
    });
  });

  describe('commit step', () => {
    let commitStep;
    before(() => {
      commitStep = require(path.join(__dirname, '..', 'commit.js'));
    });

    it('should RUN when uncommitted files exist', () => {
      const entries = [];
      const add = (step, action, command, reason, extra) =>
        entries.push({ step, action, command, reason, ...extra });
      const s = makeState({ hasUncommitted: true, uncommittedCount: 3 });
      const ctx = makeCtx();
      commitStep(add, s, ctx);
      assert.equal(entries[0].action, 'RUN');
      assert.ok(entries[0].reason.includes('3'));
    });

    it('should PENDING when no diff vs main', () => {
      const entries = [];
      const add = (step, action, command, reason, extra) =>
        entries.push({ step, action, command, reason, ...extra });
      const s = makeState({ hasDiffVsMain: false });
      const ctx = makeCtx();
      commitStep(add, s, ctx);
      assert.equal(entries[0].action, 'PENDING');
    });
  });

  describe('check step', () => {
    let checkStep;
    before(() => {
      checkStep = require(path.join(__dirname, '..', 'check.js'));
    });

    it('should RUN with preCommands in rework mode', () => {
      const entries = [];
      const add = (step, action, command, reason, extra) =>
        entries.push({ step, action, command, reason, ...extra });
      const s = makeState();
      const ctx = makeCtx({ rework: true });
      checkStep(add, s, ctx);
      assert.equal(entries[0].action, 'RUN');
      assert.ok(entries[0].preCommands);
      assert.ok(entries[0].preCommands.length > 0);
    });
  });
});
