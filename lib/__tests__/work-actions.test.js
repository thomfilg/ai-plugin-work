/**
 * Tests for work-actions.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Use a temp directory for tests
const TEST_TASKS_BASE = path.join(os.tmpdir(), 'work-actions-test-' + process.pid);

// Mock TASKS_BASE before requiring the module
jest.mock('path', () => {
  const actual = jest.requireActual('path');
  return actual;
});

let appendAction, loadActions, analyzeActions;

beforeAll(() => {
  // Override HOME so TASKS_BASE resolves to our temp dir
  process.env.HOME = path.join(TEST_TASKS_BASE, 'fakehome');
  // We need to re-require after setting HOME
  jest.isolateModules(() => {
    const mod = require('../work-actions');
    appendAction = mod.appendAction;
    loadActions = mod.loadActions;
    analyzeActions = mod.analyzeActions;
  });
});

afterAll(() => {
  fs.rmSync(TEST_TASKS_BASE, { recursive: true, force: true });
});

describe('work-actions', () => {
  const TEST_TICKET = 'TEST-ACTIONS-001';

  afterEach(() => {
    // Clean up test ticket directory
    const dir = path.join(process.env.HOME, 'worktrees', 'tasks', TEST_TICKET);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('loadActions', () => {
    it('should return empty array for nonexistent ticket', () => {
      const actions = loadActions('NONEXISTENT-999');
      expect(actions).toEqual([]);
    });
  });

  describe('appendAction', () => {
    it('should create file and append a single action', () => {
      appendAction(TEST_TICKET, { step: '1_ticket', what: 'workflow started' });

      const actions = loadActions(TEST_TICKET);
      expect(actions).toHaveLength(1);
      expect(actions[0].step).toBe('1_ticket');
      expect(actions[0].what).toBe('workflow started');
      expect(actions[0].timestamp).toBeDefined();
    });

    it('should append multiple actions preserving order', () => {
      appendAction(TEST_TICKET, { step: '1_ticket', what: 'workflow started' });
      appendAction(TEST_TICKET, { step: '1_ticket', what: 'step started' });
      appendAction(TEST_TICKET, { step: '1_ticket', what: 'mcp__atlassian__jira_get_issue' });

      const actions = loadActions(TEST_TICKET);
      expect(actions).toHaveLength(3);
      expect(actions[0].what).toBe('workflow started');
      expect(actions[1].what).toBe('step started');
      expect(actions[2].what).toBe('mcp__atlassian__jira_get_issue');
    });

    it('should include meta when provided', () => {
      appendAction(TEST_TICKET, { step: '6_check', what: 'BLOCKED: Skill(check)', meta: { rule: 1 } });

      const actions = loadActions(TEST_TICKET);
      expect(actions[0].meta).toEqual({ rule: 1 });
    });

    it('should not include meta key when not provided', () => {
      appendAction(TEST_TICKET, { step: '1_ticket', what: 'step started' });

      const actions = loadActions(TEST_TICKET);
      expect(actions[0]).not.toHaveProperty('meta');
    });
  });

  describe('analyzeActions', () => {
    it('should return empty analysis for no actions', () => {
      const result = analyzeActions([]);
      expect(result.steps).toEqual([]);
      expect(result.totalDuration).toBe('0s');
      expect(result.bottleneck).toBeNull();
      expect(result.actionCount).toBe(0);
    });

    it('should compute per-step duration', () => {
      const actions = [
        { step: '1_ticket', timestamp: '2026-02-26T20:00:00.000Z', what: 'step started' },
        { step: '1_ticket', timestamp: '2026-02-26T20:00:30.000Z', what: 'mcp__atlassian__jira_get_issue' },
        { step: '1_ticket', timestamp: '2026-02-26T20:01:00.000Z', what: 'step completed' },
        { step: '2_bootstrap', timestamp: '2026-02-26T20:01:00.000Z', what: 'step started' },
        { step: '2_bootstrap', timestamp: '2026-02-26T20:02:00.000Z', what: 'Skill(bootstrap)' },
        { step: '2_bootstrap', timestamp: '2026-02-26T20:03:00.000Z', what: 'step completed' },
      ];

      const result = analyzeActions(actions);
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0].step).toBe('1_ticket');
      expect(result.steps[0].duration).toBe('60s');
      expect(result.steps[0].commandCount).toBe(1);
      expect(result.steps[1].step).toBe('2_bootstrap');
      expect(result.steps[1].duration).toBe('120s');
      expect(result.steps[1].commandCount).toBe(1);
    });

    it('should identify bottleneck step', () => {
      const actions = [
        { step: '1_ticket', timestamp: '2026-02-26T20:00:00.000Z', what: 'step started' },
        { step: '1_ticket', timestamp: '2026-02-26T20:00:10.000Z', what: 'step completed' },
        { step: '3_implement', timestamp: '2026-02-26T20:00:10.000Z', what: 'step started' },
        { step: '3_implement', timestamp: '2026-02-26T20:10:10.000Z', what: 'step completed' },
      ];

      const result = analyzeActions(actions);
      expect(result.bottleneck).toBe('3_implement');
      expect(result.bottleneckDuration).toBe('600s');
    });

    it('should count blocks and retries', () => {
      const actions = [
        { step: '6_check', timestamp: '2026-02-26T20:00:00.000Z', what: 'step started' },
        { step: '6_check', timestamp: '2026-02-26T20:01:00.000Z', what: 'BLOCKED: Skill(check) not in_progress' },
        { step: '6_check', timestamp: '2026-02-26T20:02:00.000Z', what: 'BLOCKED: transition without evidence' },
        { step: '6_check', timestamp: '2026-02-26T20:03:00.000Z', what: 'step reset' },
        { step: '6_check', timestamp: '2026-02-26T20:05:00.000Z', what: 'Skill(check)' },
        { step: '6_check', timestamp: '2026-02-26T20:10:00.000Z', what: 'step completed' },
      ];

      const result = analyzeActions(actions);
      const checkStep = result.steps.find(s => s.step === '6_check');
      expect(checkStep.blockCount).toBe(2);
      expect(checkStep.retryCount).toBe(1);
      expect(checkStep.commandCount).toBe(1);
    });

    it('should compute total duration from first to last action', () => {
      const actions = [
        { step: '1_ticket', timestamp: '2026-02-26T20:00:00.000Z', what: 'workflow started' },
        { step: '13_complete', timestamp: '2026-02-26T20:44:00.000Z', what: 'step completed' },
      ];

      const result = analyzeActions(actions);
      expect(result.totalDuration).toBe('2640s');
      expect(result.actionCount).toBe(2);
    });
  });
});
