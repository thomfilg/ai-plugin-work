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
  const dir = path.join(TEMP_TASKS_BASE, ticket);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
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
    after(() => {
      cleanupTempWorkState(TICKET);
    });

    it('should create state with all 19 steps as pending', async () => {
      const { result, code } = await runWorkState(['init', TICKET]);
      assert.equal(code, 0);
      assert.equal(result.ticketId, TICKET);
      assert.equal(result.status, 'in_progress');
      assert.ok(result.startTime);
      assert.ok(result.lastUpdate);
      assert.deepEqual(result.checkProgress, {});
      assert.equal(result.errors.length, 0);

      const steps = Object.keys(result.stepStatus);
      // GH-244: 19 steps — added spec_gate between spec and tasks.
      assert.equal(steps.length, 19);
      for (const step of steps) {
        assert.equal(result.stepStatus[step], 'pending', `Step ${step} should be pending`);
      }

      // Verify exact step names
      const expectedSteps = [
        'ticket',
        'bootstrap',
        'brief',
        'brief_gate', // GH-215
        'spec',
        'spec_gate', // GH-244
        'tasks',
        'tasks_gate', // Gate C
        'implement',
        'commit',
        'task_review', // GH-211
        'check',
        'pr',
        'ready',
        'follow_up',
        'ci',
        'cleanup',
        'reports',
        'complete',
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
      assert.equal(result.stepStatus['ticket'], 'pending');

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
      // GH-244: 19 steps — added spec_gate between spec and tasks.
      assert.equal(Object.keys(result.stepStatus).length, 19);
      for (const step of Object.keys(result.stepStatus)) {
        assert.equal(result.stepStatus[step], 'pending');
      }
    });
  });

  describe('set-step', () => {
    const TICKET = 'TEST-SETSTEP-001';
    after(() => {
      cleanupTempWorkState(TICKET);
    });

    it('should update step status and persist', async () => {
      await runWorkState(['init', TICKET]);

      const { result: setResult, code: setCode } = await runWorkState([
        'set-step',
        TICKET,
        'implement',
        'in_progress',
      ]);
      assert.equal(setCode, 0);
      assert.equal(setResult.success, true);
      assert.equal(setResult.step, 'implement');
      assert.equal(setResult.status, 'in_progress');

      // Verify persistence
      const { result: getResult } = await runWorkState(['get', TICKET]);
      assert.equal(getResult.stepStatus['implement'], 'in_progress');
      // currentStep should reflect implement's position in STEP_ORDER:
      // ticket, bootstrap, brief, brief_gate, spec, spec_gate, tasks, tasks_gate, implement → index 8 → currentStep 9.
      // Gate C inserts tasks_gate between tasks and implement.
      assert.equal(getResult.currentStep, 9);
    });

    it('should reject invalid step name with exit code 1', async () => {
      const TICKET_INVALID = 'TEST-SETSTEP-INV';

      await runWorkState(['init', TICKET_INVALID]);

      const { code, stderr } = await runWorkState([
        'set-step',
        TICKET_INVALID,
        'nonexistent_step',
        'in_progress',
      ]);
      assert.equal(code, 1, 'Should exit with code 1 for invalid step');
      assert.ok(
        stderr.includes('Invalid step name') || stderr.includes('nonexistent_step'),
        'Error should mention the invalid step name'
      );

      // Verify invalid key is NOT persisted in state
      const { result: afterResult } = await runWorkState(['get', TICKET_INVALID]);
      assert.equal(
        afterResult.stepStatus['nonexistent_step'],
        undefined,
        'Invalid step name must not be persisted in state'
      );

      cleanupTempWorkState(TICKET_INVALID);
    });
  });

  describe('set-check', () => {
    const TICKET = 'TEST-SETCHECK-001';
    after(() => {
      cleanupTempWorkState(TICKET);
    });

    it('should update check sub-state and accumulate multiple checks', async () => {
      await runWorkState(['init', TICKET]);

      // Set lint check to pass
      const { result: lintResult, code: lintCode } = await runWorkState([
        'set-check',
        TICKET,
        'lint',
        'pass',
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
      const { result, stderr, code } = await runWorkState(['complete', TICKET_MISSING]);
      assert.equal(code, 1);
      const errResult = JSON.parse(stderr.trim());
      assert.ok(errResult.error);
      assert.equal(errResult.error, 'No state found');
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
          const proc = spawn(
            'node',
            [path.join(__dirname, '..', 'engine', 'work.workflow.js'), 'graph'],
            {
              stdio: ['pipe', 'pipe', 'pipe'],
              env: { ...process.env, TASKS_BASE: TEMP_TASKS_BASE },
            }
          );
          let stdout = '';
          proc.stdout.on('data', (d) => {
            stdout += d.toString();
          });
          proc.on('close', () => {
            try {
              resolve(JSON.parse(stdout.trim()).steps);
            } catch {
              resolve(null);
            }
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
    after(() => {
      cleanupTempWorkState(TICKET);
    });

    it('should be idempotent — second init preserves existing state', async () => {
      // First init
      await runWorkState(['init', TICKET]);

      // Modify state: set a step to in_progress
      await runWorkState(['set-step', TICKET, 'implement', 'in_progress']);

      // Verify the modification persisted
      const { result: beforeSecondInit } = await runWorkState(['get', TICKET]);
      assert.equal(beforeSecondInit.stepStatus['implement'], 'in_progress');

      // Second init — should return existing state unchanged
      const { result: secondInitResult } = await runWorkState(['init', TICKET]);
      assert.equal(secondInitResult.status, 'in_progress');
      assert.equal(
        secondInitResult.stepStatus['implement'],
        'in_progress',
        'Second init should preserve existing step status'
      );

      // Verify persistence is unchanged
      const { result: afterSecondInit } = await runWorkState(['get', TICKET]);
      assert.equal(
        afterSecondInit.stepStatus['implement'],
        'in_progress',
        'Second init must not reset existing state'
      );
    });
  });

  // ─── Subtask State Tests ────────────────────────────────────────────────────

  describe('init-subtask', () => {
    const TICKET = 'TEST-SUBTASK-INIT';
    after(() => {
      cleanupTempWorkState(TICKET);
    });

    it('should create subtask state with correct schema and counter=1', async () => {
      const { result, code } = await runWorkState(['init-subtask', TICKET, 'fix lint error']);
      assert.equal(code, 0);
      assert.equal(result.ticketId, TICKET);
      assert.equal(result.isSubtask, true);
      assert.equal(result.parentTicketId, TICKET);
      assert.equal(result.subtaskIndex, 1);
      assert.equal(result.status, 'in_progress');
      assert.equal(result.description, 'fix lint error');
      assert.ok(result.startTime);
      assert.ok(result.lastUpdate);

      // Only implement, commit steps
      const steps = Object.keys(result.stepStatus);
      assert.deepEqual(steps, ['implement', 'commit']);
      for (const step of steps) {
        assert.equal(result.stepStatus[step], 'pending', `Step ${step} should be pending`);
      }

      // Verify file was written
      const stateFile = path.join(TEMP_TASKS_BASE, TICKET, `.work-state-${TICKET}-subtask-1.json`);
      assert.ok(fs.existsSync(stateFile), 'Subtask state file should exist on disk');
    });

    it('should increment counter to 2 on second call', async () => {
      const { result, code } = await runWorkState(['init-subtask', TICKET, 'fix type error']);
      assert.equal(code, 0);
      assert.equal(result.subtaskIndex, 2);
      assert.equal(result.description, 'fix type error');

      // Verify file was written
      const stateFile = path.join(TEMP_TASKS_BASE, TICKET, `.work-state-${TICKET}-subtask-2.json`);
      assert.ok(fs.existsSync(stateFile), 'Second subtask state file should exist on disk');
    });

    it('should auto-create task directory if missing', async () => {
      const TICKET_NEW = 'TEST-SUBTASK-NEWDIR';
      const taskDir = path.join(TEMP_TASKS_BASE, TICKET_NEW);

      // Ensure directory does not exist
      assert.ok(!fs.existsSync(taskDir), 'Task directory should not exist before init');

      const { result, code } = await runWorkState(['init-subtask', TICKET_NEW, 'new dir test']);
      assert.equal(code, 0);
      assert.equal(result.subtaskIndex, 1);
      assert.ok(fs.existsSync(taskDir), 'Task directory should be created');

      cleanupTempWorkState(TICKET_NEW);
    });
  });

  describe('active-subtask', () => {
    const TICKET = 'TEST-SUBTASK-ACTIVE';
    after(() => {
      cleanupTempWorkState(TICKET);
    });

    it('should return the in-progress subtask', async () => {
      // Create a subtask
      await runWorkState(['init-subtask', TICKET, 'active test']);

      const { result, code } = await runWorkState(['active-subtask', TICKET]);
      assert.equal(code, 0);
      assert.equal(result.subtaskIndex, 1);
      assert.equal(result.status, 'in_progress');
    });

    it('should return null when all subtasks are completed', async () => {
      // Complete the existing subtask
      await runWorkState(['complete-subtask', TICKET, '1']);

      const { result, code } = await runWorkState(['active-subtask', TICKET]);
      assert.equal(code, 0);
      assert.equal(result, null);
    });

    it('should return the most recent in-progress subtask when multiple exist', async () => {
      // Uses same TICKET as prior tests (sequential within describe block).
      // Each test builds on prior state: subtask-1 exists from earlier test.
      await runWorkState(['init-subtask', TICKET, 'second subtask']);
      await runWorkState(['complete-subtask', TICKET, '2']);
      await runWorkState(['init-subtask', TICKET, 'third subtask']);

      const { result, code } = await runWorkState(['active-subtask', TICKET]);
      assert.equal(code, 0);
      assert.equal(result.subtaskIndex, 3);
      assert.equal(result.status, 'in_progress');
      assert.equal(result.description, 'third subtask');
    });

    it('should skip corrupt JSON files gracefully', async () => {
      const TICKET_CORRUPT = 'TEST-SUBTASK-CORRUPT';
      const taskDir = path.join(TEMP_TASKS_BASE, TICKET_CORRUPT);
      fs.mkdirSync(taskDir, { recursive: true });

      // Write a corrupt subtask state file
      fs.writeFileSync(
        path.join(taskDir, `.work-state-${TICKET_CORRUPT}-subtask-1.json`),
        '{corrupt!!!'
      );

      const { result, code } = await runWorkState(['active-subtask', TICKET_CORRUPT]);
      assert.equal(code, 0);
      assert.equal(result, null, 'Should return null when only corrupt files exist');

      cleanupTempWorkState(TICKET_CORRUPT);
    });
  });

  // ─── Suffix-aware state tests (GH-146) ──────────────────────────────────────

  describe('suffix-aware state (GH-146)', () => {
    const TICKET_BASE = 'TEST-SUFFIX-STATE';
    const TICKET_SUFFIXED = 'TEST-SUFFIX-STATE/phase1';

    after(() => {
      cleanupTempWorkState(TICKET_BASE);
    });

    it('should create state in nested directory for suffixed ticket', async () => {
      const { result, code } = await runWorkState(['init', TICKET_SUFFIXED, 'Phase 1 work']);
      assert.equal(code, 0);
      assert.ok(result, 'init should return a result');
      assert.equal(result.ticketId, TICKET_SUFFIXED);

      // Verify file was created in the nested path
      const statePath = path.join(TEMP_TASKS_BASE, TICKET_BASE, 'phase1', '.work-state.json');
      assert.ok(fs.existsSync(statePath), `State file should exist at ${statePath}`);
    });

    it('should not interfere with flat ticket state', async () => {
      // Init flat ticket
      await runWorkState(['init', TICKET_BASE, 'Flat ticket work']);

      // Verify flat state
      const flatPath = path.join(TEMP_TASKS_BASE, TICKET_BASE, '.work-state.json');
      assert.ok(fs.existsSync(flatPath), 'Flat state file should exist');

      // Verify suffixed state still exists
      const suffixedPath = path.join(TEMP_TASKS_BASE, TICKET_BASE, 'phase1', '.work-state.json');
      assert.ok(fs.existsSync(suffixedPath), 'Suffixed state file should still exist');

      // Verify they have different ticketIds
      const flatState = JSON.parse(fs.readFileSync(flatPath, 'utf-8'));
      const suffixedState = JSON.parse(fs.readFileSync(suffixedPath, 'utf-8'));
      assert.equal(flatState.ticketId, TICKET_BASE);
      assert.equal(suffixedState.ticketId, TICKET_SUFFIXED);
    });

    it('should load state correctly for suffixed ticket', async () => {
      const { result, code } = await runWorkState(['get', TICKET_SUFFIXED]);
      assert.equal(code, 0);
      assert.ok(result, 'get should return state');
      assert.equal(result.ticketId, TICKET_SUFFIXED);
    });

    it('should support multiple suffixes under same base ticket', async () => {
      const TICKET_PHASE2 = 'TEST-SUFFIX-STATE/phase2';

      const { result, code } = await runWorkState(['init', TICKET_PHASE2, 'Phase 2 work']);
      assert.equal(code, 0);
      assert.equal(result.ticketId, TICKET_PHASE2);

      // Both phases should have separate state files
      const phase1Path = path.join(TEMP_TASKS_BASE, TICKET_BASE, 'phase1', '.work-state.json');
      const phase2Path = path.join(TEMP_TASKS_BASE, TICKET_BASE, 'phase2', '.work-state.json');
      assert.ok(fs.existsSync(phase1Path), 'Phase 1 state should exist');
      assert.ok(fs.existsSync(phase2Path), 'Phase 2 state should exist');
    });
  });

  describe('TDD auto-init on implement step', () => {
    const TICKET = 'TEST-TDD-AUTOINIT';
    after(() => {
      cleanupTempWorkState(TICKET);
    });

    it('should create tdd-phase.json when setting implement to in_progress', async () => {
      await runWorkState(['init', TICKET]);

      const { code } = await runWorkState(['set-step', TICKET, 'implement', 'in_progress']);
      assert.equal(code, 0);

      // Verify tdd-phase.json was created
      const tddPath = path.join(TEMP_TASKS_BASE, TICKET, 'tdd-phase.json');
      assert.ok(fs.existsSync(tddPath), 'tdd-phase.json should be auto-created');

      const tddState = JSON.parse(fs.readFileSync(tddPath, 'utf8'));
      assert.equal(tddState.currentPhase, 'red');
      assert.equal(tddState.currentCycle, 1);
      assert.deepEqual(tddState.cycles, []);
    });

    it('should be idempotent — not overwrite existing tdd-phase.json', async () => {
      const TICKET_EXISTING = 'TEST-TDD-EXISTING';
      try {
        await runWorkState(['init', TICKET_EXISTING]);

        // Pre-create tdd-phase.json with green phase (simulating mid-cycle)
        const tddDir = path.join(TEMP_TASKS_BASE, TICKET_EXISTING);
        fs.mkdirSync(tddDir, { recursive: true });
        const existingState = {
          currentPhase: 'green',
          currentCycle: 2,
          cycles: [{ cycle: 1, red: {}, green: {} }],
        };
        fs.writeFileSync(path.join(tddDir, 'tdd-phase.json'), JSON.stringify(existingState));

        // Now set implement to in_progress
        await runWorkState(['set-step', TICKET_EXISTING, 'implement', 'in_progress']);

        // Verify existing state was NOT overwritten
        const tddState = JSON.parse(fs.readFileSync(path.join(tddDir, 'tdd-phase.json'), 'utf8'));
        assert.equal(tddState.currentPhase, 'green', 'Should preserve existing phase');
        assert.equal(tddState.currentCycle, 2, 'Should preserve existing cycle');
      } finally {
        cleanupTempWorkState(TICKET_EXISTING);
      }
    });

    it('should NOT create tdd-phase.json for non-implement steps', async () => {
      const TICKET_OTHER = 'TEST-TDD-OTHER-STEP';
      try {
        await runWorkState(['init', TICKET_OTHER]);

        await runWorkState(['set-step', TICKET_OTHER, 'brief', 'in_progress']);

        const tddPath = path.join(TEMP_TASKS_BASE, TICKET_OTHER, 'tdd-phase.json');
        assert.ok(!fs.existsSync(tddPath), 'tdd-phase.json should NOT be created for brief step');
      } finally {
        cleanupTempWorkState(TICKET_OTHER);
      }
    });
  });

  describe('complete-subtask', () => {
    const TICKET = 'TEST-SUBTASK-COMPLETE';
    after(() => {
      cleanupTempWorkState(TICKET);
    });

    it('should mark the correct subtask as completed', async () => {
      // Create a subtask
      await runWorkState(['init-subtask', TICKET, 'complete test']);

      const { result, code } = await runWorkState(['complete-subtask', TICKET, '1']);
      assert.equal(code, 0);
      assert.equal(result.status, 'completed');
      assert.equal(result.subtaskIndex, 1);
      assert.ok(result.completedTime);

      // All step statuses should be completed
      for (const step of Object.keys(result.stepStatus)) {
        assert.equal(result.stepStatus[step], 'completed', `Step ${step} should be completed`);
      }

      // Verify persistence
      const stateFile = path.join(TEMP_TASKS_BASE, TICKET, `.work-state-${TICKET}-subtask-1.json`);
      const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      assert.equal(persisted.status, 'completed');
    });
  });

  // ─── Task Review Fix-Round Tracking (GH-211) ──────────────────────────────

  describe('task review fix-round tracking (GH-211)', () => {
    const TICKET = 'TEST-FIXROUND-001';
    after(() => {
      cleanupTempWorkState(TICKET);
    });

    it('getTaskReviewFixRounds returns 0 for a task without prior fix rounds', async () => {
      // Initialize state with task tracking
      await runWorkState(['init', TICKET]);
      await runWorkState(['task-init', TICKET, '3']);

      const { result, code } = await runWorkState(['task-review-fix-rounds', TICKET]);
      assert.equal(code, 0);
      assert.equal(result.fixRounds, 0);
    });

    it('incrementTaskReviewFixRounds increases count by 1 and persists', async () => {
      const { result: incResult, code: incCode } = await runWorkState([
        'task-review-fix-rounds-increment',
        TICKET,
      ]);
      assert.equal(incCode, 0);
      assert.equal(incResult.fixRounds, 1);

      // Verify persistence
      const { result: getResult } = await runWorkState(['task-review-fix-rounds', TICKET]);
      assert.equal(getResult.fixRounds, 1);

      // Increment again
      const { result: incResult2 } = await runWorkState([
        'task-review-fix-rounds-increment',
        TICKET,
      ]);
      assert.equal(incResult2.fixRounds, 2);

      // Verify persistence again
      const { result: getResult2 } = await runWorkState(['task-review-fix-rounds', TICKET]);
      assert.equal(getResult2.fixRounds, 2);
    });

    it('resetTaskReviewFixRounds resets count to 0 and persists', async () => {
      // Currently at 2 from previous test
      const { result: resetResult, code: resetCode } = await runWorkState([
        'task-review-fix-rounds-reset',
        TICKET,
      ]);
      assert.equal(resetCode, 0);
      assert.equal(resetResult.fixRounds, 0);

      // Verify persistence
      const { result: getResult } = await runWorkState(['task-review-fix-rounds', TICKET]);
      assert.equal(getResult.fixRounds, 0);
    });

    it('stores fixRounds in tasksMeta.tasks[N].taskReviewFixRounds', async () => {
      // Increment once to set a value
      await runWorkState(['task-review-fix-rounds-increment', TICKET]);

      // Read raw state to verify field location
      const { result: rawState } = await runWorkState(['get', TICKET]);
      const currentIdx = rawState.tasksMeta.currentTaskIndex;
      assert.equal(
        rawState.tasksMeta.tasks[currentIdx].taskReviewFixRounds,
        1,
        'taskReviewFixRounds should be stored in tasksMeta.tasks[N]'
      );
    });

    it('TASK_REVIEW_MAX_FIXES env var controls max rounds (default 2)', async () => {
      // Reset and set to 1
      await runWorkState(['task-review-fix-rounds-reset', TICKET]);
      await runWorkState(['task-review-fix-rounds-increment', TICKET]);

      // With default max (2), should not be at max yet
      const { result: notMax } = await runWorkState(['task-review-fix-rounds', TICKET]);
      assert.equal(notMax.fixRounds, 1);
      assert.equal(notMax.maxFixRounds, 2);
      assert.equal(notMax.maxReached, false);

      // Increment to 2 — should be at max
      await runWorkState(['task-review-fix-rounds-increment', TICKET]);
      const { result: atMax } = await runWorkState(['task-review-fix-rounds', TICKET]);
      assert.equal(atMax.fixRounds, 2);
      assert.equal(atMax.maxReached, true);
    });

    it('TASK_REVIEW_MAX_FIXES env var overrides default', async () => {
      // Reset to 1
      await runWorkState(['task-review-fix-rounds-reset', TICKET]);
      await runWorkState(['task-review-fix-rounds-increment', TICKET]);

      // With TASK_REVIEW_MAX_FIXES=5, should not be at max
      const { result } = await runWorkState(['task-review-fix-rounds', TICKET], {
        env: { TASK_REVIEW_MAX_FIXES: '5' },
      });
      assert.equal(result.fixRounds, 1);
      assert.equal(result.maxFixRounds, 5);
      assert.equal(result.maxReached, false);
    });

    it('returns error when task tracking is not initialized', async () => {
      const TICKET_NO_TASKS = 'TEST-FIXROUND-NOTASK';
      try {
        await runWorkState(['init', TICKET_NO_TASKS]);

        const { code, stderr } = await runWorkState(['task-review-fix-rounds', TICKET_NO_TASKS]);
        assert.equal(code, 1);
        const errResult = JSON.parse(stderr.trim());
        assert.ok(errResult.error);
      } finally {
        cleanupTempWorkState(TICKET_NO_TASKS);
      }
    });
  });

  // ─── Terminal guard: completeWork rejects pending tasks (GH-245 Task 5) ────

  describe('completeWork terminal guard (GH-245)', () => {
    const TICKET_PENDING = 'TEST-GUARD-PENDING';
    const TICKET_DONE = 'TEST-GUARD-DONE';
    const TICKET_NO_META = 'TEST-GUARD-NOMETA';

    after(() => {
      cleanupTempWorkState(TICKET_PENDING);
      cleanupTempWorkState(TICKET_DONE);
      cleanupTempWorkState(TICKET_NO_META);
    });

    it('should reject completion when tasks are still pending', async () => {
      // Init state and add tasksMeta with a pending task
      await runWorkState(['init', TICKET_PENDING]);
      await runWorkState(['task-init', TICKET_PENDING, '3']);

      const { code, stderr } = await runWorkState(['complete', TICKET_PENDING]);
      assert.equal(code, 1, 'Should exit with code 1 when tasks are pending');
      const errResult = JSON.parse(stderr.trim());
      assert.ok(errResult.error, 'Should return an error');
      assert.match(
        errResult.error,
        /tasks still pending/i,
        'Error should mention tasks still pending'
      );
    });

    it('should succeed when all tasks are completed', async () => {
      // Init state, add tasksMeta, and complete all tasks
      await runWorkState(['init', TICKET_DONE]);
      await runWorkState(['task-init', TICKET_DONE, '2']);
      // Advance both tasks to completed
      await runWorkState(['task-advance', TICKET_DONE]);
      await runWorkState(['task-advance', TICKET_DONE]);

      const { result, code } = await runWorkState(['complete', TICKET_DONE]);
      assert.equal(code, 0, 'Should exit with code 0 when all tasks completed');
      assert.equal(result.status, 'completed');
    });

    it('should succeed when no tasksMeta exists (backward compat)', async () => {
      // Init state without task tracking
      await runWorkState(['init', TICKET_NO_META]);

      const { result, code } = await runWorkState(['complete', TICKET_NO_META]);
      assert.equal(code, 0, 'Should exit with code 0 when no tasksMeta exists');
      assert.equal(result.status, 'completed');
    });
  });
});
