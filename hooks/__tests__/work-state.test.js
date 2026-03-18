/**
 * Tests for work-state.js
 *
 * Uses node:test + node:assert/strict.
 * Run: node --test hooks/__tests__/work-state.test.js
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOOK_PATH = path.join(__dirname, '..', 'work-state.js');
const TEMP_TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'work-state-test-'));

// ─── Helpers ────────────────────────────────────────────────────────────────

function runWorkState(args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TASKS_BASE: TEMP_TASKS_BASE, ...opts.env },
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
  const dir = path.join(TEMP_TASKS_BASE, ticket);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ─── Global Cleanup ─────────────────────────────────────────────────────────

after(() => {
  try {
    fs.rmSync(TEMP_TASKS_BASE, { recursive: true, force: true });
  } catch {}
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('work-state.js', () => {

  describe('init', () => {
    const TICKET = 'TEST-INIT-001';
    after(() => { cleanupTempWorkState(TICKET); });

    it('should create state with all 13 steps as pending', async () => {
      const { result, code } = await runWorkState(['init', TICKET]);
      assert.equal(code, 0);
      assert.equal(result.ticketId, TICKET);
      assert.equal(result.status, 'in_progress');
      assert.ok(result.startTime);
      assert.ok(result.lastUpdate);
      assert.deepEqual(result.checkProgress, {});
      assert.equal(result.errors.length, 0);

      const steps = Object.keys(result.stepStatus);
      assert.equal(steps.length, 13);
      for (const step of steps) {
        assert.equal(result.stepStatus[step], 'pending', `Step ${step} should be pending`);
      }

      // Verify exact step names
      const expectedSteps = [
        '1_ticket', '2_bootstrap', '3_implement', '4_quality',
        '5_commit', '6_check', '7_cleanup', '8_test_enhancement',
        '9_pr', '10_ready', '11_ci', '12_reports', '13_complete',
      ];
      assert.deepEqual(steps, expectedSteps);
    });

    it('should recover from corrupt state file on init', async () => {
      const TICKET_CORRUPT = 'TEST-INIT-CORRUPT';
      const stateDir = path.join(TEMP_TASKS_BASE, TICKET_CORRUPT);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, '.work-state.json'), '{corrupt!!!');

      const { result, code } = await runWorkState(['init', TICKET_CORRUPT]);
      assert.equal(code, 0);
      assert.ok(result);
      assert.equal(result.stepStatus['1_ticket'], 'pending');

      cleanupTempWorkState(TICKET_CORRUPT);
    });
  });

  describe('get', () => {
    const TICKET_MISSING = 'TEST-GET-MISS';
    const TICKET_EXISTS = 'TEST-GET-EXISTS';
    after(() => {
      cleanupTempWorkState(TICKET_MISSING);
      cleanupTempWorkState(TICKET_EXISTS);
    });

    it('should return null for nonexistent ticket', async () => {
      const { result, code } = await runWorkState(['get', TICKET_MISSING]);
      assert.equal(code, 0);
      assert.equal(result, null);
    });

    it('should return persisted state after init', async () => {
      await runWorkState(['init', TICKET_EXISTS]);
      const { result, code } = await runWorkState(['get', TICKET_EXISTS]);
      assert.equal(code, 0);
      assert.equal(result.ticketId, TICKET_EXISTS);
      assert.equal(result.status, 'in_progress');
      assert.equal(Object.keys(result.stepStatus).length, 13);
      for (const step of Object.keys(result.stepStatus)) {
        assert.equal(result.stepStatus[step], 'pending');
      }
    });
  });

  describe('set-step', () => {
    const TICKET = 'TEST-SETSTEP-001';
    after(() => { cleanupTempWorkState(TICKET); });

    it('should update step status and persist', async () => {
      await runWorkState(['init', TICKET]);

      const { result: setResult, code: setCode } = await runWorkState([
        'set-step', TICKET, '3_implement', 'in_progress',
      ]);
      assert.equal(setCode, 0);
      assert.equal(setResult.success, true);
      assert.equal(setResult.step, '3_implement');
      assert.equal(setResult.status, 'in_progress');

      // Verify persistence
      const { result: getResult } = await runWorkState(['get', TICKET]);
      assert.equal(getResult.stepStatus['3_implement'], 'in_progress');
      // currentStep should be updated to 3 (index 2 + 1)
      assert.equal(getResult.currentStep, 3);
    });

    it('should reject invalid step name with exit code 1', async () => {
      const TICKET_INVALID = 'TEST-SETSTEP-INV';

      await runWorkState(['init', TICKET_INVALID]);

      const { code, stderr } = await runWorkState(['set-step', TICKET_INVALID, 'nonexistent_step', 'in_progress']);
      assert.equal(code, 1, 'Should exit with code 1 for invalid step');
      assert.ok(stderr.includes('Invalid step name') || stderr.includes('nonexistent_step'),
        'Error should mention the invalid step name');

      // Verify invalid key is NOT persisted in state
      const { result: afterResult } = await runWorkState(['get', TICKET_INVALID]);
      assert.equal(afterResult.stepStatus['nonexistent_step'], undefined,
        'Invalid step name must not be persisted in state');

      cleanupTempWorkState(TICKET_INVALID);
    });
  });

  describe('set-check', () => {
    const TICKET = 'TEST-SETCHECK-001';
    after(() => { cleanupTempWorkState(TICKET); });

    it('should update check sub-state and accumulate multiple checks', async () => {
      await runWorkState(['init', TICKET]);

      // Set lint check to pass
      const { result: lintResult, code: lintCode } = await runWorkState([
        'set-check', TICKET, 'lint', 'pass',
      ]);
      assert.equal(lintCode, 0);
      assert.equal(lintResult.success, true);
      assert.equal(lintResult.agent, 'lint');
      assert.equal(lintResult.status, 'pass');

      // Verify lint is persisted
      const { result: afterLint } = await runWorkState(['get', TICKET]);
      assert.equal(afterLint.checkProgress.lint.status, 'pass');

      // Set typecheck to pass
      await runWorkState(['set-check', TICKET, 'typecheck', 'pass']);

      // Verify both accumulate
      const { result: afterBoth } = await runWorkState(['get', TICKET]);
      assert.equal(afterBoth.checkProgress.lint.status, 'pass');
      assert.equal(afterBoth.checkProgress.typecheck.status, 'pass');
      assert.ok(afterBoth.checkProgress.lint.lastUpdate);
      assert.ok(afterBoth.checkProgress.typecheck.lastUpdate);
    });
  });

  describe('complete', () => {
    const TICKET_OK = 'TEST-COMPLETE-OK';
    const TICKET_MISSING = 'TEST-COMPLETE-MISS';
    after(() => {
      cleanupTempWorkState(TICKET_OK);
      cleanupTempWorkState(TICKET_MISSING);
    });

    it('should mark all steps completed and set completedTime', async () => {
      await runWorkState(['init', TICKET_OK]);
      const { result, code } = await runWorkState(['complete', TICKET_OK]);

      assert.equal(code, 0);
      assert.equal(result.status, 'completed');
      assert.ok(result.completedTime);

      // All steps should be completed
      for (const step of Object.keys(result.stepStatus)) {
        assert.equal(result.stepStatus[step], 'completed', `Step ${step} should be completed`);
      }

      // Verify persistence
      const { result: getResult } = await runWorkState(['get', TICKET_OK]);
      assert.equal(getResult.status, 'completed');
      assert.ok(getResult.completedTime);
    });

    it('should return error for nonexistent ticket', async () => {
      const { result, code } = await runWorkState(['complete', TICKET_MISSING]);
      assert.equal(code, 0);
      assert.ok(result.error);
      assert.equal(result.error, 'No state found');
    });
  });

  describe('step list alignment', () => {
    it('should have STEPS array matching work-orchestrator.js ALL_STEPS', async () => {
      // Get steps from work-state.js via init output
      const TICKET = 'TEST-ALIGN-001';
      try {
        const { result } = await runWorkState(['init', TICKET]);
        const workStateSteps = Object.keys(result.stepStatus);

        // Load ALL_STEPS from work-orchestrator.js via graph subcommand
        const orchestratorSteps = await new Promise((resolve, reject) => {
          const proc = spawn('node', [
            path.join(__dirname, '..', 'work-orchestrator.js'), 'graph',
          ], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, TASKS_BASE: TEMP_TASKS_BASE },
          });
          let stdout = '';
          proc.stdout.on('data', (d) => { stdout += d.toString(); });
          proc.on('close', () => {
            try { resolve(JSON.parse(stdout.trim()).steps); }
            catch { resolve(null); }
          });
          proc.on('error', reject);
        });

        assert.ok(orchestratorSteps, 'Failed to get steps from work-orchestrator graph');
        assert.deepEqual(workStateSteps, orchestratorSteps);
      } finally {
        cleanupTempWorkState(TICKET);
      }
    });
  });

  describe('init idempotency', () => {
    const TICKET = 'TEST-IDEMPOTENT-001';
    after(() => { cleanupTempWorkState(TICKET); });

    it('should be idempotent — second init preserves existing state', async () => {
      // First init
      await runWorkState(['init', TICKET]);

      // Modify state: set a step to in_progress
      await runWorkState(['set-step', TICKET, '3_implement', 'in_progress']);

      // Verify the modification persisted
      const { result: beforeSecondInit } = await runWorkState(['get', TICKET]);
      assert.equal(beforeSecondInit.stepStatus['3_implement'], 'in_progress');

      // Second init — should return existing state unchanged
      const { result: secondInitResult } = await runWorkState(['init', TICKET]);
      assert.equal(secondInitResult.status, 'in_progress');
      assert.equal(secondInitResult.stepStatus['3_implement'], 'in_progress',
        'Second init should preserve existing step status');

      // Verify persistence is unchanged
      const { result: afterSecondInit } = await runWorkState(['get', TICKET]);
      assert.equal(
        afterSecondInit.stepStatus['3_implement'],
        'in_progress',
        'Second init must not reset existing state',
      );
    });
  });
});
