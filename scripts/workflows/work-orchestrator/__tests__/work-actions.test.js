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

let appendAction, loadActions, analyzeActions, appendEnforcementAudit;

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
    delete require.cache[require.resolve('../../lib/config')];
    const mod = require('../work-actions');
    appendAction = mod.appendAction;
    loadActions = mod.loadActions;
    analyzeActions = mod.analyzeActions;
    appendEnforcementAudit = mod.appendEnforcementAudit;
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
      appendAction(TEST_TICKET, {
        step: 'check',
        what: 'BLOCKED: Skill(check)',
        meta: { rule: 1 },
      });

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
        {
          step: 'ticket',
          timestamp: '2026-02-26T20:00:30.000Z',
          what: 'mcp__atlassian__jira_get_issue',
        },
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
        {
          step: 'check',
          timestamp: '2026-02-26T20:01:00.000Z',
          what: 'BLOCKED: Skill(check) not in_progress',
        },
        {
          step: 'check',
          timestamp: '2026-02-26T20:02:00.000Z',
          what: 'BLOCKED: transition without evidence',
        },
        { step: 'check', timestamp: '2026-02-26T20:03:00.000Z', what: 'step reset' },
        { step: 'check', timestamp: '2026-02-26T20:05:00.000Z', what: 'Skill(check)' },
        { step: 'check', timestamp: '2026-02-26T20:10:00.000Z', what: 'step completed' },
      ];

      const result = analyzeActions(actions);
      const checkStep = result.steps.find((s) => s.step === 'check');
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

  // ─── IDEA2 / GH-219: Enforcement audit records ──────────────────────────────
  // Task 1 — R13 (shape) + R16 (schema evolution without breaking readers).
  // Enforcement records share the same `.work-actions.json` as legacy step rows
  // and are separated by an explicit `kind: 'enforcement'` discriminator.
  describe('appendEnforcementAudit', () => {
    it('should expose appendEnforcementAudit as a module export', () => {
      assert.strictEqual(
        typeof appendEnforcementAudit,
        'function',
        'work-actions must export appendEnforcementAudit for enforcement hooks to audit decisions'
      );
    });

    it('should write a record with all brief-required fields and kind discriminator', () => {
      appendEnforcementAudit(TEST_TICKET, {
        origin: 'workflow',
        task: 1,
        phase: 'red',
        action: 'Write',
        allow: true,
        reason: 'write allowed: path matches claimed task artifact root',
        outputPath: '/tmp/fake/tasks/GH-219/task1/implement.md',
      });

      const actions = loadActions(TEST_TICKET);
      assert.strictEqual(actions.length, 1, 'one record should be appended');
      const row = actions[0];

      assert.strictEqual(row.kind, 'enforcement', 'discriminator must be kind: "enforcement"');
      assert.ok(row.timestamp, 'must include timestamp');
      assert.match(
        row.timestamp,
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
        'timestamp must be ISO 8601'
      );
      assert.strictEqual(row.origin, 'workflow', 'must record origin');
      assert.strictEqual(row.task, 1, 'must record task');
      assert.strictEqual(row.phase, 'red', 'must record phase');
      assert.strictEqual(row.action, 'Write', 'must record action (tool name)');
      assert.strictEqual(row.allow, true, 'must record allow/deny as a boolean');
      assert.strictEqual(
        row.reason,
        'write allowed: path matches claimed task artifact root',
        'must record reason'
      );
      assert.strictEqual(
        row.outputPath,
        '/tmp/fake/tasks/GH-219/task1/implement.md',
        'must record outputPath'
      );
    });

    it('should record deny decisions with allow=false and preserve reason/outputPath', () => {
      appendEnforcementAudit(TEST_TICKET, {
        origin: 'user',
        task: null,
        phase: null,
        action: 'Edit',
        allow: false,
        reason: 'deny: unclaimed task write attempted by user origin',
        outputPath: '/tmp/fake/repo/src/index.ts',
      });

      const actions = loadActions(TEST_TICKET);
      assert.strictEqual(actions[0].kind, 'enforcement');
      assert.strictEqual(actions[0].allow, false);
      assert.strictEqual(actions[0].origin, 'user');
      assert.strictEqual(actions[0].task, null);
      assert.strictEqual(actions[0].phase, null);
      assert.strictEqual(actions[0].action, 'Edit');
      assert.match(actions[0].reason, /deny/);
    });

    it('should pass through optional meta without dropping required fields', () => {
      appendEnforcementAudit(TEST_TICKET, {
        origin: 'ai-subtask',
        task: 2,
        phase: 'green',
        action: 'Bash',
        allow: true,
        reason: 'allow: command inside PR1 worker root',
        outputPath: null,
        meta: { ruleId: 'path-allowed', prSlot: 'PR1' },
      });

      const row = loadActions(TEST_TICKET)[0];
      assert.strictEqual(row.kind, 'enforcement');
      assert.deepStrictEqual(row.meta, { ruleId: 'path-allowed', prSlot: 'PR1' });
      assert.strictEqual(row.outputPath, null);
    });

    it('should coexist with legacy appendAction rows in the same .work-actions.json', () => {
      appendAction(TEST_TICKET, { step: 'implement', what: 'step started' });
      appendEnforcementAudit(TEST_TICKET, {
        origin: 'workflow',
        task: 1,
        phase: 'red',
        action: 'Write',
        allow: true,
        reason: 'allow: claimed task write',
        outputPath: '/tmp/fake/tasks/GH-219/task1/implement.md',
      });
      appendAction(TEST_TICKET, { step: 'implement', what: 'step completed' });

      const rows = loadActions(TEST_TICKET);
      assert.strictEqual(rows.length, 3);

      const legacyRows = rows.filter((r) => r.kind !== 'enforcement');
      const enforcementRows = rows.filter((r) => r.kind === 'enforcement');
      assert.strictEqual(legacyRows.length, 2, 'legacy rows are not enforcement rows');
      assert.strictEqual(enforcementRows.length, 1, 'enforcement rows are discriminated');
      assert.strictEqual(legacyRows[0].step, 'implement');
      assert.strictEqual(legacyRows[0].what, 'step started');
      assert.strictEqual(legacyRows[1].what, 'step completed');
    });
  });

  describe('loadActions / analyzeActions backward compatibility (R16)', () => {
    // Fixture mirrors a pre-IDEA2 .work-actions.json: only legacy rows, no `kind` field.
    const preIdea2Fixture = [
      { step: 'ticket', timestamp: '2026-01-05T10:00:00.000Z', what: 'workflow started' },
      { step: 'ticket', timestamp: '2026-01-05T10:00:00.500Z', what: 'step started' },
      {
        step: 'ticket',
        timestamp: '2026-01-05T10:00:30.000Z',
        what: 'mcp__atlassian__jira_get_issue',
      },
      { step: 'ticket', timestamp: '2026-01-05T10:01:00.000Z', what: 'step completed' },
      { step: 'bootstrap', timestamp: '2026-01-05T10:01:00.000Z', what: 'step started' },
      {
        step: 'bootstrap',
        timestamp: '2026-01-05T10:01:30.000Z',
        what: 'BLOCKED: Skill(bootstrap)',
      },
      { step: 'bootstrap', timestamp: '2026-01-05T10:02:30.000Z', what: 'step reset' },
      { step: 'bootstrap', timestamp: '2026-01-05T10:03:00.000Z', what: 'step completed' },
    ];

    it('loadActions parses a pre-IDEA2 .work-actions.json without throwing', () => {
      const dir = path.join(FAKE_HOME, 'worktrees', 'tasks', TEST_TICKET);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.work-actions.json'),
        JSON.stringify(preIdea2Fixture, null, 2)
      );

      const loaded = loadActions(TEST_TICKET);
      assert.strictEqual(loaded.length, preIdea2Fixture.length);
      assert.strictEqual(loaded[0].what, 'workflow started');
      for (const row of loaded) {
        assert.ok(!('kind' in row), 'legacy rows must not gain a kind field on read');
      }
    });

    it('analyzeActions handles a pre-IDEA2 fixture without throwing and still computes steps', () => {
      const result = analyzeActions(preIdea2Fixture);
      assert.strictEqual(result.actionCount, preIdea2Fixture.length);
      const ticketStep = result.steps.find((s) => s.step === 'ticket');
      const bootstrapStep = result.steps.find((s) => s.step === 'bootstrap');
      assert.ok(ticketStep, 'ticket step analysed');
      assert.ok(bootstrapStep, 'bootstrap step analysed');
      assert.strictEqual(ticketStep.duration, '60s');
      assert.strictEqual(bootstrapStep.duration, '120s');
      assert.strictEqual(bootstrapStep.blockCount, 1);
      assert.strictEqual(bootstrapStep.retryCount, 1);
    });

    it('analyzeActions does not throw when enforcement rows are mixed with legacy rows', () => {
      const mixed = [
        ...preIdea2Fixture,
        {
          kind: 'enforcement',
          timestamp: '2026-01-05T10:03:30.000Z',
          origin: 'workflow',
          task: 1,
          phase: 'red',
          action: 'Write',
          allow: true,
          reason: 'allow: claim matches',
          outputPath: '/tmp/fake/tasks/GH-219/task1/implement.md',
        },
      ];

      let result;
      assert.doesNotThrow(() => {
        result = analyzeActions(mixed);
      });
      assert.strictEqual(
        result.actionCount,
        mixed.length,
        'enforcement rows counted but do not corrupt step analysis'
      );
      const ticketStep = result.steps.find((s) => s.step === 'ticket');
      assert.strictEqual(
        ticketStep && ticketStep.duration,
        '60s',
        'ticket step duration unchanged by enforcement row'
      );
    });
  });
});
