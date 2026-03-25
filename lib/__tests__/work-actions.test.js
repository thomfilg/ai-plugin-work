/**
 * Tests for work-actions.js
 *
 * Run with: node --test lib/__tests__/work-actions.test.js
 */

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Use a temp directory for tests
const TEST_TASKS_BASE = path.join(os.tmpdir(), 'work-actions-test-' + process.pid);
const FAKE_HOME = path.join(TEST_TASKS_BASE, 'fakehome');

let appendAction, loadActions, analyzeActions;

describe('work-actions', () => {
  const TEST_TICKET = 'TEST-ACTIONS-001';
  let origHome;

  before(() => {
    // Override HOME so TASKS_BASE resolves to our temp dir
    origHome = process.env.HOME;
    process.env.HOME = FAKE_HOME;
    process.env.WORKTREES_BASE = path.join(FAKE_HOME, 'worktrees');
    process.env.TASKS_BASE = path.join(FAKE_HOME, 'worktrees', 'tasks');

    // Clear require cache and re-require with new HOME
    delete require.cache[require.resolve('../work-actions')];
    delete require.cache[require.resolve('../config')];
    const mod = require('../work-actions');
    appendAction = mod.appendAction;
    loadActions = mod.loadActions;
    analyzeActions = mod.analyzeActions;
  });

  after(() => {
    process.env.HOME = origHome;
    delete process.env.WORKTREES_BASE;
    delete process.env.TASKS_BASE;
    fs.rmSync(TEST_TASKS_BASE, { recursive: true, force: true });
  });

  afterEach(() => {
    // Clean up test ticket directory
    const dir = path.join(FAKE_HOME, 'worktrees', 'tasks', TEST_TICKET);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('loadActions', () => {
    it('should return empty array for nonexistent ticket', () => {
      const actions = loadActions('NONEXISTENT-999');
      assert.deepStrictEqual(actions, []);
    });
  });

  describe('appendAction', () => {
    it('should create file and append a single action', () => {
      appendAction(TEST_TICKET, { step: 'ticket', what: 'workflow started' });

      const actions = loadActions(TEST_TICKET);
      assert.strictEqual(actions.length, 1);
      assert.strictEqual(actions[0].step, 'ticket');
      assert.strictEqual(actions[0].what, 'workflow started');
      assert.ok(actions[0].timestamp);
    });

    it('should append multiple actions preserving order', () => {
      appendAction(TEST_TICKET, { step: 'ticket', what: 'workflow started' });
      appendAction(TEST_TICKET, { step: 'ticket', what: 'step started' });
      appendAction(TEST_TICKET, { step: 'ticket', what: 'mcp__atlassian__jira_get_issue' });

      const actions = loadActions(TEST_TICKET);
      assert.strictEqual(actions.length, 3);
      assert.strictEqual(actions[0].what, 'workflow started');
      assert.strictEqual(actions[1].what, 'step started');
      assert.strictEqual(actions[2].what, 'mcp__atlassian__jira_get_issue');
    });

    it('should include meta when provided', () => {
      appendAction(TEST_TICKET, { step: 'check', what: 'BLOCKED: Skill(check)', meta: { rule: 1 } });

      const actions = loadActions(TEST_TICKET);
      assert.deepStrictEqual(actions[0].meta, { rule: 1 });
    });

    it('should not include meta key when not provided', () => {
      appendAction(TEST_TICKET, { step: 'ticket', what: 'step started' });

      const actions = loadActions(TEST_TICKET);
      assert.strictEqual('meta' in actions[0], false);
    });
  });

  describe('analyzeActions', () => {
    it('should return empty analysis for no actions', () => {
      const result = analyzeActions([]);
      assert.deepStrictEqual(result.steps, []);
      assert.strictEqual(result.totalDuration, '0s');
      assert.strictEqual(result.bottleneck, null);
      assert.strictEqual(result.actionCount, 0);
    });

    it('should compute per-step duration', () => {
      const actions = [
        { step: 'ticket', timestamp: '2026-02-26T20:00:00.000Z', what: 'step started' },
        { step: 'ticket', timestamp: '2026-02-26T20:00:30.000Z', what: 'mcp__atlassian__jira_get_issue' },
        { step: 'ticket', timestamp: '2026-02-26T20:01:00.000Z', what: 'step completed' },
        { step: 'bootstrap', timestamp: '2026-02-26T20:01:00.000Z', what: 'step started' },
        { step: 'bootstrap', timestamp: '2026-02-26T20:02:00.000Z', what: 'Skill(bootstrap)' },
        { step: 'bootstrap', timestamp: '2026-02-26T20:03:00.000Z', what: 'step completed' },
      ];

      const result = analyzeActions(actions);
      assert.strictEqual(result.steps.length, 2);
      assert.strictEqual(result.steps[0].step, 'ticket');
      assert.strictEqual(result.steps[0].duration, '60s');
      assert.strictEqual(result.steps[0].commandCount, 1);
      assert.strictEqual(result.steps[1].step, 'bootstrap');
      assert.strictEqual(result.steps[1].duration, '120s');
      assert.strictEqual(result.steps[1].commandCount, 1);
    });

    it('should identify bottleneck step', () => {
      const actions = [
        { step: 'ticket', timestamp: '2026-02-26T20:00:00.000Z', what: 'step started' },
        { step: 'ticket', timestamp: '2026-02-26T20:00:10.000Z', what: 'step completed' },
        { step: 'implement', timestamp: '2026-02-26T20:00:10.000Z', what: 'step started' },
        { step: 'implement', timestamp: '2026-02-26T20:10:10.000Z', what: 'step completed' },
      ];

      const result = analyzeActions(actions);
      assert.strictEqual(result.bottleneck, 'implement');
      assert.strictEqual(result.bottleneckDuration, '600s');
    });

    it('should count blocks and retries', () => {
      const actions = [
        { step: 'check', timestamp: '2026-02-26T20:00:00.000Z', what: 'step started' },
        { step: 'check', timestamp: '2026-02-26T20:01:00.000Z', what: 'BLOCKED: Skill(check) not in_progress' },
        { step: 'check', timestamp: '2026-02-26T20:02:00.000Z', what: 'BLOCKED: transition without evidence' },
        { step: 'check', timestamp: '2026-02-26T20:03:00.000Z', what: 'step reset' },
        { step: 'check', timestamp: '2026-02-26T20:05:00.000Z', what: 'Skill(check)' },
        { step: 'check', timestamp: '2026-02-26T20:10:00.000Z', what: 'step completed' },
      ];

      const result = analyzeActions(actions);
      const checkStep = result.steps.find(s => s.step === 'check');
      assert.strictEqual(checkStep.blockCount, 2);
      assert.strictEqual(checkStep.retryCount, 1);
      assert.strictEqual(checkStep.commandCount, 1);
    });

    it('should compute total duration from first to last action', () => {
      const actions = [
        { step: 'ticket', timestamp: '2026-02-26T20:00:00.000Z', what: 'workflow started' },
        { step: 'complete', timestamp: '2026-02-26T20:44:00.000Z', what: 'step completed' },
      ];

      const result = analyzeActions(actions);
      assert.strictEqual(result.totalDuration, '2640s');
      assert.strictEqual(result.actionCount, 2);
    });
  });
});
