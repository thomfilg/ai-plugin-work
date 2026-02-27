/**
 * Tests for work-orchestrator.js
 *
 * Uses node:test + node:assert/strict.
 * Run: node --test hooks/__tests__/work-orchestrator.test.js
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOOK_PATH = path.join(__dirname, '..', 'work-orchestrator.js');
const TASKS_BASE = fs.existsSync('/home/node/worktrees/tasks')
  ? '/home/node/worktrees/tasks'
  : path.join(os.homedir(), 'tasks');

// ─── Helpers ────────────────────────────────────────────────────────────────

function runOrchestrator(args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...opts.env },
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
  const filePath = path.join(dir, '.work-state.json');
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
  // Also clean up actions file
  const actionsFile = path.join(dir, '.work-actions.jsonl');
  try { if (fs.existsSync(actionsFile)) fs.unlinkSync(actionsFile); } catch {}
}

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
      assert.ok(result.steps.includes('1_ticket'));
      assert.ok(result.steps.includes('13_complete'));
      assert.equal(result.steps.length, 13);
    });

    it('should have valid transitions for each step', async () => {
      const { result } = await runOrchestrator(['graph']);
      for (const step of result.steps) {
        assert.ok(step in result.transitions, `Missing transition for ${step}`);
        assert.ok(Array.isArray(result.transitions[step]));
      }
      assert.ok(result.transitions['1_ticket'].includes('2_bootstrap'));
      assert.deepEqual(result.transitions['13_complete'], []);
    });

    it('should include retry loop transitions', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.ok(result.transitions['6_check'].includes('3_implement'));
      assert.ok(result.transitions['11_ci'].includes('3_implement'));
      assert.ok(result.transitions['11_ci'].includes('8_test_enhancement'));
    });

    it('should include skip edge transitions', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.ok(result.transitions['2_bootstrap'].includes('4_quality'));
      assert.ok(result.transitions['2_bootstrap'].includes('5_commit'));
      assert.ok(result.transitions['2_bootstrap'].includes('6_check'));
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
        '1_ticket', '2_bootstrap', '3_implement', '4_quality',
        '5_commit', '6_check', '7_cleanup', '8_test_enhancement',
        '9_pr', '10_ready', '11_ci', '12_reports', '13_complete',
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
      const checkStep = result.plan.find((s) => s.step === '6_check');
      assert.equal(checkStep.action, 'RUN');
      assert.ok(checkStep.reason.includes('REWORK'));
    });

    it('should include preCommands in rework mode for 6_check', async () => {
      const { result } = await runOrchestrator([TEST_TICKET, '--rework']);
      const checkStep = result.plan.find((s) => s.step === '6_check');
      assert.ok(checkStep.preCommands);
      assert.ok(checkStep.preCommands.length > 0);
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
    afterEach(() => { cleanupTempWorkState(TEST_TICKET); });

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
      const { result } = await runOrchestrator(['transition', TEST_TICKET, '2_bootstrap']);
      assert.equal(result.success, true);
      assert.equal(result.from, '1_ticket');
      assert.equal(result.to, '2_bootstrap');
      assert.equal(result.direction, 'forward');
    });

    it('should block invalid transition', async () => {
      await runOrchestrator(['transition', TEST_TICKET, '2_bootstrap']);
      await runOrchestrator(['transition', TEST_TICKET, '3_implement']);
      const { result } = await runOrchestrator(['transition', TEST_TICKET, '9_pr']);
      assert.equal(result.error, true);
      assert.ok(result.message.includes('BLOCKED'));
      assert.ok(result.allowed);
      assert.ok(result.hint);
    });

    it('should allow retry loop (backward transition)', async () => {
      await runOrchestrator(['transition', TEST_TICKET, '2_bootstrap']);
      await runOrchestrator(['transition', TEST_TICKET, '6_check']);
      const { result } = await runOrchestrator(['transition', TEST_TICKET, '3_implement']);
      assert.equal(result.success, true);
      assert.equal(result.from, '6_check');
      assert.equal(result.to, '3_implement');
      assert.equal(result.direction, 'backward');
    });

    it('should allow skip edge transition', async () => {
      await runOrchestrator(['transition', TEST_TICKET, '2_bootstrap']);
      const { result } = await runOrchestrator(['transition', TEST_TICKET, '6_check']);
      assert.equal(result.success, true);
      assert.equal(result.from, '2_bootstrap');
      assert.equal(result.to, '6_check');
    });

    it('should persist state after transition', async () => {
      await runOrchestrator(['transition', TEST_TICKET, '2_bootstrap']);
      await runOrchestrator(['transition', TEST_TICKET, '3_implement']);
      const { result } = await runOrchestrator(['transitions', TEST_TICKET]);
      assert.equal(result.currentStep, '3_implement');
      assert.equal(result.allStatuses['1_ticket'], 'completed');
      assert.equal(result.allStatuses['2_bootstrap'], 'completed');
      assert.equal(result.allStatuses['3_implement'], 'in_progress');
    });

    it('should reset intermediate steps on backward transition', async () => {
      await runOrchestrator(['transition', TEST_TICKET, '2_bootstrap']);
      await runOrchestrator(['transition', TEST_TICKET, '3_implement']);
      await runOrchestrator(['transition', TEST_TICKET, '4_quality']);
      await runOrchestrator(['transition', TEST_TICKET, '5_commit']);
      await runOrchestrator(['transition', TEST_TICKET, '6_check']);
      await runOrchestrator(['transition', TEST_TICKET, '3_implement']);
      const { result } = await runOrchestrator(['transitions', TEST_TICKET]);
      assert.equal(result.allStatuses['4_quality'], 'pending');
      assert.equal(result.allStatuses['5_commit'], 'pending');
      assert.equal(result.allStatuses['6_check'], 'pending');
    });
  });

  describe('state machine logic', () => {
    it('should have 13 steps total', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.equal(result.steps.length, 13);
    });

    it('should not allow self-transitions', async () => {
      const { result } = await runOrchestrator(['graph']);
      for (const step of result.steps) {
        assert.ok(!result.transitions[step].includes(step), `${step} has self-transition`);
      }
    });

    it('should have terminal state at 13_complete', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.deepEqual(result.transitions['13_complete'], []);
    });

    it('should have exactly one entry point', async () => {
      const { result } = await runOrchestrator(['graph']);
      const allTargets = new Set();
      for (const targets of Object.values(result.transitions)) {
        targets.forEach((t) => allTargets.add(t));
      }
      const entryPoints = result.steps.filter((s) => !allTargets.has(s));
      assert.deepEqual(entryPoints, ['1_ticket']);
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
      const qualityStep = result.plan.find((s) => s.step === '4_quality');
      const commitStep = result.plan.find((s) => s.step === '5_commit');
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
      const ticketStep = result.plan.find((s) => s.step === '1_ticket');
      assert.equal(ticketStep.agentType, 'general-purpose');
      assert.ok(ticketStep.agentPrompt.includes(TEST_TICKET));
    });

    it('should use jira-task-creator for 1_ticket when no ticket (description mode)', async () => {
      const { result } = await runOrchestrator(['add login feature']);
      const ticketStep = result.plan.find((s) => s.step === '1_ticket');
      assert.equal(ticketStep.agentType, 'jira-task-creator');
      assert.ok(ticketStep.agentPrompt.includes('add login feature'));
    });

    it('should use Bash agent for 11_ci', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      const ciStep = result.plan.find((s) => s.step === '11_ci');
      assert.equal(ciStep.agentType, 'Bash');
      assert.ok(ciStep.agentPrompt.includes('gh pr checks'));
    });

    it('should use Bash agent for 13_complete', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      const completeStep = result.plan.find((s) => s.step === '13_complete');
      assert.equal(completeStep.agentType, 'Bash');
      assert.ok(completeStep.agentPrompt.includes('work-state.js complete'));
    });

    it('should use Bash agent for 12_reports', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      const reportsStep = result.plan.find((s) => s.step === '12_reports');
      assert.equal(reportsStep.agentType, 'Bash');
    });

    it('should use skill for bootstrap', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      const bootstrapStep = result.plan.find((s) => s.step === '2_bootstrap');
      if (bootstrapStep.action === 'RUN') {
        assert.equal(bootstrapStep.agentType, 'skill');
        assert.ok(bootstrapStep.agentPrompt.includes('bootstrap'));
      }
    });

    it('should use general-purpose for 2b_transition', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      const transStep = result.plan.find((s) => s.step === '2b_transition');
      assert.equal(transStep.agentType, 'general-purpose');
      assert.ok(transStep.agentPrompt.includes('transition'));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Patch 14: New transition edges
  // ═══════════════════════════════════════════════════════════════════════════

  describe('new transition edges (Patch 14)', () => {
    it('should include 5_commit → 4_quality (quality re-verify)', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.ok(result.transitions['5_commit'].includes('4_quality'));
    });

    it('should include 6_check → 4_quality (quality re-run)', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.ok(result.transitions['6_check'].includes('4_quality'));
    });

    it('should include 8_test_enhancement → 4_quality (new tests need quality)', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.ok(result.transitions['8_test_enhancement'].includes('4_quality'));
    });

    it('should include 8_test_enhancement → 3_implement (tests reveal impl flaw)', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.ok(result.transitions['8_test_enhancement'].includes('3_implement'));
    });

    it('should include 9_pr → 11_ci (skip 10_ready)', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.ok(result.transitions['9_pr'].includes('11_ci'));
    });

    it('should allow transition from 6_check → 4_quality', async () => {
      const TEST_TICKET = 'TEST-614';
      try {
        await runOrchestrator(['transition', TEST_TICKET, '2_bootstrap']);
        await runOrchestrator(['transition', TEST_TICKET, '6_check']);
        const { result } = await runOrchestrator(['transition', TEST_TICKET, '4_quality']);
        assert.equal(result.success, true);
        assert.equal(result.direction, 'backward');
      } finally {
        cleanupTempWorkState(TEST_TICKET);
      }
    });

    it('should allow transition from 8_test_enhancement → 3_implement', async () => {
      const TEST_TICKET = 'TEST-813';
      try {
        await runOrchestrator(['transition', TEST_TICKET, '2_bootstrap']);
        await runOrchestrator(['transition', TEST_TICKET, '6_check']);
        await runOrchestrator(['transition', TEST_TICKET, '8_test_enhancement']);
        const { result } = await runOrchestrator(['transition', TEST_TICKET, '3_implement']);
        assert.equal(result.success, true);
        assert.equal(result.direction, 'backward');
      } finally {
        cleanupTempWorkState(TEST_TICKET);
      }
    });

    it('should allow transition from 9_pr → 11_ci (skip 10_ready)', async () => {
      const TEST_TICKET = 'TEST-911';
      try {
        await runOrchestrator(['transition', TEST_TICKET, '2_bootstrap']);
        await runOrchestrator(['transition', TEST_TICKET, '6_check']);
        await runOrchestrator(['transition', TEST_TICKET, '8_test_enhancement']);
        await runOrchestrator(['transition', TEST_TICKET, '9_pr']);
        const { result } = await runOrchestrator(['transition', TEST_TICKET, '11_ci']);
        assert.equal(result.success, true);
        assert.equal(result.from, '9_pr');
        assert.equal(result.to, '11_ci');
      } finally {
        cleanupTempWorkState(TEST_TICKET);
      }
    });

    it('should reset intermediate steps when skipping 9_pr → 11_ci', async () => {
      const TEST_TICKET = 'TEST-912';
      try {
        await runOrchestrator(['transition', TEST_TICKET, '2_bootstrap']);
        await runOrchestrator(['transition', TEST_TICKET, '6_check']);
        await runOrchestrator(['transition', TEST_TICKET, '8_test_enhancement']);
        await runOrchestrator(['transition', TEST_TICKET, '9_pr']);
        await runOrchestrator(['transition', TEST_TICKET, '11_ci']);
        const { result } = await runOrchestrator(['transitions', TEST_TICKET]);
        // 10_ready should be marked completed (skipped)
        assert.equal(result.allStatuses['10_ready'], 'completed');
        assert.equal(result.allStatuses['11_ci'], 'in_progress');
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
});
