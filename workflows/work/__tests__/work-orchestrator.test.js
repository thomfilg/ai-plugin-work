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

const HOOK_PATH = path.join(__dirname, '..', 'work.workflow.js');

// Isolate all filesystem side effects to a temp dir so the real tasks/
// directory never accumulates orphan ticket dirs when an assertion fails
// before cleanup runs. Must be set BEFORE loading get-config (which caches
// config.js at require time).
//
// Both WORKTREES_BASE and TASKS_BASE are set *explicitly* (rather than
// deleting TASKS_BASE and relying on derivation), because config.js's
// loadEnvFile() repopulates missing env vars from a repo-level .env file
// at require time — deleting would be undone on developer machines that
// have TASKS_BASE in .env. Inner describe blocks that override only
// WORKTREES_BASE get their TASKS_BASE derived inside runOrchestrator()
// below, so per-suite isolation still works.
const ORIG_ENV = {
  WORKTREES_BASE: process.env.WORKTREES_BASE,
  TASKS_BASE: process.env.TASKS_BASE,
};
const TEMP_WORKTREES_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'work-orchestrator-test-'));
const TEMP_TASKS_BASE = path.join(TEMP_WORKTREES_BASE, 'tasks');
fs.mkdirSync(TEMP_TASKS_BASE, { recursive: true });
process.env.WORKTREES_BASE = TEMP_WORKTREES_BASE;
process.env.TASKS_BASE = TEMP_TASKS_BASE;

