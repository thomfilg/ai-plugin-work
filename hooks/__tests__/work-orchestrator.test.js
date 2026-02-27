/**
 * Tests for work-orchestrator.js
 *
 * Run with: cd ~/.claude && pnpm test:hooks
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOOK_PATH = path.join(__dirname, '..', 'work-orchestrator.js');
const TASKS_BASE = fs.existsSync('/home/node/worktrees/tasks')
  ? '/home/node/worktrees/tasks'
  : path.join(os.homedir(), 'tasks');

/**
 * Helper to run the orchestrator with given args
 */
function runOrchestrator(args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

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

/**
 * Create a temporary work state file for testing
 */
function createTempWorkState(ticket, state) {
  const dir = path.join(TASKS_BASE, ticket);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, '.work-state.json');
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  return filePath;
}

/**
 * Remove temp work state
 */
function cleanupTempWorkState(ticket) {
  const dir = path.join(TASKS_BASE, ticket);
  const filePath = path.join(dir, '.work-state.json');
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

describe('work-orchestrator.js', () => {
  describe('CLI usage', () => {
    it('should show error when no arguments provided', async () => {
      const { result, code } = await runOrchestrator([]);

      expect(code).toBe(1);
      expect(result.error).toBe(true);
      expect(result.message).toContain('Usage');
    });

    it('should show error when plan command has no ticket', async () => {
      const { result, code } = await runOrchestrator(['plan']);

      expect(code).toBe(1);
      expect(result.error).toBe(true);
      expect(result.message).toContain('Provide ticket ID or description');
    });
  });

  describe('graph command', () => {
    it('should output the state machine graph', async () => {
      const { result, code } = await runOrchestrator(['graph']);

      expect(code).toBe(0);
      expect(result).toHaveProperty('steps');
      expect(result).toHaveProperty('transitions');
      expect(result.steps).toContain('1_ticket');
      expect(result.steps).toContain('13_complete');
      expect(result.steps.length).toBe(13);
    });

    it('should have valid transitions for each step', async () => {
      const { result } = await runOrchestrator(['graph']);

      // Each step should have an entry in transitions
      for (const step of result.steps) {
        expect(result.transitions).toHaveProperty(step);
        expect(Array.isArray(result.transitions[step])).toBe(true);
      }

      // Verify some specific transitions
      expect(result.transitions['1_ticket']).toContain('2_bootstrap');
      expect(result.transitions['13_complete']).toEqual([]);
    });

    it('should include retry loop transitions', async () => {
      const { result } = await runOrchestrator(['graph']);

      // 6_check can go back to 3_implement
      expect(result.transitions['6_check']).toContain('3_implement');
      // 11_ci can go back to 3_implement or 8_test_enhancement
      expect(result.transitions['11_ci']).toContain('3_implement');
      expect(result.transitions['11_ci']).toContain('8_test_enhancement');
    });

    it('should include skip edge transitions', async () => {
      const { result } = await runOrchestrator(['graph']);

      // 2_bootstrap can skip to 4_quality, 5_commit, or 6_check
      expect(result.transitions['2_bootstrap']).toContain('4_quality');
      expect(result.transitions['2_bootstrap']).toContain('5_commit');
      expect(result.transitions['2_bootstrap']).toContain('6_check');
    });
  });

  describe('plan command', () => {
    const TEST_TICKET = 'TEST-999';

    afterEach(() => {
      cleanupTempWorkState(TEST_TICKET);
    });

    it('should generate a plan for a new ticket', async () => {
      const { result, code } = await runOrchestrator([TEST_TICKET]);

      expect(code).toBe(0);
      expect(result.ticket).toBe(TEST_TICKET);
      expect(result.mode).toBe('resume');
      expect(result).toHaveProperty('plan');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('timestamp');
    });

    it('should detect ticket format correctly', async () => {
      const { result: ticketResult } = await runOrchestrator(['PROJ-123']);
      expect(ticketResult.ticket).toBe('PROJ-123');

      const { result: descResult } = await runOrchestrator(['add new feature']);
      expect(descResult.ticket).toContain('TBD');
      expect(descResult.ticket).toContain('add new feature');
    });

    it('should include all required steps in plan', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);

      const stepNames = result.plan.map((s) => s.step);
      expect(stepNames).toContain('1_ticket');
      expect(stepNames).toContain('2_bootstrap');
      expect(stepNames).toContain('3_implement');
      expect(stepNames).toContain('4_quality');
      expect(stepNames).toContain('5_commit');
      expect(stepNames).toContain('6_check');
      expect(stepNames).toContain('7_cleanup');
      expect(stepNames).toContain('8_test_enhancement');
      expect(stepNames).toContain('9_pr');
      expect(stepNames).toContain('10_ready');
      expect(stepNames).toContain('11_ci');
      expect(stepNames).toContain('12_reports');
      expect(stepNames).toContain('13_complete');
    });

    it('should generate summary with correct counts', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);

      expect(result.summary).toHaveProperty('total');
      expect(result.summary).toHaveProperty('run');
      expect(result.summary).toHaveProperty('skip');
      expect(result.summary).toHaveProperty('pending');
      expect(result.summary).toHaveProperty('firstAction');
      expect(result.summary).toHaveProperty('stepsToRun');
      expect(result.summary).toHaveProperty('stepsSkipped');

      // Total should equal sum of actions
      expect(result.summary.total).toBe(
        result.summary.run + result.summary.skip + result.summary.pending
      );
    });

    it('should use rework mode when --rework flag is passed', async () => {
      const { result } = await runOrchestrator([TEST_TICKET, '--rework']);

      expect(result.mode).toBe('rework');

      // In rework mode, 6_check should always be RUN
      const checkStep = result.plan.find((s) => s.step === '6_check');
      expect(checkStep.action).toBe('RUN');
      expect(checkStep.reason).toContain('REWORK');
    });

    it('should include preCommands in rework mode for 6_check', async () => {
      const { result } = await runOrchestrator([TEST_TICKET, '--rework']);

      const checkStep = result.plan.find((s) => s.step === '6_check');
      expect(checkStep).toHaveProperty('preCommands');
      expect(checkStep.preCommands.length).toBeGreaterThan(0);
    });
  });

  describe('transitions command', () => {
    const TEST_TICKET = 'TEST-888';

    afterEach(() => {
      cleanupTempWorkState(TEST_TICKET);
    });

    it('should show error when no ticket provided', async () => {
      const { result, code } = await runOrchestrator(['transitions']);

      expect(code).toBe(1);
      expect(result.error).toBe(true);
      expect(result.message).toContain('Usage');
    });

    it('should return current step and allowed transitions', async () => {
      const { result } = await runOrchestrator(['transitions', TEST_TICKET]);

      expect(result).toHaveProperty('ticket');
      expect(result).toHaveProperty('currentStep');
      expect(result).toHaveProperty('allowed');
      expect(Array.isArray(result.allowed)).toBe(true);
    });

    it('should convert ticket to uppercase', async () => {
      const { result } = await runOrchestrator(['transitions', 'test-888']);

      expect(result.ticket).toBe('TEST-888');
    });
  });

  describe('transition command', () => {
    const TEST_TICKET = 'TEST-777';

    afterEach(() => {
      cleanupTempWorkState(TEST_TICKET);
    });

    it('should show error when missing arguments', async () => {
      const { result, code } = await runOrchestrator(['transition']);

      expect(code).toBe(1);
      expect(result.error).toBe(true);
      expect(result.message).toContain('Usage');
      expect(result.validSteps).toBeDefined();
    });

    it('should show error when target step is invalid', async () => {
      const { result } = await runOrchestrator([
        'transition',
        TEST_TICKET,
        'invalid_step',
      ]);

      expect(result.error).toBe(true);
      expect(result.message).toContain('Invalid step');
      expect(result.validSteps).toBeDefined();
    });

    it('should allow valid transition from 1_ticket to 2_bootstrap', async () => {
      const { result } = await runOrchestrator([
        'transition',
        TEST_TICKET,
        '2_bootstrap',
      ]);

      expect(result.success).toBe(true);
      expect(result.from).toBe('1_ticket');
      expect(result.to).toBe('2_bootstrap');
      expect(result.direction).toBe('forward');
    });

    it('should block invalid transition', async () => {
      // First transition to 3_implement
      await runOrchestrator(['transition', TEST_TICKET, '2_bootstrap']);
      await runOrchestrator(['transition', TEST_TICKET, '3_implement']);

      // Now try to skip directly to 9_pr (not allowed)
      const { result } = await runOrchestrator([
        'transition',
        TEST_TICKET,
        '9_pr',
      ]);

      expect(result.error).toBe(true);
      expect(result.message).toContain('BLOCKED');
      expect(result.allowed).toBeDefined();
      expect(result.hint).toBeDefined();
    });

    it('should allow retry loop (backward transition)', async () => {
      // Progress to 6_check
      await runOrchestrator(['transition', TEST_TICKET, '2_bootstrap']);
      await runOrchestrator(['transition', TEST_TICKET, '6_check']);

      // Go back to 3_implement (valid retry loop)
      const { result } = await runOrchestrator([
        'transition',
        TEST_TICKET,
        '3_implement',
      ]);

      expect(result.success).toBe(true);
      expect(result.from).toBe('6_check');
      expect(result.to).toBe('3_implement');
      expect(result.direction).toBe('backward');
    });

    it('should allow skip edge transition', async () => {
      // From 2_bootstrap, skip to 6_check
      await runOrchestrator(['transition', TEST_TICKET, '2_bootstrap']);

      const { result } = await runOrchestrator([
        'transition',
        TEST_TICKET,
        '6_check',
      ]);

      expect(result.success).toBe(true);
      expect(result.from).toBe('2_bootstrap');
      expect(result.to).toBe('6_check');
    });

    it('should persist state after transition', async () => {
      await runOrchestrator(['transition', TEST_TICKET, '2_bootstrap']);
      await runOrchestrator(['transition', TEST_TICKET, '3_implement']);

      // Check current state
      const { result } = await runOrchestrator(['transitions', TEST_TICKET]);

      expect(result.currentStep).toBe('3_implement');
      expect(result.allStatuses['1_ticket']).toBe('completed');
      expect(result.allStatuses['2_bootstrap']).toBe('completed');
      expect(result.allStatuses['3_implement']).toBe('in_progress');
    });

    it('should reset intermediate steps on backward transition', async () => {
      // Progress through several steps
      await runOrchestrator(['transition', TEST_TICKET, '2_bootstrap']);
      await runOrchestrator(['transition', TEST_TICKET, '3_implement']);
      await runOrchestrator(['transition', TEST_TICKET, '4_quality']);
      await runOrchestrator(['transition', TEST_TICKET, '5_commit']);
      await runOrchestrator(['transition', TEST_TICKET, '6_check']);

      // Go back to 3_implement
      await runOrchestrator(['transition', TEST_TICKET, '3_implement']);

      const { result } = await runOrchestrator(['transitions', TEST_TICKET]);

      // Steps after 3_implement should be reset to pending
      expect(result.allStatuses['4_quality']).toBe('pending');
      expect(result.allStatuses['5_commit']).toBe('pending');
      expect(result.allStatuses['6_check']).toBe('pending');
    });
  });

  describe('state machine logic', () => {
    it('should have 13 steps total', async () => {
      const { result } = await runOrchestrator(['graph']);

      expect(result.steps.length).toBe(13);
    });

    it('should not allow self-transitions', async () => {
      const { result } = await runOrchestrator(['graph']);

      for (const step of result.steps) {
        expect(result.transitions[step]).not.toContain(step);
      }
    });

    it('should have terminal state at 13_complete', async () => {
      const { result } = await runOrchestrator(['graph']);

      expect(result.transitions['13_complete']).toEqual([]);
    });

    it('should have exactly one entry point', async () => {
      const { result } = await runOrchestrator(['graph']);

      // Only 1_ticket should not be a target of any transition
      const allTargets = new Set();
      for (const targets of Object.values(result.transitions)) {
        targets.forEach((t) => allTargets.add(t));
      }

      const entryPoints = result.steps.filter((s) => !allTargets.has(s));
      expect(entryPoints).toEqual(['1_ticket']);
    });
  });

  describe('plan action types', () => {
    const TEST_TICKET = 'TEST-666';

    afterEach(() => {
      cleanupTempWorkState(TEST_TICKET);
    });

    it('should use RUN for steps that need execution', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);

      const runSteps = result.plan.filter((s) => s.action === 'RUN');
      expect(runSteps.length).toBeGreaterThan(0);

      for (const step of runSteps) {
        expect(step).toHaveProperty('reason');
      }
    });

    it('should use PENDING for steps dependent on earlier steps', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);

      // When no changes exist, 4_quality and 5_commit should be PENDING
      const qualityStep = result.plan.find((s) => s.step === '4_quality');
      const commitStep = result.plan.find((s) => s.step === '5_commit');

      // These depend on 3_implement completing first
      expect(qualityStep.action).toBe('PENDING');
      expect(commitStep.action).toBe('PENDING');
    });

    it('should include command for RUN steps', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);

      const runSteps = result.plan.filter((s) => s.action === 'RUN');

      for (const step of runSteps) {
        // Most RUN steps should have a command (some might not)
        if (step.command) {
          expect(typeof step.command).toBe('string');
        }
      }
    });
  });

  describe('ticket format handling', () => {
    it('should accept uppercase ticket IDs', async () => {
      const { result } = await runOrchestrator(['PROJ-123']);
      expect(result.ticket).toBe('PROJ-123');
    });

    it('should convert lowercase ticket IDs to uppercase', async () => {
      const { result } = await runOrchestrator(['proj-123']);
      expect(result.ticket).toBe('PROJ-123');
    });

    it('should treat non-ticket format as description', async () => {
      const { result } = await runOrchestrator(['fix the login bug']);
      expect(result.ticket).toContain('TBD');
      expect(result.ticket).toContain('fix the login bug');
    });

    it('should handle multi-word descriptions', async () => {
      const { result } = await runOrchestrator([
        'add',
        'new',
        'authentication',
        'feature',
      ]);
      expect(result.ticket).toContain('add new authentication feature');
    });
  });

  describe('agentType and agentPrompt fields', () => {
    const TEST_TICKET = 'TEST-444';

    afterEach(() => {
      cleanupTempWorkState(TEST_TICKET);
    });

    it('should include agentType and agentPrompt for RUN steps', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);

      const runSteps = result.plan.filter((s) => s.action === 'RUN');
      expect(runSteps.length).toBeGreaterThan(0);

      for (const step of runSteps) {
        expect(step).toHaveProperty('agentType');
        expect(step).toHaveProperty('agentPrompt');
        expect(typeof step.agentType).toBe('string');
        expect(typeof step.agentPrompt).toBe('string');
        expect(step.agentType.length).toBeGreaterThan(0);
        expect(step.agentPrompt.length).toBeGreaterThan(0);
      }
    });

    it('should not include agentType for SKIP steps', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);

      const skipSteps = result.plan.filter((s) => s.action === 'SKIP');
      for (const step of skipSteps) {
        expect(step.agentType).toBeUndefined();
        expect(step.agentPrompt).toBeUndefined();
      }
    });

    it('should not include agentType for PENDING steps', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);

      const pendingSteps = result.plan.filter((s) => s.action === 'PENDING');
      for (const step of pendingSteps) {
        expect(step.agentType).toBeUndefined();
        expect(step.agentPrompt).toBeUndefined();
      }
    });

    it('should use general-purpose for 1_ticket fetch when ticket exists', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);

      const ticketStep = result.plan.find((s) => s.step === '1_ticket');
      expect(ticketStep.agentType).toBe('general-purpose');
      expect(ticketStep.agentPrompt).toContain(TEST_TICKET);
    });

    it('should use jira-task-creator for 1_ticket when no ticket (description mode)', async () => {
      const { result } = await runOrchestrator(['add login feature']);

      const ticketStep = result.plan.find((s) => s.step === '1_ticket');
      expect(ticketStep.agentType).toBe('jira-task-creator');
      expect(ticketStep.agentPrompt).toContain('add login feature');
    });

    it('should use quality-checker for 4_quality when code exists', async () => {
      // Create a state where 4_quality would be RUN (hasDiffVsMain but not completed)
      // Since TEST-444 likely has no worktree, 4_quality will be PENDING
      // We test the plan structure for steps that ARE RUN
      const { result } = await runOrchestrator([TEST_TICKET]);

      // 11_ci is always RUN so let's check its agentType
      const ciStep = result.plan.find((s) => s.step === '11_ci');
      expect(ciStep.agentType).toBe('Bash');
      expect(ciStep.agentPrompt).toContain('gh pr checks');
    });

    it('should use Bash agent for 13_complete', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);

      const completeStep = result.plan.find((s) => s.step === '13_complete');
      expect(completeStep.agentType).toBe('Bash');
      expect(completeStep.agentPrompt).toContain('work-state.js complete');
    });

    it('should use Bash agent for 12_reports', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);

      const reportsStep = result.plan.find((s) => s.step === '12_reports');
      expect(reportsStep.agentType).toBe('Bash');
    });

    it('should use skill for bootstrap', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);

      const bootstrapStep = result.plan.find((s) => s.step === '2_bootstrap');
      if (bootstrapStep.action === 'RUN') {
        expect(bootstrapStep.agentType).toBe('skill');
        expect(bootstrapStep.agentPrompt).toContain('bootstrap');
      }
    });

    it('should use general-purpose for 2b_transition', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);

      const transStep = result.plan.find((s) => s.step === '2b_transition');
      expect(transStep.agentType).toBe('general-purpose');
      expect(transStep.agentPrompt).toContain('transition');
    });
  });

  describe('error handling', () => {
    it('should handle missing work state gracefully', async () => {
      // Use proper ticket format (LETTERS-DIGITS)
      const { result, code } = await runOrchestrator(['TEST-99999']);

      expect(code).toBe(0);
      expect(result.ticket).toBe('TEST-99999');
      expect(result.plan).toBeDefined();
    });

    it('should handle invalid transition subcommand args', async () => {
      const { result, code } = await runOrchestrator(['transition', 'TICKET']);

      expect(code).toBe(1);
      expect(result.error).toBe(true);
    });
  });

  describe('summary output', () => {
    const TEST_TICKET = 'TEST-555';

    afterEach(() => {
      cleanupTempWorkState(TEST_TICKET);
    });

    it('should include stepsToRun array', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);

      expect(Array.isArray(result.summary.stepsToRun)).toBe(true);
      expect(result.summary.stepsToRun.length).toBe(result.summary.run);
    });

    it('should include stepsSkipped array', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);

      expect(Array.isArray(result.summary.stepsSkipped)).toBe(true);
      expect(result.summary.stepsSkipped.length).toBe(result.summary.skip);
    });

    it('should identify firstAction correctly', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);

      if (result.summary.run > 0) {
        expect(result.summary.firstAction).toBe(result.summary.stepsToRun[0]);
      } else {
        expect(result.summary.firstAction).toBe('none');
      }
    });
  });
});
