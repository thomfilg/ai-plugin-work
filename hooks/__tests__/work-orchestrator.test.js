/**
 * Tests for work-orchestrator.js
 *
 * Uses node:test + node:assert/strict.
 * Run: node --test hooks/__tests__/work-orchestrator.test.js
 */

const { describe, it, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOOK_PATH = path.join(__dirname, '..', 'work-orchestrator.js');
const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
const TASKS_BASE = getConfig.require('TASKS_BASE');

// ─── Helpers ────────────────────────────────────────────────────────────────

function runOrchestrator(args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Intentionally disable session guard + TDD gate to isolate orchestrator plan logic.
      // Session guard has dedicated tests in session-guard.test.js (26 tests covering all subcommands + hooks).
      env: { ...process.env, SESSION_GUARD_ENABLED: '0', WORK_TDD_ENFORCE: '0', ...opts.env },
      cwd: opts.cwd,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      try {
        const result = stdout.trim() ? JSON.parse(stdout.trim()) : null;
        resolve({ result, stdout, stderr, code });
      } catch (e) {
        resolve({ result: null, stdout, stderr, code, parseError: e.message });
      }
    });

    proc.on('error', reject);
  });
}

function cleanupTempWorkState(ticket) {
  const dir = path.join(TASKS_BASE, ticket);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ─── Global Cleanup ─────────────────────────────────────────────────────────

after(() => {
  try {
    const entries = fs.readdirSync(TASKS_BASE);
    for (const entry of entries) {
      if (entry.startsWith('TEST-')) {
        fs.rmSync(path.join(TASKS_BASE, entry), { recursive: true, force: true });
      }
    }
  } catch {}
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('work-orchestrator.js', () => {

  describe('CLI usage', () => {
    it('should show error when no arguments provided', async () => {
      const { result, code } = await runOrchestrator([]);
      assert.equal(code, 1);
      assert.equal(result.error, true);
      assert.ok(result.message.includes('Usage'));
    });

    it('should show error when plan command has no ticket', async () => {
      const { result, code } = await runOrchestrator(['plan']);
      assert.equal(code, 1);
      assert.equal(result.error, true);
      assert.ok(result.message.includes('Provide ticket ID or description'));
    });
  });

  describe('graph command', () => {
    it('should output the state machine graph', async () => {
      const { result, code } = await runOrchestrator(['graph']);
      assert.equal(code, 0);
      assert.ok(result.steps);
      assert.ok(result.transitions);
      assert.ok(result.steps.includes('ticket'));
      assert.ok(result.steps.includes('complete'));
      assert.equal(result.steps.length, 15);
    });

    it('should have valid transitions for each step', async () => {
      const { result } = await runOrchestrator(['graph']);
      for (const step of result.steps) {
        assert.ok(step in result.transitions, `Missing transition for ${step}`);
        assert.ok(Array.isArray(result.transitions[step]));
      }
      assert.ok(result.transitions['ticket'].includes('bootstrap'));
      assert.deepEqual(result.transitions['complete'], []);
    });

    it('should include retry loop transitions', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.ok(result.transitions['check'].includes('implement'));
      assert.ok(result.transitions['ci'].includes('implement'));
      assert.ok(result.transitions['ci'].includes('test_enhancement'));
    });

    it('should include skip edge transitions', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.ok(result.transitions['bootstrap'].includes('quality'));
      assert.ok(result.transitions['bootstrap'].includes('commit'));
      assert.ok(result.transitions['bootstrap'].includes('check'));
    });
  });

  describe('plan command', () => {
    const TEST_TICKET = 'TEST-999';
    afterEach(() => { cleanupTempWorkState(TEST_TICKET); });

    it('should generate a plan for a new ticket', async () => {
      const { result, code } = await runOrchestrator([TEST_TICKET]);
      assert.equal(code, 0);
      assert.equal(result.ticket, TEST_TICKET);
      assert.equal(result.mode, 'resume');
      assert.ok(result.plan);
      assert.ok(result.summary);
      assert.ok(result.timestamp);
    });

    it('should detect ticket format correctly', async () => {
      const { result: ticketResult } = await runOrchestrator(['PROJ-123']);
      assert.equal(ticketResult.ticket, 'PROJ-123');

      const { result: descResult } = await runOrchestrator(['add new feature']);
      assert.ok(descResult.ticket.includes('TBD'));
      assert.ok(descResult.ticket.includes('add new feature'));
    });

    it('should include all required steps in plan', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      const stepNames = result.plan.map((s) => s.step);
      for (const expected of [
        'ticket', 'bootstrap', 'brief', 'spec', 'implement', 'quality',
        'commit', 'check', 'cleanup', 'test_enhancement',
        'pr', 'ready', 'ci', 'reports', 'complete',
      ]) {
        assert.ok(stepNames.includes(expected), `Missing step: ${expected}`);
      }
    });

    it('should generate summary with correct counts', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      assert.ok('total' in result.summary);
      assert.ok('run' in result.summary);
      assert.ok('skip' in result.summary);
      assert.ok('pending' in result.summary);
      assert.ok('firstAction' in result.summary);
      assert.ok('stepsToRun' in result.summary);
      assert.ok('stepsSkipped' in result.summary);
      assert.equal(result.summary.total, result.summary.run + result.summary.skip + result.summary.pending);
    });

    it('should use rework mode when --rework flag is passed', async () => {
      const { result } = await runOrchestrator([TEST_TICKET, '--rework']);
      assert.equal(result.mode, 'rework');
      const checkStep = result.plan.find((s) => s.step === 'check');
      assert.equal(checkStep.action, 'RUN');
      assert.ok(checkStep.reason.includes('REWORK'));
    });

    it('should include preCommands in rework mode for 6_check', async () => {
      const { result } = await runOrchestrator([TEST_TICKET, '--rework']);
      const checkStep = result.plan.find((s) => s.step === 'check');
      assert.ok(checkStep.preCommands);
      assert.ok(checkStep.preCommands.length > 0);
    });

    it('should auto-detect GitHub provider from #N shorthand when no provider configured', async () => {
      // Fully isolate: fake HOME prevents reading real ~/.claude/ticket-providers.json,
      // non-git cwd prevents getRemoteOriginUrl() from matching, and temp WORKTREES_BASE
      // prevents cleanup from touching real tasks directories.
      const tmpBase = path.join(os.tmpdir(), 'work-orch-gh-shorthand-' + process.pid);
      const tmpHome = path.join(tmpBase, 'home');
      const tmpWb = path.join(tmpBase, 'worktrees');
      fs.mkdirSync(tmpHome, { recursive: true });
      fs.mkdirSync(tmpWb, { recursive: true });
      try {
        const { result, code } = await runOrchestrator(['#42'], {
          env: {
            TICKET_PROVIDER: '',
            HOME: tmpHome,
            USERPROFILE: tmpHome,
            WORKTREES_BASE: tmpWb,
            JIRA_PROJECT_KEY: '',
            JIRA_BASE_URL: '',
            TICKET_PROJECT_KEY: '',
            LINEAR_TEAM_ID: '',
          },
          cwd: tmpHome,
        });
        assert.equal(code, 0);
        assert.equal(result.ticket, '#42');
      } finally {
        try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (e) { console.warn('cleanup failed:', e.message); }
      }
    });
  });

  describe('transitions command', () => {
    const TEST_TICKET = 'TEST-888';
    afterEach(() => { cleanupTempWorkState(TEST_TICKET); });

    it('should show error when no ticket provided', async () => {
      const { result, code } = await runOrchestrator(['transitions']);
      assert.equal(code, 1);
      assert.equal(result.error, true);
      assert.ok(result.message.includes('Usage'));
    });

    it('should return current step and allowed transitions', async () => {
      const { result } = await runOrchestrator(['transitions', TEST_TICKET]);
      assert.ok('ticket' in result);
      assert.ok('currentStep' in result);
      assert.ok('allowed' in result);
      assert.ok(Array.isArray(result.allowed));
    });

    it('should convert ticket to uppercase', async () => {
      const { result } = await runOrchestrator(['transitions', 'test-888']);
      assert.equal(result.ticket, 'TEST-888');
    });
  });

  describe('transition command', () => {
    const TEST_TICKET = 'TEST-777';
    const TEMP_WB = path.join(os.tmpdir(), 'work-orch-trans-' + process.pid);
    const TEMP_TASKS_DIR = path.join(TEMP_WB, 'tasks');
    const transOpts = { env: { WORKTREES_BASE: TEMP_WB } };
    after(() => { try { fs.rmSync(TEMP_WB, { recursive: true, force: true }); } catch {} });
    afterEach(() => {
      try { fs.rmSync(path.join(TEMP_TASKS_DIR, TEST_TICKET), { recursive: true, force: true }); } catch {}
    });

    it('should show error when missing arguments', async () => {
      const { result, code } = await runOrchestrator(['transition']);
      assert.equal(code, 1);
      assert.equal(result.error, true);
      assert.ok(result.message.includes('Usage'));
      assert.ok(result.validSteps);
    });

    it('should show error when target step is invalid', async () => {
      const { result } = await runOrchestrator(['transition', TEST_TICKET, 'invalid_step']);
      assert.equal(result.error, true);
      assert.ok(result.message.includes('Invalid step'));
      assert.ok(result.validSteps);
    });

    it('should allow valid transition from 1_ticket to 2_bootstrap', async () => {
      const { result } = await runOrchestrator(['transition', TEST_TICKET, 'bootstrap'], transOpts);
      assert.equal(result.success, true);
      assert.equal(result.from, 'ticket');
      assert.equal(result.to, 'bootstrap');
      assert.equal(result.direction, 'forward');
    });

    it('should block invalid transition', async () => {
      await runOrchestrator(['transition', TEST_TICKET, 'bootstrap'], transOpts);
      await runOrchestrator(['transition', TEST_TICKET, 'implement'], transOpts);
      const { result } = await runOrchestrator(['transition', TEST_TICKET, 'pr'], transOpts);
      assert.equal(result.error, true);
      assert.ok(result.message.includes('BLOCKED'));
      assert.ok(result.allowed);
      assert.ok(result.hint);
    });

    it('should allow retry loop (backward transition)', async () => {
      await runOrchestrator(['transition', TEST_TICKET, 'bootstrap'], transOpts);
      await runOrchestrator(['transition', TEST_TICKET, 'check'], transOpts);
      const { result } = await runOrchestrator(['transition', TEST_TICKET, 'implement'], transOpts);
      assert.equal(result.success, true);
      assert.equal(result.from, 'check');
      assert.equal(result.to, 'implement');
      assert.equal(result.direction, 'backward');
    });

    it('should allow skip edge transition', async () => {
      await runOrchestrator(['transition', TEST_TICKET, 'bootstrap'], transOpts);
      const { result } = await runOrchestrator(['transition', TEST_TICKET, 'check'], transOpts);
      assert.equal(result.success, true);
      assert.equal(result.from, 'bootstrap');
      assert.equal(result.to, 'check');
    });

    it('should persist state after transition', async () => {
      await runOrchestrator(['transition', TEST_TICKET, 'bootstrap'], transOpts);
      await runOrchestrator(['transition', TEST_TICKET, 'implement'], transOpts);
      const { result } = await runOrchestrator(['transitions', TEST_TICKET], transOpts);
      assert.equal(result.currentStep, 'implement');
      assert.equal(result.allStatuses['ticket'], 'completed');
      assert.equal(result.allStatuses['bootstrap'], 'completed');
      assert.equal(result.allStatuses['implement'], 'in_progress');
    });

    it('should reset intermediate steps on backward transition', async () => {
      await runOrchestrator(['transition', TEST_TICKET, 'bootstrap']);
      await runOrchestrator(['transition', TEST_TICKET, 'implement']);
      await runOrchestrator(['transition', TEST_TICKET, 'quality']);
      await runOrchestrator(['transition', TEST_TICKET, 'commit']);
      await runOrchestrator(['transition', TEST_TICKET, 'check']);
      await runOrchestrator(['transition', TEST_TICKET, 'implement']);
      const { result } = await runOrchestrator(['transitions', TEST_TICKET]);
      assert.equal(result.allStatuses['quality'], 'pending');
      assert.equal(result.allStatuses['commit'], 'pending');
      assert.equal(result.allStatuses['check'], 'pending');
    });
  });

  describe('state machine logic', () => {
    it('should have 15 steps total', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.equal(result.steps.length, 15);
    });

    it('should not allow self-transitions', async () => {
      const { result } = await runOrchestrator(['graph']);
      for (const step of result.steps) {
        assert.ok(!result.transitions[step].includes(step), `${step} has self-transition`);
      }
    });

    it('should have terminal state at complete', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.deepEqual(result.transitions['complete'], []);
    });

    it('should have exactly one entry point', async () => {
      const { result } = await runOrchestrator(['graph']);
      const allTargets = new Set();
      for (const targets of Object.values(result.transitions)) {
        targets.forEach((t) => allTargets.add(t));
      }
      const entryPoints = result.steps.filter((s) => !allTargets.has(s));
      assert.deepEqual(entryPoints, ['ticket']);
    });
  });

  describe('plan action types', () => {
    const TEST_TICKET = 'TEST-666';
    afterEach(() => { cleanupTempWorkState(TEST_TICKET); });

    it('should use RUN for steps that need execution', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      const runSteps = result.plan.filter((s) => s.action === 'RUN');
      assert.ok(runSteps.length > 0);
      for (const step of runSteps) {
        assert.ok('reason' in step, `RUN step ${step.step} missing reason`);
      }
    });

    it('should use PENDING for steps dependent on earlier steps', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      const qualityStep = result.plan.find((s) => s.step === 'quality');
      const commitStep = result.plan.find((s) => s.step === 'commit');
      assert.equal(qualityStep.action, 'PENDING');
      assert.equal(commitStep.action, 'PENDING');
    });

    it('should include command for RUN steps', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      const runSteps = result.plan.filter((s) => s.action === 'RUN');
      for (const step of runSteps) {
        if (step.command) {
          assert.equal(typeof step.command, 'string');
        }
      }
    });
  });

  describe('ticket format handling', () => {
    it('should accept uppercase ticket IDs', async () => {
      const { result } = await runOrchestrator(['PROJ-123']);
      assert.equal(result.ticket, 'PROJ-123');
    });

    it('should convert lowercase ticket IDs to uppercase', async () => {
      const { result } = await runOrchestrator(['proj-123']);
      assert.equal(result.ticket, 'PROJ-123');
    });

    it('should treat non-ticket format as description', async () => {
      const { result } = await runOrchestrator(['fix the login bug']);
      assert.ok(result.ticket.includes('TBD'));
      assert.ok(result.ticket.includes('fix the login bug'));
    });

    it('should handle multi-word descriptions', async () => {
      const { result } = await runOrchestrator(['add', 'new', 'authentication', 'feature']);
      assert.ok(result.ticket.includes('add new authentication feature'));
    });
  });

  describe('agentType and agentPrompt fields', () => {
    const TEST_TICKET = 'TEST-444';
    afterEach(() => { cleanupTempWorkState(TEST_TICKET); });

    it('should include agentType and agentPrompt for RUN steps', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      const runSteps = result.plan.filter((s) => s.action === 'RUN');
      assert.ok(runSteps.length > 0);
      for (const step of runSteps) {
        assert.ok('agentType' in step, `RUN step ${step.step} missing agentType`);
        assert.ok('agentPrompt' in step, `RUN step ${step.step} missing agentPrompt`);
        assert.equal(typeof step.agentType, 'string');
        assert.equal(typeof step.agentPrompt, 'string');
        assert.ok(step.agentType.length > 0);
        assert.ok(step.agentPrompt.length > 0);
      }
    });

    it('should not include agentType for SKIP steps', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      const skipSteps = result.plan.filter((s) => s.action === 'SKIP');
      for (const step of skipSteps) {
        assert.equal(step.agentType, undefined);
        assert.equal(step.agentPrompt, undefined);
      }
    });

    it('should not include agentType for PENDING steps', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      const pendingSteps = result.plan.filter((s) => s.action === 'PENDING');
      for (const step of pendingSteps) {
        assert.equal(step.agentType, undefined);
        assert.equal(step.agentPrompt, undefined);
      }
    });

    it('should use general-purpose for 1_ticket fetch when ticket exists', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      const ticketStep = result.plan.find((s) => s.step === 'ticket');
      assert.equal(ticketStep.agentType, 'general-purpose');
      assert.ok(ticketStep.agentPrompt.includes(TEST_TICKET));
    });

    it('should use appropriate agent for 1_ticket when no ticket (description mode)', async () => {
      const { result } = await runOrchestrator(['add login feature']);
      const ticketStep = result.plan.find((s) => s.step === 'ticket');
      // Without TICKET_PROVIDER env, falls back to general-purpose
      assert.ok(['jira-task-creator', 'general-purpose'].includes(ticketStep.agentType));
      assert.ok(ticketStep.agentPrompt.includes('add login feature'));
    });

    it('should use Bash agent for 11_ci', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      const ciStep = result.plan.find((s) => s.step === 'ci');
      assert.equal(ciStep.agentType, 'Bash');
      assert.ok(ciStep.agentPrompt.includes('gh pr checks'));
    });

    it('should use Bash agent for complete', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      const completeStep = result.plan.find((s) => s.step === 'complete');
      assert.equal(completeStep.agentType, 'Bash');
      assert.ok(completeStep.agentPrompt.includes('work-state.js'));
      assert.ok(completeStep.agentPrompt.includes('complete'));
      assert.ok(completeStep.agentPrompt.includes('session-guard.js'));
      assert.ok(completeStep.agentPrompt.includes('finish'));
    });

    it('should use Bash agent for reports', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      const reportsStep = result.plan.find((s) => s.step === 'reports');
      assert.equal(reportsStep.agentType, 'Bash');
    });

    it('should use skill for bootstrap', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      const bootstrapStep = result.plan.find((s) => s.step === 'bootstrap');
      if (bootstrapStep.action === 'RUN') {
        assert.equal(bootstrapStep.agentType, 'skill');
        assert.ok(bootstrapStep.agentPrompt.includes('bootstrap'));
      }
    });

    it('should handle 2b_transition based on provider', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      const transStep = result.plan.find((s) => s.step === '2b_transition');
      // May be SKIP (no provider) or RUN (jira/linear)
      if (transStep.action === 'RUN') {
        assert.equal(transStep.agentType, 'general-purpose');
        assert.ok(transStep.agentPrompt.includes('transition') || transStep.agentPrompt.includes('Transition'));
      } else {
        assert.equal(transStep.action, 'SKIP');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Patch 14: New transition edges
  // ═══════════════════════════════════════════════════════════════════════════

  describe('new transition edges (Patch 14)', () => {
    it('should include 5_commit → 4_quality (quality re-verify)', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.ok(result.transitions['commit'].includes('quality'));
    });

    it('should include 6_check → 4_quality (quality re-run)', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.ok(result.transitions['check'].includes('quality'));
    });

    it('should include 8_test_enhancement → 4_quality (new tests need quality)', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.ok(result.transitions['test_enhancement'].includes('quality'));
    });

    it('should include 8_test_enhancement → 3_implement (tests reveal impl flaw)', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.ok(result.transitions['test_enhancement'].includes('implement'));
    });

    it('should include 9_pr → 11_ci (skip 10_ready)', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.ok(result.transitions['pr'].includes('ci'));
    });

    it('should allow transition from 6_check → 4_quality', async () => {
      const TMP = path.join(os.tmpdir(), 'work-orch-p14a-' + process.pid);
      const T = 'TEST-614';
      const o = { env: { WORKTREES_BASE: TMP } };
      try {
        await runOrchestrator(['transition', T, 'bootstrap'], o);
        await runOrchestrator(['transition', T, 'check'], o);
        const { result } = await runOrchestrator(['transition', T, 'quality'], o);
        assert.equal(result.success, true);
        assert.equal(result.direction, 'backward');
      } finally {
        try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
      }
    });

    it('should allow transition from 8_test_enhancement → 3_implement', async () => {
      const TMP = path.join(os.tmpdir(), 'work-orch-p14b-' + process.pid);
      const T = 'TEST-813';
      const o = { env: { WORKTREES_BASE: TMP, WORK_TDD_ENFORCE: '0' } };
      try {
        await runOrchestrator(['transition', T, 'bootstrap'], o);
        await runOrchestrator(['transition', T, 'check'], o);
        await runOrchestrator(['transition', T, 'test_enhancement'], o);
        const { result } = await runOrchestrator(['transition', T, 'implement'], o);
        assert.equal(result.success, true);
        assert.equal(result.direction, 'backward');
      } finally {
        try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
      }
    });

    it('should allow transition from 9_pr → 11_ci (skip 10_ready)', async () => {
      const TEST_TICKET = 'TEST-911';
      const o = { env: { WORK_TDD_ENFORCE: '0' } };
      try {
        await runOrchestrator(['transition', TEST_TICKET, 'bootstrap'], o);
        await runOrchestrator(['transition', TEST_TICKET, 'check'], o);
        await runOrchestrator(['transition', TEST_TICKET, 'test_enhancement'], o);
        await runOrchestrator(['transition', TEST_TICKET, 'pr'], o);
        const { result } = await runOrchestrator(['transition', TEST_TICKET, 'ci'], o);
        assert.equal(result.success, true);
        assert.equal(result.from, 'pr');
        assert.equal(result.to, 'ci');
      } finally {
        cleanupTempWorkState(TEST_TICKET);
      }
    });

    it('should reset intermediate steps when skipping 9_pr → 11_ci', async () => {
      const TEST_TICKET = 'TEST-912';
      const o = { env: { WORK_TDD_ENFORCE: '0' } };
      try {
        await runOrchestrator(['transition', TEST_TICKET, 'bootstrap'], o);
        await runOrchestrator(['transition', TEST_TICKET, 'check'], o);
        await runOrchestrator(['transition', TEST_TICKET, 'test_enhancement'], o);
        await runOrchestrator(['transition', TEST_TICKET, 'pr'], o);
        await runOrchestrator(['transition', TEST_TICKET, 'ci'], o);
        const { result } = await runOrchestrator(['transitions', TEST_TICKET], o);
        // ready should be marked completed (skipped)
        assert.equal(result.allStatuses['ready'], 'completed');
        assert.equal(result.allStatuses['ci'], 'in_progress');
      } finally {
        cleanupTempWorkState(TEST_TICKET);
      }
    });
  });

  describe('error handling', () => {
    it('should handle missing work state gracefully', async () => {
      const { result, code } = await runOrchestrator(['TEST-99999']);
      assert.equal(code, 0);
      assert.equal(result.ticket, 'TEST-99999');
      assert.ok(result.plan);
    });

    it('should handle invalid transition subcommand args', async () => {
      const { result, code } = await runOrchestrator(['transition', 'TICKET']);
      assert.equal(code, 1);
      assert.equal(result.error, true);
    });
  });

  describe('summary output', () => {
    const TEST_TICKET = 'TEST-555';
    afterEach(() => { cleanupTempWorkState(TEST_TICKET); });

    it('should include stepsToRun array', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      assert.ok(Array.isArray(result.summary.stepsToRun));
      assert.equal(result.summary.stepsToRun.length, result.summary.run);
    });

    it('should include stepsSkipped array', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      assert.ok(Array.isArray(result.summary.stepsSkipped));
      assert.equal(result.summary.stepsSkipped.length, result.summary.skip);
    });

    it('should identify firstAction correctly', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      if (result.summary.run > 0) {
        assert.equal(result.summary.firstAction, result.summary.stepsToRun[0]);
      } else {
        assert.equal(result.summary.firstAction, 'none');
      }
    });
  });

  // ─── Integration Tests ──────────────────────────────────────────────────────

  describe('integration: orchestrator ↔ state machine', () => {
    const TEMP_WB = path.join(os.tmpdir(), 'work-orch-integ-' + process.pid);
    const TEMP_TASKS = path.join(TEMP_WB, 'tasks');
    const TICKET = 'TEST-8888';
    const envOpts = { env: { WORKTREES_BASE: TEMP_WB, WORK_TDD_ENFORCE: '0' } };

    after(() => {
      try { fs.rmSync(TEMP_WB, { recursive: true, force: true }); } catch {}
    });

    afterEach(() => {
      try { fs.rmSync(path.join(TEMP_TASKS, TICKET), { recursive: true, force: true }); } catch {}
    });

    it('should handle retry loop: 6_check → 3_implement → 4_quality → 5_commit → 6_check', async () => {
      // Build up to 6_check
      await runOrchestrator(['transition', TICKET, 'bootstrap'], envOpts);
      await runOrchestrator(['transition', TICKET, 'check'], envOpts);

      // Retry to implement
      const r1 = await runOrchestrator(['transition', TICKET, 'implement'], envOpts);
      assert.equal(r1.result.success, true);
      assert.equal(r1.result.direction, 'backward');

      // Forward through: implement→quality→commit→check
      const r2 = await runOrchestrator(['transition', TICKET, 'quality'], envOpts);
      assert.equal(r2.result.success, true);
      const r3 = await runOrchestrator(['transition', TICKET, 'commit'], envOpts);
      assert.equal(r3.result.success, true);
      const r4 = await runOrchestrator(['transition', TICKET, 'check'], envOpts);
      assert.equal(r4.result.success, true);
    });

    it('should resume from mid-workflow: plan reflects state', async () => {
      // Build state up to check
      await runOrchestrator(['transition', TICKET, 'bootstrap'], envOpts);
      await runOrchestrator(['transition', TICKET, 'check'], envOpts);

      // Get plan — currentStep should reflect check
      const { result } = await runOrchestrator(['plan', TICKET], envOpts);
      assert.ok(result.plan);
      assert.equal(result.currentStep, 'check');
    });

    it('should round-trip: work-state CLI init → set-step → get', async () => {
      const WORK_STATE_PATH = path.join(__dirname, '..', 'work-state.js');
      const stateEnv = { env: { TASKS_BASE: TEMP_TASKS, WORKTREES_BASE: TEMP_WB } };

      function runWorkState(args) {
        return new Promise((resolve) => {
          const proc = spawn('node', [WORK_STATE_PATH, ...args], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...stateEnv.env },
          });
          let out = '';
          proc.stdout.on('data', d => { out += d.toString(); });
          proc.on('close', (code) => {
            try { resolve({ result: JSON.parse(out.trim()), code }); }
            catch { resolve({ result: null, raw: out, code }); }
          });
        });
      }

      // Init
      const r1 = await runWorkState(['init', TICKET]);
      assert.ok(r1.result);

      // Set step
      await runWorkState(['set-step', TICKET, 'implement', 'in_progress']);

      // Get
      const r3 = await runWorkState(['get', TICKET]);
      assert.ok(r3.result);
      assert.equal(r3.result.stepStatus['implement'], 'in_progress');
    });
  });
});