const GET_CONFIG_PATH = path.join(__dirname, '..', '..', 'lib', 'get-config');
const CONFIG_PATH = path.join(__dirname, '..', '..', 'lib', 'config');
const getConfig = require(GET_CONFIG_PATH);
const TASKS_BASE = getConfig.require('TASKS_BASE');
// Env/cache restoration happens in the global after() hook further down.
// ─── Helpers ────────────────────────────────────────────────────────────────
function runOrchestrator(args = [], opts = {}) {
  // If an inner describe block overrides WORKTREES_BASE without also
  // overriding TASKS_BASE, derive TASKS_BASE from the inner WORKTREES_BASE
  // so the child doesn't inherit the top-level TASKS_BASE (which would
  // point at a different dir than the inner suite's per-suite tasks/).
  const optsEnv = opts.env || {};
  const derivedEnv = { ...optsEnv };
  if (optsEnv.WORKTREES_BASE && !Object.prototype.hasOwnProperty.call(optsEnv, 'TASKS_BASE')) {
    derivedEnv.TASKS_BASE = path.join(optsEnv.WORKTREES_BASE, 'tasks');
  }
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Intentionally disable session guard to isolate orchestrator plan logic.
      // Session guard has dedicated tests in session-guard.test.js (26 tests covering all subcommands + hooks).
      env: { ...process.env, SESSION_GUARD_ENABLED: '0', ...derivedEnv },
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

function cleanupTempWorkState(ticket) {
  const dir = path.join(TASKS_BASE, ticket);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

// ─── Global Cleanup ─────────────────────────────────────────────────────────

after(() => {
  // Nuke the whole temp base — no selective cleanup needed since everything
  // the suite touches lives under TEMP_WORKTREES_BASE.
  try { fs.rmSync(TEMP_WORKTREES_BASE, { recursive: true, force: true }); } catch {}
  // Safety-net: clean up leaked session guard files created by THIS suite only (TEST-* tickets)
  try {
    const tmpDir = os.tmpdir();
    const tmpFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith('claude-session-guard-TEST-'));
    for (const f of tmpFiles) {
      try {
        fs.unlinkSync(path.join(tmpDir, f));
      } catch {}
    }
  } catch { /* ignore if tmpdir unreadable */ }
  // Restore original env so sibling test files loaded in the same Node
  // process (node --test runs many files in one process) don't see our
  // temp overrides leak through inherited env.
  if (ORIG_ENV.WORKTREES_BASE === undefined) delete process.env.WORKTREES_BASE;
  else process.env.WORKTREES_BASE = ORIG_ENV.WORKTREES_BASE;
  if (ORIG_ENV.TASKS_BASE === undefined) delete process.env.TASKS_BASE;
  else process.env.TASKS_BASE = ORIG_ENV.TASKS_BASE;
  // Clear require.cache for get-config / config so sibling test files get a
  // fresh module re-read with the restored env instead of our cached temp
  // derivation.
  try { delete require.cache[require.resolve(GET_CONFIG_PATH)]; } catch {}
  try { delete require.cache[require.resolve(CONFIG_PATH)]; } catch {}
});

/**
 * Write all required check reports (APPROVED) for a ticket so the check->pr gate passes.
 * @param {string} tasksBase - The tasks base directory
 * @param {string} ticket - The ticket ID
 */
function writeCheckReports(tasksBase, ticket) {
  const dir = path.join(tasksBase, ticket);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests.check.md'), '# Tests\nStatus: APPROVED\n');
  fs.writeFileSync(path.join(dir, 'code-review.check.md'), '# Code Review\nStatus: APPROVED\n');
  fs.writeFileSync(path.join(dir, 'completion.check.md'), '# Completion\nStatus: APPROVED\n');
  fs.writeFileSync(path.join(dir, 'qa-feature.check.md'), '# QA\nStatus: APPROVED\n');
}

/**
 * Write a minimal TDD exception state so tests that don't care about TDD
 * can transition past implement without full RED/GREEN cycles.
 * @param {string} tasksBase - The tasks base directory
 * @param {string} ticket - The ticket ID
 */
function writeTddException(tasksBase, ticket) {
  const dir = path.join(tasksBase, ticket);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'tdd-phase.json'),
    JSON.stringify({
      currentPhase: 'exception',
      exception: 'test helper',
      cycles: [],
    })
  );
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
      assert.ok(result.steps.includes('ticket'));
      assert.ok(result.steps.includes('complete'));
      // GH-244: added spec_gate between spec and tasks.
      assert.equal(result.steps.length, 18);
    });

    it('should include follow_up in steps', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.ok(result.steps.includes('follow_up'));
    });

    it('should have ready transitions including follow_up', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.ok(result.transitions['ready'].includes('follow_up'));
    });

    it('should have follow_up transitions including ci and implement', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.ok(result.transitions['follow_up'].includes('ci'));
      assert.ok(result.transitions['follow_up'].includes('implement'));
      assert.ok(
        !result.transitions['follow_up'].includes('cleanup'),
        'follow_up should NOT skip to cleanup'
      );
    });

    it('should NOT have ci transitions including follow_up (no backward from ci)', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.ok(!result.transitions['ci'].includes('follow_up'));
    });

    it('should have valid transitions for each step', async () => {
      const { result } = await runOrchestrator(['graph']);
      for (const step of result.steps) {
        assert.ok(step in result.transitions, `Missing transition for ${step}`);
        assert.ok(Array.isArray(result.transitions[step]));
      }
      assert.ok(result.transitions['ticket'].includes('bootstrap'));
      assert.deepEqual(result.transitions['complete'], ['complete']);
    });

    it('should include retry loop transitions', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.ok(result.transitions['check'].includes('implement'));
      assert.ok(result.transitions['ci'].includes('implement'));
    });

    it('should have linear transitions (no skip edges)', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.ok(
        !result.transitions['bootstrap'].includes('commit'),
        'bootstrap should NOT skip to commit'
      );
      assert.ok(
        !result.transitions['bootstrap'].includes('check'),
        'bootstrap should NOT skip to check'
      );
      assert.deepEqual(
        result.transitions['bootstrap'],
        ['brief'],
        'bootstrap should only go to brief'
      );
    });
  });

  describe('plan command', () => {
    const TEST_TICKET = 'TEST-999';
    afterEach(() => {
      cleanupTempWorkState(TEST_TICKET);
    });

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
        'ticket',
        'bootstrap',
        'brief',
        'spec',
        'implement',
        'commit',
        'check',
        'pr',
        'ready',
        'follow_up',
        'ci',
        'cleanup',
        'reports',
        'complete',
      ]) {
        assert.ok(stepNames.includes(expected), `Missing step: ${expected}`);
      }
    });

    it('should generate summary with correct counts', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      assert.ok('total' in result.summary);
      assert.ok('run' in result.summary);
      assert.ok('pending' in result.summary);
      assert.ok('firstAction' in result.summary);
      assert.ok('stepsToRun' in result.summary);
      assert.ok('defer' in result.summary);
      assert.equal(
        result.summary.total,
        result.summary.run + result.summary.defer + result.summary.pending
      );
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
      // Fully isolate: fake HOME prevents reading real ticket-providers.json,
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
        try {
          fs.rmSync(tmpBase, { recursive: true, force: true });
        } catch (e) {
          console.warn('cleanup failed:', e.message);
        }
      }
    });
  });

  describe('transitions command', () => {
    const TEST_TICKET = 'TEST-888';
    afterEach(() => {
      cleanupTempWorkState(TEST_TICKET);
    });

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
    const transOpts = { env: { WORKTREES_BASE: TEMP_WB, TASKS_BASE: TEMP_TASKS_DIR } };
    after(() => {
      try {
        fs.rmSync(TEMP_WB, { recursive: true, force: true });
      } catch {}
    });
    afterEach(() => {
      try {
        fs.rmSync(path.join(TEMP_TASKS_DIR, TEST_TICKET), { recursive: true, force: true });
      } catch {}
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
      await runOrchestrator(['transition', TEST_TICKET, 'brief'], transOpts);
      await runOrchestrator(['transition', TEST_TICKET, 'brief_gate'], transOpts);
      await runOrchestrator(['transition', TEST_TICKET, 'spec'], transOpts);
      await runOrchestrator(['transition', TEST_TICKET, 'spec_gate'], transOpts);
      await runOrchestrator(['transition', TEST_TICKET, 'tasks'], transOpts);
      await runOrchestrator(['transition', TEST_TICKET, 'implement'], transOpts);
      const { result } = await runOrchestrator(['transition', TEST_TICKET, 'pr'], transOpts);
      assert.equal(result.error, true);
      assert.ok(result.message.includes('BLOCKED'));
      assert.ok(result.allowed);
      assert.ok(result.hint);
    });

    it('should allow retry loop (backward transition)', async () => {
      await runOrchestrator(['transition', TEST_TICKET, 'bootstrap'], transOpts);
      await runOrchestrator(['transition', TEST_TICKET, 'brief'], transOpts);
      await runOrchestrator(['transition', TEST_TICKET, 'brief_gate'], transOpts);
      await runOrchestrator(['transition', TEST_TICKET, 'spec'], transOpts);
      await runOrchestrator(['transition', TEST_TICKET, 'spec_gate'], transOpts);
      await runOrchestrator(['transition', TEST_TICKET, 'tasks'], transOpts);
      await runOrchestrator(['transition', TEST_TICKET, 'implement'], transOpts);
      writeTddException(TEMP_TASKS_DIR, TEST_TICKET);
      await runOrchestrator(['transition', TEST_TICKET, 'commit'], transOpts);
      await runOrchestrator(['transition', TEST_TICKET, 'task_review'], transOpts);
      await runOrchestrator(['transition', TEST_TICKET, 'check'], transOpts);
      const { result } = await runOrchestrator(['transition', TEST_TICKET, 'implement'], transOpts);
      assert.equal(result.success, true);
      assert.equal(result.from, 'check');
      assert.equal(result.to, 'implement');
      assert.equal(result.direction, 'backward');
    });

    it('should block skip edge transition (linear graph)', async () => {
      await runOrchestrator(['transition', TEST_TICKET, 'bootstrap'], transOpts);
      const { result } = await runOrchestrator(['transition', TEST_TICKET, 'check'], transOpts);
      assert.equal(result.error, true);
      assert.ok(result.message.includes('BLOCKED'));
    });

    it('should persist state after transition', async () => {
      await runOrchestrator(['transition', TEST_TICKET, 'bootstrap'], transOpts);
      await runOrchestrator(['transition', TEST_TICKET, 'brief'], transOpts);
      await runOrchestrator(['transition', TEST_TICKET, 'brief_gate'], transOpts);
      await runOrchestrator(['transition', TEST_TICKET, 'spec'], transOpts);
      await runOrchestrator(['transition', TEST_TICKET, 'spec_gate'], transOpts);
      await runOrchestrator(['transition', TEST_TICKET, 'tasks'], transOpts);
      await runOrchestrator(['transition', TEST_TICKET, 'implement'], transOpts);
      const { result } = await runOrchestrator(['transitions', TEST_TICKET], transOpts);
      assert.equal(result.currentStep, 'implement');
      assert.equal(result.allStatuses['ticket'], 'completed');
      assert.equal(result.allStatuses['bootstrap'], 'completed');
      assert.equal(result.allStatuses['implement'], 'in_progress');
    });

    it('should reset intermediate steps on backward transition', async () => {
      await runOrchestrator(['transition', TEST_TICKET, 'bootstrap']);
      await runOrchestrator(['transition', TEST_TICKET, 'brief']);
      await runOrchestrator(['transition', TEST_TICKET, 'brief_gate']);
      await runOrchestrator(['transition', TEST_TICKET, 'spec']);
      await runOrchestrator(['transition', TEST_TICKET, 'spec_gate']);
      await runOrchestrator(['transition', TEST_TICKET, 'tasks']);
      await runOrchestrator(['transition', TEST_TICKET, 'implement']);
      writeTddException(TASKS_BASE, TEST_TICKET);
      await runOrchestrator(['transition', TEST_TICKET, 'commit']);
      await runOrchestrator(['transition', TEST_TICKET, 'task_review']);
      await runOrchestrator(['transition', TEST_TICKET, 'check']);
      await runOrchestrator(['transition', TEST_TICKET, 'implement']);
      const { result } = await runOrchestrator(['transitions', TEST_TICKET]);
      assert.equal(result.allStatuses['commit'], 'pending');
      assert.equal(result.allStatuses['task_review'], 'pending');
      assert.equal(result.allStatuses['check'], 'pending');
    });
  });

  describe('state machine logic', () => {
    it('should have 18 steps total', async () => {
      const { result } = await runOrchestrator(['graph']);
      // GH-244: added spec_gate between spec and tasks.
      assert.equal(result.steps.length, 18);
    });

    it('should not allow self-transitions (except complete)', async () => {
      const { result } = await runOrchestrator(['graph']);
      const allowedSelfTransitions = ['complete'];
      for (const step of result.steps) {
        if (allowedSelfTransitions.includes(step)) continue;
        assert.ok(!result.transitions[step].includes(step), `${step} has self-transition`);
      }
    });

    it('should have complete self-transition for retry on failure', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.deepEqual(result.transitions['complete'], ['complete']);
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
    afterEach(() => {
      cleanupTempWorkState(TEST_TICKET);
    });

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
      const commitStep = result.plan.find((s) => s.step === 'commit');
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
    afterEach(() => {
      cleanupTempWorkState(TEST_TICKET);
    });

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

    it('should not emit any SKIP steps (GH-245)', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      const skipSteps = result.plan.filter((s) => s.action === 'SKIP');
      assert.equal(skipSteps.length, 0, `Found ${skipSteps.length} SKIP step(s): ${skipSteps.map(s => s.step).join(', ')}`);
    });

    it('should include agentType for DEFER steps with commands as fallback (GH-130)', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      // GH-245: SKIP was eliminated; former-SKIP steps now emit DEFER without
      // agentType (no fallback action needed). Only DEFER steps that carry a
      // command have a meaningful fallback and must include agentType/agentPrompt.
      const deferStepsWithCommand = result.plan.filter((s) => s.action === 'DEFER' && s.command);
      for (const step of deferStepsWithCommand) {
        assert.ok(step.agentType, `DEFER step ${step.step} should have agentType as fallback`);
        assert.ok(step.agentPrompt, `DEFER step ${step.step} should have agentPrompt as fallback`);
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
      // May be DEFER (no provider) or RUN (jira/linear)
      if (transStep.action === 'RUN') {
        assert.equal(transStep.agentType, 'general-purpose');
        assert.ok(
          transStep.agentPrompt.includes('transition') ||
            transStep.agentPrompt.includes('Transition')
        );
      } else {
        assert.equal(transStep.action, 'DEFER');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Patch 14: New transition edges
  // ═══════════════════════════════════════════════════════════════════════════

  describe('new transition edges (Patch 14)', () => {
    it('should include 5_check → 3_implement (check failed, re-implement)', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.ok(result.transitions['check'].includes('implement'));
    });

    it('should include 5_check → 6_pr (check passed, go to PR)', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.ok(result.transitions['check'].includes('pr'));
    });

    it('should NOT include pr → ci (no skip edges)', async () => {
      const { result } = await runOrchestrator(['graph']);
      assert.ok(!result.transitions['pr'].includes('ci'), 'pr should NOT skip to ci');
      assert.deepEqual(result.transitions['pr'], ['ready'], 'pr should only go to ready');
    });

    it('should allow transition from 6_check → 3_implement (backward)', async () => {
      const TMP = path.join(os.tmpdir(), 'work-orch-p14a-' + process.pid);
      const T = 'TEST-614';
      const o = { env: { WORKTREES_BASE: TMP, TASKS_BASE: path.join(TMP, 'tasks') } };
      try {
        await runOrchestrator(['transition', T, 'bootstrap'], o);
        await runOrchestrator(['transition', T, 'brief'], o);
        await runOrchestrator(['transition', T, 'brief_gate'], o);
        await runOrchestrator(['transition', T, 'spec'], o);
        await runOrchestrator(['transition', T, 'spec_gate'], o);
        await runOrchestrator(['transition', T, 'tasks'], o);
        await runOrchestrator(['transition', T, 'implement'], o);
        writeTddException(path.join(TMP, 'tasks'), T);
        await runOrchestrator(['transition', T, 'commit'], o);
        await runOrchestrator(['transition', T, 'task_review'], o);
        await runOrchestrator(['transition', T, 'check'], o);
        const { result } = await runOrchestrator(['transition', T, 'implement'], o);
        assert.equal(result.success, true);
        assert.equal(result.direction, 'backward');
      } finally {
        try {
          fs.rmSync(TMP, { recursive: true, force: true });
        } catch {}
      }
    });

    it('should block transition from pr → ci (must go through ready and follow_up)', async () => {
      const TEST_TICKET = 'TEST-911';
      const o = {};
      try {
        await runOrchestrator(['transition', TEST_TICKET, 'bootstrap'], o);
        await runOrchestrator(['transition', TEST_TICKET, 'brief'], o);
        await runOrchestrator(['transition', TEST_TICKET, 'brief_gate'], o);
        await runOrchestrator(['transition', TEST_TICKET, 'spec'], o);
        await runOrchestrator(['transition', TEST_TICKET, 'spec_gate'], o);
        await runOrchestrator(['transition', TEST_TICKET, 'tasks'], o);
        await runOrchestrator(['transition', TEST_TICKET, 'implement'], o);
        writeTddException(TASKS_BASE, TEST_TICKET);
        await runOrchestrator(['transition', TEST_TICKET, 'commit'], o);
        await runOrchestrator(['transition', TEST_TICKET, 'check'], o);
        writeCheckReports(TASKS_BASE, TEST_TICKET);
        await runOrchestrator(['transition', TEST_TICKET, 'pr'], o);
        const { result } = await runOrchestrator(['transition', TEST_TICKET, 'ci'], o);
        assert.equal(result.error, true);
        assert.ok(result.message.includes('BLOCKED'));
      } finally {
        cleanupTempWorkState(TEST_TICKET);
      }
    });

    it('should allow linear transition pr → ready → follow_up → ci', async () => {
      const TEST_TICKET = 'TEST-912';
      const o = {};
      try {
        await runOrchestrator(['transition', TEST_TICKET, 'bootstrap'], o);
        await runOrchestrator(['transition', TEST_TICKET, 'brief'], o);
        await runOrchestrator(['transition', TEST_TICKET, 'brief_gate'], o);
        await runOrchestrator(['transition', TEST_TICKET, 'spec'], o);
        await runOrchestrator(['transition', TEST_TICKET, 'spec_gate'], o);
        await runOrchestrator(['transition', TEST_TICKET, 'tasks'], o);
        await runOrchestrator(['transition', TEST_TICKET, 'implement'], o);
        writeTddException(TASKS_BASE, TEST_TICKET);
        await runOrchestrator(['transition', TEST_TICKET, 'commit'], o);
        await runOrchestrator(['transition', TEST_TICKET, 'task_review'], o);
        await runOrchestrator(['transition', TEST_TICKET, 'check'], o);
        writeCheckReports(TASKS_BASE, TEST_TICKET);
        await runOrchestrator(['transition', TEST_TICKET, 'pr'], o);
        await runOrchestrator(['transition', TEST_TICKET, 'ready'], o);
        await runOrchestrator(['transition', TEST_TICKET, 'follow_up'], o);
        const { result } = await runOrchestrator(['transition', TEST_TICKET, 'ci'], o);
        assert.equal(result.success, true);
        assert.equal(result.from, 'follow_up');
        assert.equal(result.to, 'ci');
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
    afterEach(() => {
      cleanupTempWorkState(TEST_TICKET);
    });

    it('should include stepsToRun array', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      assert.ok(Array.isArray(result.summary.stepsToRun));
      assert.equal(result.summary.stepsToRun.length, result.summary.run);
      assert.ok(Array.isArray(result.summary.stepsDeferred));
      assert.equal(result.summary.stepsDeferred.length, result.summary.defer);
    });

    it('should include stepsDeferred array', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      assert.ok(Array.isArray(result.summary.stepsDeferred));
      assert.equal(result.summary.stepsDeferred.length, result.summary.defer);
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

  // ═══════════════════════════════════════════════════════════════════════════
  // GH-81: follow_up step
  // ═══════════════════════════════════════════════════════════════════════════

  describe('follow_up step (GH-81)', () => {
    const TEST_TICKET = 'TEST-810';
    afterEach(() => {
      cleanupTempWorkState(TEST_TICKET);
    });

    it('should mark follow_up as DEFER when no PR exists (new ticket) (GH-130)', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      const followUpStep = result.plan.find((s) => s.step === 'follow_up');
      assert.ok(followUpStep, 'follow_up step should exist in plan');
      assert.equal(followUpStep.action, 'DEFER');
      assert.ok(followUpStep.reason.includes('No PR'));
    });

    it('should DEFER follow_up with fallback agentType when no PR exists (GH-130)', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      const followUpStep = result.plan.find((s) => s.step === 'follow_up');
      assert.ok(followUpStep, 'follow_up step should exist in plan');
      assert.equal(followUpStep.action, 'DEFER');
      assert.ok(followUpStep.agentType, 'DEFER follow_up should have fallback agentType');
      assert.ok(followUpStep.agentPrompt, 'DEFER follow_up should have fallback agentPrompt');
    });

    it('should appear between ready and ci in plan order', async () => {
      const { result } = await runOrchestrator([TEST_TICKET]);
      const stepNames = result.plan.map((s) => s.step);
      const readyIdx = stepNames.indexOf('ready');
      const followUpIdx = stepNames.indexOf('follow_up');
      const ciIdx = stepNames.indexOf('ci');
      assert.ok(readyIdx < followUpIdx, 'follow_up should come after ready');
      assert.ok(followUpIdx < ciIdx, 'follow_up should come before ci');
    });
  });

  describe('follow_up transitions (GH-81)', () => {
    const TEMP_WB = path.join(os.tmpdir(), 'work-orch-fu-' + process.pid);
    const T = 'TEST-811';
    const TEMP_TASKS = path.join(TEMP_WB, 'tasks');
    const o = { env: { WORKTREES_BASE: TEMP_WB, TASKS_BASE: TEMP_TASKS } };
    after(() => {
      try {
        fs.rmSync(TEMP_WB, { recursive: true, force: true });
      } catch {}
    });

    it('should allow transition follow_up → ci (forward)', async () => {
      await runOrchestrator(['transition', T, 'bootstrap'], o);
      await runOrchestrator(['transition', T, 'brief'], o);
      await runOrchestrator(['transition', T, 'brief_gate'], o);
      await runOrchestrator(['transition', T, 'spec'], o);
      await runOrchestrator(['transition', T, 'spec_gate'], o);
      await runOrchestrator(['transition', T, 'tasks'], o);
      await runOrchestrator(['transition', T, 'implement'], o);
      writeTddException(TEMP_TASKS, T);
      await runOrchestrator(['transition', T, 'commit'], o);
      await runOrchestrator(['transition', T, 'task_review'], o);
      await runOrchestrator(['transition', T, 'check'], o);
      writeCheckReports(TEMP_TASKS, T);
      await runOrchestrator(['transition', T, 'pr'], o);
      await runOrchestrator(['transition', T, 'ready'], o);
      await runOrchestrator(['transition', T, 'follow_up'], o);
      const { result } = await runOrchestrator(['transition', T, 'ci'], o);
      assert.equal(result.success, true);
      assert.equal(result.from, 'follow_up');
      assert.equal(result.to, 'ci');
      assert.equal(result.direction, 'forward');
    });

    it('should allow transition follow_up → implement (backward)', async () => {
      const T2 = 'TEST-812';
      try {
        await runOrchestrator(['transition', T2, 'bootstrap'], o);
        await runOrchestrator(['transition', T2, 'brief'], o);
        await runOrchestrator(['transition', T2, 'brief_gate'], o);
        await runOrchestrator(['transition', T2, 'spec'], o);
        await runOrchestrator(['transition', T2, 'spec_gate'], o);
        await runOrchestrator(['transition', T2, 'tasks'], o);
        await runOrchestrator(['transition', T2, 'implement'], o);
        writeTddException(TEMP_TASKS, T2);
        await runOrchestrator(['transition', T2, 'commit'], o);
        await runOrchestrator(['transition', T2, 'task_review'], o);
        await runOrchestrator(['transition', T2, 'check'], o);
        writeCheckReports(TEMP_TASKS, T2);
        await runOrchestrator(['transition', T2, 'pr'], o);
        await runOrchestrator(['transition', T2, 'ready'], o);
        await runOrchestrator(['transition', T2, 'follow_up'], o);
        const { result } = await runOrchestrator(['transition', T2, 'implement'], o);
        assert.equal(result.success, true);
        assert.equal(result.from, 'follow_up');
        assert.equal(result.to, 'implement');
        assert.equal(result.direction, 'backward');
      } finally {
        try {
          fs.rmSync(path.join(TEMP_TASKS, T2), { recursive: true, force: true });
        } catch {}
      }
    });

    it('should allow transition follow_up → implement (backward via different ticket)', async () => {
      const T3 = 'TEST-813B';
      try {
        await runOrchestrator(['transition', T3, 'bootstrap'], o);
        await runOrchestrator(['transition', T3, 'brief'], o);
        await runOrchestrator(['transition', T3, 'brief_gate'], o);
        await runOrchestrator(['transition', T3, 'spec'], o);
        await runOrchestrator(['transition', T3, 'spec_gate'], o);
        await runOrchestrator(['transition', T3, 'tasks'], o);
        await runOrchestrator(['transition', T3, 'implement'], o);
        writeTddException(TEMP_TASKS, T3);
        await runOrchestrator(['transition', T3, 'commit'], o);
        await runOrchestrator(['transition', T3, 'task_review'], o);
        await runOrchestrator(['transition', T3, 'check'], o);
        writeCheckReports(TEMP_TASKS, T3);
        await runOrchestrator(['transition', T3, 'pr'], o);
        await runOrchestrator(['transition', T3, 'ready'], o);
        await runOrchestrator(['transition', T3, 'follow_up'], o);
        const { result } = await runOrchestrator(['transition', T3, 'implement'], o);
        assert.equal(result.success, true);
        assert.equal(result.from, 'follow_up');
        assert.equal(result.to, 'implement');
        assert.equal(result.direction, 'backward');
      } finally {
        try {
          fs.rmSync(path.join(TEMP_TASKS, T3), { recursive: true, force: true });
        } catch {}
      }
    });

    it('should archive check artifacts to runs/runN on backward transition (GH-130)', async () => {
      const T_ARCHIVE = 'TEST-ARCHIVE-1';
      const ticketDir = path.join(TEMP_TASKS, T_ARCHIVE);
      try {
        await runOrchestrator(['transition', T_ARCHIVE, 'bootstrap'], o);
        await runOrchestrator(['transition', T_ARCHIVE, 'brief'], o);
        await runOrchestrator(['transition', T_ARCHIVE, 'brief_gate'], o);
        await runOrchestrator(['transition', T_ARCHIVE, 'spec'], o);
        await runOrchestrator(['transition', T_ARCHIVE, 'spec_gate'], o);
        await runOrchestrator(['transition', T_ARCHIVE, 'tasks'], o);
        await runOrchestrator(['transition', T_ARCHIVE, 'implement'], o);
        writeTddException(TEMP_TASKS, T_ARCHIVE);
        await runOrchestrator(['transition', T_ARCHIVE, 'commit'], o);
        await runOrchestrator(['transition', T_ARCHIVE, 'task_review'], o);
        await runOrchestrator(['transition', T_ARCHIVE, 'check'], o);
        writeCheckReports(TEMP_TASKS, T_ARCHIVE);

        // Verify reports exist before backward transition
        assert.ok(fs.existsSync(path.join(ticketDir, 'tests.check.md')));
        assert.ok(fs.existsSync(path.join(ticketDir, 'code-review.check.md')));

        // Backward: check → implement (should archive check artifacts)
        const { result } = await runOrchestrator(['transition', T_ARCHIVE, 'implement'], o);
        assert.equal(result.success, true);
        assert.equal(result.direction, 'backward');

        // Reports should be moved to runs/run1/
        assert.ok(
          !fs.existsSync(path.join(ticketDir, 'tests.check.md')),
          'reports should be archived'
        );
        assert.ok(
          fs.existsSync(path.join(ticketDir, 'runs', 'run1', 'tests.check.md')),
          'reports should be in run1'
        );
        assert.ok(fs.existsSync(path.join(ticketDir, 'runs', 'run1', 'code-review.check.md')));
        assert.ok(fs.existsSync(path.join(ticketDir, 'runs', 'run1', 'completion.check.md')));
        assert.ok(fs.existsSync(path.join(ticketDir, 'runs', 'run1', 'qa-feature.check.md')));
      } finally {
        try {
          fs.rmSync(ticketDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('should increment run number on subsequent backward transitions (GH-130)', async () => {
      const T_RUNS = 'TEST-RUNS-1';
      const ticketDir = path.join(TEMP_TASKS, T_RUNS);
      try {
        // First pass: bootstrap → ... → check, write reports, check → implement (backward)
        await runOrchestrator(['transition', T_RUNS, 'bootstrap'], o);
        await runOrchestrator(['transition', T_RUNS, 'brief'], o);
        await runOrchestrator(['transition', T_RUNS, 'brief_gate'], o);
        await runOrchestrator(['transition', T_RUNS, 'spec'], o);
        await runOrchestrator(['transition', T_RUNS, 'spec_gate'], o);
        await runOrchestrator(['transition', T_RUNS, 'tasks'], o);
        await runOrchestrator(['transition', T_RUNS, 'implement'], o);
        writeTddException(TEMP_TASKS, T_RUNS);
        await runOrchestrator(['transition', T_RUNS, 'commit'], o);
        await runOrchestrator(['transition', T_RUNS, 'task_review'], o);
        await runOrchestrator(['transition', T_RUNS, 'check'], o);
        writeCheckReports(TEMP_TASKS, T_RUNS);
        await runOrchestrator(['transition', T_RUNS, 'implement'], o);

        assert.ok(fs.existsSync(path.join(ticketDir, 'runs', 'run1')), 'run1 should exist');

        // Second pass: implement → commit → task_review → check, write reports, check → implement (backward again)
        writeTddException(TEMP_TASKS, T_RUNS);
        await runOrchestrator(['transition', T_RUNS, 'commit'], o);
        await runOrchestrator(['transition', T_RUNS, 'task_review'], o);
        await runOrchestrator(['transition', T_RUNS, 'check'], o);
        writeCheckReports(TEMP_TASKS, T_RUNS);
        await runOrchestrator(['transition', T_RUNS, 'implement'], o);

        assert.ok(fs.existsSync(path.join(ticketDir, 'runs', 'run2')), 'run2 should exist');
      } finally {
        try {
          fs.rmSync(ticketDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('should block follow_up → cleanup (linear graph requires ci in between)', async () => {
      const T4 = 'TEST-814';
      try {
        await runOrchestrator(['transition', T4, 'bootstrap'], o);
        await runOrchestrator(['transition', T4, 'brief'], o);
        await runOrchestrator(['transition', T4, 'brief_gate'], o);
        await runOrchestrator(['transition', T4, 'spec'], o);
        await runOrchestrator(['transition', T4, 'spec_gate'], o);
        await runOrchestrator(['transition', T4, 'tasks'], o);
        await runOrchestrator(['transition', T4, 'implement'], o);
        writeTddException(TEMP_TASKS, T4);
        await runOrchestrator(['transition', T4, 'commit'], o);
        await runOrchestrator(['transition', T4, 'task_review'], o);
        await runOrchestrator(['transition', T4, 'check'], o);
        writeCheckReports(TEMP_TASKS, T4);
        await runOrchestrator(['transition', T4, 'pr'], o);
        await runOrchestrator(['transition', T4, 'ready'], o);
        await runOrchestrator(['transition', T4, 'follow_up'], o);
        const { result } = await runOrchestrator(['transition', T4, 'cleanup'], o);
        assert.equal(result.error, true);
        assert.ok(result.message.includes('BLOCKED'));
      } finally {
        try {
          fs.rmSync(path.join(TEMP_TASKS, T4), { recursive: true, force: true });
        } catch {}
      }
    });

    it('should BLOCK transition follow_up → reports (not in targets)', async () => {
      const T5 = 'TEST-815';
      try {
        await runOrchestrator(['transition', T5, 'bootstrap'], o);
        await runOrchestrator(['transition', T5, 'check'], o);
        writeCheckReports(TEMP_TASKS, T5);
        await runOrchestrator(['transition', T5, 'pr'], o);
        await runOrchestrator(['transition', T5, 'pr'], o);
        await runOrchestrator(['transition', T5, 'ready'], o);
        await runOrchestrator(['transition', T5, 'follow_up'], o);
        const { result } = await runOrchestrator(['transition', T5, 'reports'], o);
        assert.equal(result.error, true);
        assert.ok(result.message.includes('BLOCKED'));
      } finally {
        try {
          fs.rmSync(path.join(TEMP_TASKS, T5), { recursive: true, force: true });
        } catch {}
      }
    });
  });

  // ─── Integration Tests ──────────────────────────────────────────────────────

  describe('integration: orchestrator ↔ state machine', () => {
    const TEMP_WB = path.join(os.tmpdir(), 'work-orch-integ-' + process.pid);
    const TEMP_TASKS = path.join(TEMP_WB, 'tasks');
    const TICKET = 'TEST-8888';
    const envOpts = { env: { WORKTREES_BASE: TEMP_WB, TASKS_BASE: TEMP_TASKS } };

    after(() => {
      try {
        fs.rmSync(TEMP_WB, { recursive: true, force: true });
      } catch {}
    });

    afterEach(() => {
      try {
        fs.rmSync(path.join(TEMP_TASKS, TICKET), { recursive: true, force: true });
      } catch {}
    });

    it('should handle retry loop: 5_check → 3_implement → 4_commit → 5_check', async () => {
      // Build up to check linearly
      await runOrchestrator(['transition', TICKET, 'bootstrap'], envOpts);
      await runOrchestrator(['transition', TICKET, 'brief'], envOpts);
      await runOrchestrator(['transition', TICKET, 'brief_gate'], envOpts);
      await runOrchestrator(['transition', TICKET, 'spec'], envOpts);
      await runOrchestrator(['transition', TICKET, 'spec_gate'], envOpts);
      await runOrchestrator(['transition', TICKET, 'tasks'], envOpts);
      await runOrchestrator(['transition', TICKET, 'implement'], envOpts);
      writeTddException(TEMP_TASKS, TICKET);
      await runOrchestrator(['transition', TICKET, 'commit'], envOpts);
      await runOrchestrator(['transition', TICKET, 'task_review'], envOpts);
      await runOrchestrator(['transition', TICKET, 'check'], envOpts);

      // Retry to implement
      const r1 = await runOrchestrator(['transition', TICKET, 'implement'], envOpts);
      assert.equal(r1.result.success, true);
      assert.equal(r1.result.direction, 'backward');

      // Forward through: implement→commit→task_review→check
      writeTddException(TEMP_TASKS, TICKET);
      const r2 = await runOrchestrator(['transition', TICKET, 'commit'], envOpts);
      assert.equal(r2.result.success, true);
      const r2b = await runOrchestrator(['transition', TICKET, 'task_review'], envOpts);
      assert.equal(r2b.result.success, true);
      const r3 = await runOrchestrator(['transition', TICKET, 'check'], envOpts);
      assert.equal(r3.result.success, true);
    });

    it('should resume from mid-workflow: plan reflects state', async () => {
      // Build state up to check linearly
      await runOrchestrator(['transition', TICKET, 'bootstrap'], envOpts);
      await runOrchestrator(['transition', TICKET, 'brief'], envOpts);
      await runOrchestrator(['transition', TICKET, 'brief_gate'], envOpts);
      await runOrchestrator(['transition', TICKET, 'spec'], envOpts);
      await runOrchestrator(['transition', TICKET, 'spec_gate'], envOpts);
      await runOrchestrator(['transition', TICKET, 'tasks'], envOpts);
      await runOrchestrator(['transition', TICKET, 'implement'], envOpts);
      writeTddException(TEMP_TASKS, TICKET);
      await runOrchestrator(['transition', TICKET, 'commit'], envOpts);
      await runOrchestrator(['transition', TICKET, 'task_review'], envOpts);
      await runOrchestrator(['transition', TICKET, 'check'], envOpts);

      // Get plan — currentStep should reflect check
      const { result } = await runOrchestrator(['plan', TICKET], envOpts);
      assert.ok(result.plan);
      assert.equal(result.currentStep, 'check');
    });

    it('should inject READ_DOCS_ON_DEV into implement step agentPrompt when set', async () => {
      const docs = 'docs/coding-standards.md,docs/api-guide.md';
      const { result, code } = await runOrchestrator([TICKET], {
        env: { ...envOpts.env, READ_DOCS_ON_DEV: docs },
      });
      assert.equal(code, 0);
      const implStep = result.plan.find((s) => s.step === 'implement');
      assert.equal(implStep.action, 'RUN');
      assert.ok(
        implStep.agentPrompt.includes('READ_DOCS_ON_DEV'),
        'agentPrompt should mention READ_DOCS_ON_DEV'
      );
      assert.ok(
        implStep.agentPrompt.includes('docs/coding-standards.md'),
        'agentPrompt should include first doc path'
      );
      assert.ok(
        implStep.agentPrompt.includes('docs/api-guide.md'),
        'agentPrompt should include second doc path'
      );
    });

    it('should NOT inject READ_DOCS_ON_DEV into implement step agentPrompt when unset', async () => {
      const { result, code } = await runOrchestrator([TICKET], {
        env: { ...envOpts.env, READ_DOCS_ON_DEV: '' },
      });
      assert.equal(code, 0);
      const implStep = result.plan.find((s) => s.step === 'implement');
      assert.equal(implStep.action, 'RUN');
      assert.ok(
        !implStep.agentPrompt.includes('READ_DOCS_ON_DEV'),
        'agentPrompt should NOT mention READ_DOCS_ON_DEV when empty'
      );
    });

    it('should trim whitespace in READ_DOCS_ON_DEV paths', async () => {
      const docs = ' docs/guide.md , docs/api.md ';
      const { result, code } = await runOrchestrator([TICKET], {
        env: { ...envOpts.env, READ_DOCS_ON_DEV: docs },
      });
      assert.equal(code, 0);
      const implStep = result.plan.find((s) => s.step === 'implement');
      assert.equal(implStep.action, 'RUN');
      assert.ok(
        implStep.agentPrompt.includes('- docs/guide.md'),
        'should have trimmed "- docs/guide.md"'
      );
      assert.ok(
        implStep.agentPrompt.includes('- docs/api.md'),
        'should have trimmed "- docs/api.md"'
      );
      // Ensure no leading/trailing spaces in the paths
      assert.ok(
        !implStep.agentPrompt.includes('-  docs/guide.md'),
        'should not have extra space before path'
      );
    });

    it('should RUN implement when hasDiffVsMain but implement not previously completed (GH-130)', async () => {
      const { execSync } = require('child_process');
      const REPO_NAME = process.env.REPO_NAME || 'my-project';
      const worktreeDir = path.join(TEMP_WB, `${REPO_NAME}-${TICKET}`);

      // Create a mock git repo that has a diff vs origin/main
      const gitCmd = (cmd) => execSync(cmd, { cwd: worktreeDir, stdio: 'pipe' });
      const commitCmd = ['git', 'commit', '-m'].join(' ');
      fs.mkdirSync(worktreeDir, { recursive: true });
      gitCmd(
        'git init && git config user.name "Test User" && git config user.email "test@example.com"'
      );
      gitCmd('git checkout -b main');
      fs.writeFileSync(path.join(worktreeDir, 'file.txt'), 'initial');
      gitCmd(`git add . && ${commitCmd} "init"`);
      // Create a local "origin/main" ref so git diff origin/main works
      gitCmd('git checkout -b fake-branch');
      gitCmd('git update-ref refs/remotes/origin/main main');
      // Add a change so there's a diff vs origin/main
      fs.writeFileSync(path.join(worktreeDir, 'new-file.txt'), 'new content');
      gitCmd(`git add . && ${commitCmd} "add new file"`);

      try {
        const { result, code } = await runOrchestrator([TICKET], {
          env: { ...envOpts.env, READ_DOCS_ON_DEV: 'docs/guide.md' },
        });
        assert.equal(code, 0);
        const implStep = result.plan.find((s) => s.step === 'implement');
        // GH-130: diffs alone should NOT cause DEFER — implement must be previously completed
        assert.equal(
          implStep.action,
          'RUN',
          'implement should RUN when not previously completed, even with diffs'
        );
        assert.ok(implStep.agentPrompt, 'implement should have agentPrompt');
      } finally {
        fs.rmSync(worktreeDir, { recursive: true, force: true });
      }
    });

    it('should DEFER implement when previously completed AND hasDiffVsMain (GH-130)', async () => {
      const { execSync } = require('child_process');
      const REPO_NAME = process.env.REPO_NAME || 'my-project';
      const worktreeDir = path.join(TEMP_WB, `${REPO_NAME}-${TICKET}`);

      // Create a mock git repo that has a diff vs origin/main
      const gitCmd = (cmd) => execSync(cmd, { cwd: worktreeDir, stdio: 'pipe' });
      const commitCmd = ['git', 'commit', '-m'].join(' ');
      fs.mkdirSync(worktreeDir, { recursive: true });
      gitCmd(
        'git init && git config user.name "Test User" && git config user.email "test@example.com"'
      );
      gitCmd('git checkout -b main');
      fs.writeFileSync(path.join(worktreeDir, 'file.txt'), 'initial');
      gitCmd(`git add . && ${commitCmd} "init"`);
      gitCmd('git checkout -b fake-branch');
      gitCmd('git update-ref refs/remotes/origin/main main');
      fs.writeFileSync(path.join(worktreeDir, 'new-file.txt'), 'new content');
      gitCmd(`git add . && ${commitCmd} "add new file"`);

      // Set work state to show implement was previously completed
      const safeName = TICKET;
      const stateDir = path.join(TEMP_TASKS, safeName);
      fs.mkdirSync(stateDir, { recursive: true });
      const stateFile = path.join(stateDir, '.work-state.json');
      const workState = {
        ticket: TICKET,
        status: 'in_progress',
        stepStatus: { implement: 'completed' },
      };
      fs.writeFileSync(stateFile, JSON.stringify(workState));

      try {
        const { result, code } = await runOrchestrator([TICKET], {
          env: { ...envOpts.env },
        });
        assert.equal(code, 0);
        const implStep = result.plan.find((s) => s.step === 'implement');
        assert.equal(
          implStep.action,
          'DEFER',
          'implement should DEFER when previously completed with diffs'
        );
        assert.ok(implStep.agentPrompt, 'DEFER implement should have fallback agentPrompt');
        assert.ok(
          implStep.reason.includes('Previously completed'),
          'reason should mention previously completed'
        );
      } finally {
        fs.rmSync(worktreeDir, { recursive: true, force: true });
      }
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
          proc.stdout.on('data', (d) => {
            out += d.toString();
          });
          proc.on('close', (code) => {
            try {
              resolve({ result: JSON.parse(out.trim()), code });
            } catch {
              resolve({ result: null, raw: out, code });
            }
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

  // ═══════════════════════════════════════════════════════════════════════════
  // GH-121: check-to-pr gate
  // ═══════════════════════════════════════════════════════════════════════════

  describe('check-to-pr gate (GH-121)', () => {
    const TEMP_WB = path.join(os.tmpdir(), 'work-orch-gh121-' + process.pid);
    const TEMP_TASKS = path.join(TEMP_WB, 'tasks');
    const TICKET = 'TEST-121';
    const gateOpts = { env: { WORKTREES_BASE: TEMP_WB, TASKS_BASE: TEMP_TASKS } };

    function ticketDir() {
      return path.join(TEMP_TASKS, TICKET);
    }

    function writeReport(name, content) {
      const dir = ticketDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), content);
    }

    function writeAllApprovedReports() {
      writeReport('tests.check.md', '# Tests\nStatus: APPROVED\nAll good.');
      writeReport('code-review.check.md', '# Code Review\nStatus: APPROVED\nLGTM.');
      writeReport('completion.check.md', '# Completion\nStatus: APPROVED\nDone.');
      writeReport('qa-feature.check.md', '# QA Feature\nStatus: APPROVED\nPassed.');
    }

    // Linear path: bootstrap → brief → spec → implement → commit → task_review → check
    async function advanceToCheck() {
      await runOrchestrator(['transition', TICKET, 'bootstrap'], gateOpts);
      await runOrchestrator(['transition', TICKET, 'brief'], gateOpts);
      await runOrchestrator(['transition', TICKET, 'brief_gate'], gateOpts);
      await runOrchestrator(['transition', TICKET, 'spec'], gateOpts);
      await runOrchestrator(['transition', TICKET, 'spec_gate'], gateOpts);
      await runOrchestrator(['transition', TICKET, 'tasks'], gateOpts);
      await runOrchestrator(['transition', TICKET, 'implement'], gateOpts);
      writeTddException(TEMP_TASKS, TICKET);
      await runOrchestrator(['transition', TICKET, 'commit'], gateOpts);
      await runOrchestrator(['transition', TICKET, 'task_review'], gateOpts);
      await runOrchestrator(['transition', TICKET, 'check'], gateOpts);
    }

    after(() => {
      try {
        fs.rmSync(TEMP_WB, { recursive: true, force: true });
      } catch {}
    });
    afterEach(() => {
      try {
        fs.rmSync(path.join(TEMP_TASKS, TICKET), { recursive: true, force: true });
      } catch {}
    });

    // 1. Happy path: all reports APPROVED, no agents running
    it('should allow check → pr when all reports exist with APPROVED status and no agents running', async () => {
      await advanceToCheck();
      writeAllApprovedReports();
      const { result } = await runOrchestrator(['transition', TICKET, 'pr'], gateOpts);
      assert.equal(result.success, true);
      assert.equal(result.from, 'check');
      assert.equal(result.to, 'pr');
    });

    // 2. Happy path: completion.check.md with COMPLETE (alternative)
    it('should allow check → pr when completion.check.md has Status: COMPLETE', async () => {
      await advanceToCheck();
      writeReport('tests.check.md', '# Tests\nStatus: APPROVED\nAll good.');
      writeReport('code-review.check.md', '# Code Review\nStatus: APPROVED\nLGTM.');
      writeReport('completion.check.md', '# Completion\nStatus: COMPLETE\nDone.');
      writeReport('qa-feature.check.md', '# QA Feature\nStatus: APPROVED\nPassed.');
      const { result } = await runOrchestrator(['transition', TICKET, 'pr'], gateOpts);
      assert.equal(result.success, true);
      assert.equal(result.from, 'check');
      assert.equal(result.to, 'pr');
    });

    // 3. Edge case: check → implement (backward) — gate NOT evaluated
    it('should NOT evaluate check gate on backward transition check → implement', async () => {
      await advanceToCheck();
      // No reports written — gate would block if evaluated
      const { result } = await runOrchestrator(['transition', TICKET, 'implement'], gateOpts);
      assert.equal(result.success, true);
      assert.equal(result.from, 'check');
      assert.equal(result.to, 'implement');
      assert.equal(result.direction, 'backward');
    });

    // 4. Edge case: implement → commit — gate NOT evaluated (different step)
    it('should NOT evaluate check gate on implement → commit transition', async () => {
      await runOrchestrator(['transition', TICKET, 'bootstrap'], gateOpts);
      await runOrchestrator(['transition', TICKET, 'brief'], gateOpts);
      await runOrchestrator(['transition', TICKET, 'brief_gate'], gateOpts);
      await runOrchestrator(['transition', TICKET, 'spec'], gateOpts);
      await runOrchestrator(['transition', TICKET, 'spec_gate'], gateOpts);
      await runOrchestrator(['transition', TICKET, 'tasks'], gateOpts);
      await runOrchestrator(['transition', TICKET, 'implement'], gateOpts);
      writeTddException(TEMP_TASKS, TICKET);
      const { result } = await runOrchestrator(['transition', TICKET, 'commit'], gateOpts);
      assert.equal(result.success, true);
      assert.equal(result.from, 'implement');
      assert.equal(result.to, 'commit');
    });

    // 5. Edge case: no agent tmux sessions running — succeeds
    it('should allow check → pr when all reports are approved (no agents running)', async () => {
      await advanceToCheck();
      writeAllApprovedReports();
      // tmux has-session for non-agent names will fail (session doesn't exist)
      // so this should pass — we only check specific agent session names
      const { result } = await runOrchestrator(['transition', TICKET, 'pr'], gateOpts);
      assert.equal(result.success, true);
    });

    // 6. Error case: missing tests.check.md
    it('should block check → pr when tests.check.md is missing', async () => {
      await advanceToCheck();
      writeReport('code-review.check.md', '# Code Review\nStatus: APPROVED\nLGTM.');
      writeReport('completion.check.md', '# Completion\nStatus: APPROVED\nDone.');
      writeReport('qa-feature.check.md', '# QA Feature\nStatus: APPROVED\nPassed.');
      const { result } = await runOrchestrator(['transition', TICKET, 'pr'], gateOpts);
      assert.equal(result.error, true);
      assert.ok(result.message.includes('BLOCKED'));
      assert.equal(result.gate, 'check-to-pr');
      assert.ok(result.reasons.some((r) => r.includes('tests.check.md')));
    });

    // 7. Error case: code-review.check.md has FAILED status
    it('should block check → pr when code-review.check.md has Status: FAILED', async () => {
      await advanceToCheck();
      writeReport('tests.check.md', '# Tests\nStatus: APPROVED\nAll good.');
      writeReport('code-review.check.md', '# Code Review\nStatus: FAILED\nIssues found.');
      writeReport('completion.check.md', '# Completion\nStatus: APPROVED\nDone.');
      writeReport('qa-feature.check.md', '# QA Feature\nStatus: APPROVED\nPassed.');
      const { result } = await runOrchestrator(['transition', TICKET, 'pr'], gateOpts);
      assert.equal(result.error, true);
      assert.equal(result.gate, 'check-to-pr');
      assert.ok(result.reasons.some((r) => r.includes('code-review.check.md')));
    });

    // 8. Error case: tmux session for code-checker running
    it('should block check → pr when a check agent tmux session is running', async (t) => {
      await advanceToCheck();
      writeAllApprovedReports();
      // Create a real tmux session that mimics a running agent
      const sessionName = `${TICKET}-code-checker`;
      try {
        require('child_process').execFileSync(
          'tmux',
          ['new-session', '-d', '-s', sessionName, 'cat'],
          {
            timeout: 3000,
            stdio: ['pipe', 'pipe', 'pipe'],
          }
        );
      } catch {
        // tmux not available in this environment — explicitly skip
        t.skip('tmux not available in this environment');
        return;
      }
      try {
        const { result } = await runOrchestrator(['transition', TICKET, 'pr'], gateOpts);
        assert.equal(result.error, true);
        assert.equal(result.gate, 'check-to-pr');
        assert.ok(result.reasons.some((r) => r.includes('code-checker')));
      } finally {
        try {
          require('child_process').execFileSync('tmux', ['kill-session', '-t', sessionName], {
            timeout: 3000,
            stdio: 'pipe',
          });
        } catch {}
      }
    });

    // 9. Error case: no qa-*.check.md files
    it('should block check → pr when no qa-*.check.md files exist', async () => {
      await advanceToCheck();
      writeReport('tests.check.md', '# Tests\nStatus: APPROVED\nAll good.');
      writeReport('code-review.check.md', '# Code Review\nStatus: APPROVED\nLGTM.');
      writeReport('completion.check.md', '# Completion\nStatus: APPROVED\nDone.');
      // No qa-*.check.md files — set WEB_APPS so QA is required (GH-181: empty WEB_APPS skips QA)
      const qaOpts = {
        env: {
          ...gateOpts.env,
          WEB_APPS: '[{"name":"test-app","defaultPort":3000,"type":"vite"}]',
        },
      };
      const { result } = await runOrchestrator(['transition', TICKET, 'pr'], qaOpts);
      assert.equal(result.error, true);
      assert.equal(result.gate, 'check-to-pr');
      assert.ok(result.reasons.some((r) => r.toLowerCase().includes('qa')));
    });

    // 10. Error case: multiple failures simultaneously
    it('should list all reasons when multiple failures occur', async () => {
      await advanceToCheck();
      // Only write code-review with FAILED, missing tests + completion + qa
      // Set WEB_APPS so QA is required (GH-181: empty WEB_APPS skips QA)
      writeReport('code-review.check.md', '# Code Review\nStatus: FAILED\nBad.');
      const qaOpts = {
        env: {
          ...gateOpts.env,
          WEB_APPS: '[{"name":"test-app","defaultPort":3000,"type":"vite"}]',
        },
      };
      const { result } = await runOrchestrator(['transition', TICKET, 'pr'], qaOpts);
      assert.equal(result.error, true);
      assert.equal(result.gate, 'check-to-pr');
      assert.ok(
        result.reasons.length >= 3,
        `Expected at least 3 reasons, got ${result.reasons.length}: ${JSON.stringify(result.reasons)}`
      );
      // Should mention tests.check.md, completion.check.md, and qa
      assert.ok(result.reasons.some((r) => r.includes('tests.check.md')));
      assert.ok(result.reasons.some((r) => r.includes('completion.check.md')));
      assert.ok(result.reasons.some((r) => r.toLowerCase().includes('qa')));
    });
  });
});

// ─── parseTicketInput tests ──────────────────────────────────────────────────
// parseTicketInput is exported from work.workflow.js for testing.
const { parseTicketInput } = require(path.join(__dirname, '..', 'work.workflow.js'));

describe('parseTicketInput', () => {
  it('should parse GH-prefixed ticket with suffix', () => {
    const result = parseTicketInput('GH-145/phase1');
    assert.deepStrictEqual(result, { ticketBase: 'GH-145', suffix: 'phase1', separator: '/' });
  });

  it('should parse flat ticket ID (no suffix)', () => {
    const result = parseTicketInput('GH-145');
    assert.deepStrictEqual(result, { ticketBase: 'GH-145', suffix: null });
  });

  it('should parse Jira ticket with suffix', () => {
    const result = parseTicketInput('PROJ-123/migration-step');
    assert.deepStrictEqual(result, {
      ticketBase: 'PROJ-123',
      suffix: 'migration-step',
      separator: '/',
    });
  });

  it('should not parse URLs', () => {
    const result = parseTicketInput('https://github.com/org/repo/issues/56');
    assert.deepStrictEqual(result, {
      ticketBase: 'https://github.com/org/repo/issues/56',
      suffix: null,
    });
  });

  it('should not parse http URLs', () => {
    const result = parseTicketInput('http://example.com/path/to/resource');
    assert.deepStrictEqual(result, {
      ticketBase: 'http://example.com/path/to/resource',
      suffix: null,
    });
  });

  it('should not parse description inputs containing slashes', () => {
    const result = parseTicketInput('add login/signup page');
    assert.deepStrictEqual(result, { ticketBase: 'add login/signup page', suffix: null });
  });

  it('should not parse non-ticket patterns with slashes', () => {
    const result = parseTicketInput('some-feature/phase1');
    assert.deepStrictEqual(result, { ticketBase: 'some-feature/phase1', suffix: null });
  });

  it('should not parse bare numbers with slashes (avoids date/path confusion)', () => {
    const result = parseTicketInput('123/phase1');
    assert.deepStrictEqual(result, { ticketBase: '123/phase1', suffix: null });
  });

  it('should parse hash-prefixed GitHub issue with suffix', () => {
    const result = parseTicketInput('#42/phase1');
    assert.deepStrictEqual(result, { ticketBase: '#42', suffix: 'phase1', separator: '/' });
  });

  it('should reject path traversal in suffix', () => {
    assert.throws(() => parseTicketInput('GH-145/../etc'), /invalid suffix/);
  });

  it('should reject invalid characters in suffix', () => {
    assert.throws(() => parseTicketInput('GH-145/phase 1!@#'), /invalid suffix/);
  });

  it('should reject empty suffix after slash', () => {
    assert.throws(() => parseTicketInput('GH-145/'), /invalid suffix/);
  });

  it('should support underscores and hyphens in suffix', () => {
    const result = parseTicketInput('GH-145/step_2-alpha');
    assert.deepStrictEqual(result, {
      ticketBase: 'GH-145',
      suffix: 'step_2-alpha',
      separator: '/',
    });
  });

  it('should reject nested suffixes', () => {
    assert.throws(() => parseTicketInput('GH-145/phase1/subtask'), /invalid suffix/);
  });

  it('should handle null input', () => {
    const result = parseTicketInput(null);
    assert.deepStrictEqual(result, { ticketBase: null, suffix: null });
  });

  it('should handle undefined input', () => {
    const result = parseTicketInput(undefined);
    assert.deepStrictEqual(result, { ticketBase: undefined, suffix: null });
  });

  it('should handle non-string input', () => {
    const result = parseTicketInput(123);
    assert.deepStrictEqual(result, { ticketBase: 123, suffix: null });
  });
});

// ─── GH-211: Integration tests for task_review in plan generation ───────────

describe('GH-211: task_review in plan generation', () => {
  const TEST_TICKET = 'TEST-211';
  // Isolated temp environment to avoid GitHub provider mangling ticket IDs.
  // When TICKET_PROVIDER is github (as in this repo), TEST-211 becomes #TEST-211,
  // so we force a clean provider context via fake HOME + empty TICKET_PROVIDER.
  const TEMP_BASE = path.join(os.tmpdir(), 'work-orch-gh211-' + process.pid);
  const TEMP_HOME = path.join(TEMP_BASE, 'home');
  const TEMP_WB = path.join(TEMP_BASE, 'worktrees');
  const TEMP_TASKS = path.join(TEMP_WB, 'tasks');

  /** Env overrides that isolate the subprocess from the real provider config. */
  function isolatedEnv(extra = {}) {
    return {
      env: {
        TICKET_PROVIDER: '',
        HOME: TEMP_HOME,
        USERPROFILE: TEMP_HOME,
        WORKTREES_BASE: TEMP_WB,
        TASKS_BASE: TEMP_TASKS,
        JIRA_PROJECT_KEY: '',
        JIRA_BASE_URL: '',
        TICKET_PROJECT_KEY: '',
        LINEAR_TEAM_ID: '',
        ...extra,
      },
      cwd: TEMP_HOME,
    };
  }

  /**
   * Helper: write a tasks.md with the given number of tasks.
   */
  function writeTasksMd(tasksBase, ticket, taskCount) {
    const dir = path.join(tasksBase, ticket);
    fs.mkdirSync(dir, { recursive: true });
    let content = '# Task Plan\n\n';
    for (let i = 1; i <= taskCount; i++) {
      content += `## Task ${i}\n`;
      content += `— Task ${i} title\n\n`;
      content += `### Type\nimplementation\n\n`;
      content += `### Deliverables\n- ${i}.1 Deliverable\n\n`;
    }
    fs.writeFileSync(path.join(dir, 'tasks.md'), content);
  }

  /**
   * Helper: write a .work-state.json with tasksMeta for multi-task plans.
   * @param {object} opts - { currentTaskIndex, fixRounds, totalTasks }
   */
  function writeWorkStateWithTasks(tasksBase, ticket, opts = {}) {
    const dir = path.join(tasksBase, ticket);
    fs.mkdirSync(dir, { recursive: true });
    const totalTasks = opts.totalTasks || 3;
    const currentTaskIndex = opts.currentTaskIndex ?? 0;
    const tasks = [];
    for (let i = 0; i < totalTasks; i++) {
      const task = { id: `task_${i + 1}`, status: i < currentTaskIndex ? 'completed' : 'pending' };
      if (i === currentTaskIndex && opts.fixRounds != null) {
        task.taskReviewFixRounds = opts.fixRounds;
      }
      tasks.push(task);
    }

    const stepStatus = {};
    const allSteps = [
      'ticket', 'bootstrap', 'brief', 'brief_gate', 'spec', 'spec_gate', 'tasks',
      'implement', 'commit', 'task_review', 'check', 'pr', 'ready',
      'follow_up', 'ci', 'cleanup', 'reports', 'complete',
    ];
    for (const step of allSteps) {
      stepStatus[step] = 'pending';
    }

    const state = {
      ticketId: ticket,
      description: '',
      currentStep: 1,
      status: 'in_progress',
      stepStatus,
      checkProgress: {},
      errors: [],
      tasksMeta: {
        totalTasks,
        currentTaskIndex,
        tasks,
      },
      startTime: new Date().toISOString(),
      lastUpdate: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, '.work-state.json'), JSON.stringify(state, null, 2));
  }

  after(() => {
    try {
      fs.rmSync(TEMP_BASE, { recursive: true, force: true });
    } catch {}
  });

  afterEach(() => {
    try {
      fs.rmSync(path.join(TEMP_TASKS, TEST_TICKET), { recursive: true, force: true });
    } catch {}
  });

  // 9.1: Multi-task plan includes task_review RUN entry after commit (for non-final tasks)
  it('multi-task plan includes task_review RUN entry after commit', async () => {
    fs.mkdirSync(TEMP_HOME, { recursive: true });
    writeTasksMd(TEMP_TASKS, TEST_TICKET, 3);
    writeWorkStateWithTasks(TEMP_TASKS, TEST_TICKET, { totalTasks: 3, currentTaskIndex: 0 });
    writeTddException(TEMP_TASKS, TEST_TICKET);

    const { result, code } = await runOrchestrator([TEST_TICKET], isolatedEnv());
    assert.equal(code, 0);

    const stepNames = result.plan.map((s) => s.step);
    assert.ok(stepNames.includes('task_review'), 'plan must include task_review step');

    const taskReviewEntry = result.plan.find((s) => s.step === 'task_review');
    assert.equal(taskReviewEntry.action, 'RUN', 'task_review must be RUN for non-final task in multi-task plan');

    // task_review should come after commit in pipeline order
    const commitIdx = stepNames.indexOf('commit');
    const taskReviewIdx = stepNames.indexOf('task_review');
    assert.ok(taskReviewIdx > commitIdx, 'task_review must come after commit in plan');
  });

  // 9.1: Single-task plan skips task_review (final task -- /check handles review)
  it('single-task plan skips task_review', async () => {
    fs.mkdirSync(TEMP_HOME, { recursive: true });
    writeTasksMd(TEMP_TASKS, TEST_TICKET, 1);
    writeWorkStateWithTasks(TEMP_TASKS, TEST_TICKET, { totalTasks: 1, currentTaskIndex: 0 });
    writeTddException(TEMP_TASKS, TEST_TICKET);

    const { result, code } = await runOrchestrator([TEST_TICKET], isolatedEnv());
    assert.equal(code, 0);

    const taskReviewEntry = result.plan.find((s) => s.step === 'task_review');
    assert.ok(taskReviewEntry, 'plan must include task_review step even when skipped');
    assert.equal(taskReviewEntry.action, 'DEFER', 'task_review must be DEFER for single-task (final task)');
  });

  // 9.1: TASK_REVIEW_ENABLED=0 skips task_review
  it('TASK_REVIEW_ENABLED=0 skips task_review', async () => {
    fs.mkdirSync(TEMP_HOME, { recursive: true });
    writeTasksMd(TEMP_TASKS, TEST_TICKET, 3);
    writeWorkStateWithTasks(TEMP_TASKS, TEST_TICKET, { totalTasks: 3, currentTaskIndex: 0 });
    writeTddException(TEMP_TASKS, TEST_TICKET);

    const { result, code } = await runOrchestrator([TEST_TICKET], isolatedEnv({ TASK_REVIEW_ENABLED: '0' }));
    assert.equal(code, 0);

    const taskReviewEntry = result.plan.find((s) => s.step === 'task_review');
    assert.ok(taskReviewEntry, 'plan must include task_review step entry');
    assert.equal(taskReviewEntry.action, 'DEFER', 'task_review must be DEFER when TASK_REVIEW_ENABLED=0');
    assert.ok(
      taskReviewEntry.reason.includes('disabled') || taskReviewEntry.reason.includes('TASK_REVIEW_ENABLED'),
      'reason should mention disabled/env flag'
    );
  });

  // 9.2: Fix-round escalation -- after max fix rounds exhausted, plan shows escalation
  it('fix-round exhaustion triggers escalation (not another implement loop)', async () => {
    fs.mkdirSync(TEMP_HOME, { recursive: true });
    writeTasksMd(TEMP_TASKS, TEST_TICKET, 3);
    writeWorkStateWithTasks(TEMP_TASKS, TEST_TICKET, {
      totalTasks: 3,
      currentTaskIndex: 0,
      fixRounds: 2, // default max is 2, so >= max triggers escalation
    });
    writeTddException(TEMP_TASKS, TEST_TICKET);

    const { result, code } = await runOrchestrator([TEST_TICKET], isolatedEnv({ TASK_REVIEW_MAX_FIXES: '2' }));
    assert.equal(code, 0);

    const taskReviewEntry = result.plan.find((s) => s.step === 'task_review');
    assert.ok(taskReviewEntry, 'plan must include task_review step entry');
    assert.equal(taskReviewEntry.action, 'RUN', 'escalation entry should be RUN');
    assert.ok(
      taskReviewEntry.reason.includes('exhausted') || taskReviewEntry.reason.includes('escalat'),
      'reason should mention exhaustion or escalation'
    );
    assert.equal(taskReviewEntry.command, 'AskUserQuestion', 'escalation should use AskUserQuestion command');
  });
});
