/**
 * Tests for task tracking in work-state.js
 *
 * Uses node:test + node:assert/strict.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WORK_STATE_PATH = path.join(__dirname, '..', 'work-state.js');
const TEMP_TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'task-tracking-test-'));

function runWorkState(args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [WORK_STATE_PATH, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TASKS_BASE: TEMP_TASKS_BASE, ...opts.env },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
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

after(() => {
  try {
    fs.rmSync(TEMP_TASKS_BASE, { recursive: true, force: true });
  } catch {}
});

describe('task tracking', () => {
  const ticket = 'TEST-TASKS-001';

  it('should initialize task tracking', async () => {
    // First init the work state
    await runWorkState(['init', ticket]);
    // Then init tasks with 5 tasks
    const { result } = await runWorkState(['task-init', ticket, '5']);
    assert.ok(result.success);
    assert.equal(result.tasksMeta.totalTasks, 5);
    assert.equal(result.tasksMeta.currentTaskIndex, 0);
    assert.equal(result.tasksMeta.tasks.length, 5);
    assert.equal(result.tasksMeta.tasks[0].status, 'pending');
  });

  it('should get current task', async () => {
    const { result } = await runWorkState(['task-current', ticket]);
    assert.equal(result.id, 'task_1');
    assert.equal(result.index, 0);
    assert.equal(result.status, 'pending');
    assert.equal(result.total, 5);
  });

  it('should advance to next task', async () => {
    const { result } = await runWorkState(['task-advance', ticket]);
    assert.equal(result.done, false);
    assert.equal(result.completedTask, 0);
    assert.equal(result.nextTask.id, 'task_2');
    assert.equal(result.nextTask.index, 1);
  });

  it('should get task by index', async () => {
    const { result } = await runWorkState(['task-get', ticket, '0']);
    assert.equal(result.id, 'task_1');
    assert.equal(result.status, 'completed');
  });

  it('should advance through all tasks to completion', async () => {
    // Currently at task 2 (index 1), advance through to end
    await runWorkState(['task-advance', ticket]); // 2 -> 3
    await runWorkState(['task-advance', ticket]); // 3 -> 4
    await runWorkState(['task-advance', ticket]); // 4 -> 5
    const { result } = await runWorkState(['task-advance', ticket]); // 5 -> done
    assert.equal(result.done, true);
    assert.ok(result.message.includes('All tasks completed'));
  });

  it('should report done when asking for current after all complete', async () => {
    const { result } = await runWorkState(['task-current', ticket]);
    assert.equal(result.done, true);
  });

  it('should error on task-current when no task tracking', async () => {
    const { code, stderr } = await runWorkState(['task-current', 'TEST-NO-TASKS']);
    assert.equal(code, 1);
    const errResult = JSON.parse(stderr.trim());
    assert.ok(errResult.error);
  });

  it('should reject invalid taskCount values', async () => {
    const ticket2 = 'TEST-TASKS-INVALID';
    await runWorkState(['init', ticket2]);

    // taskCount = 0
    const { code: code0, stderr: stderr0 } = await runWorkState(['task-init', ticket2, '0']);
    assert.equal(code0, 1);
    assert.ok(stderr0.includes('Invalid taskCount'));

    // taskCount = -1
    const { code: codeNeg, stderr: stderrNeg } = await runWorkState(['task-init', ticket2, '-1']);
    assert.equal(codeNeg, 1);
    assert.ok(stderrNeg.includes('Invalid taskCount'));

    // taskCount = abc (NaN after parseInt)
    const { code: codeNaN, stderr: stderrNaN } = await runWorkState(['task-init', ticket2, 'abc']);
    assert.equal(codeNaN, 1);
    assert.ok(stderrNaN.includes('Invalid taskCount'));
  });

  it('should return idempotent result when advancing past completion', async () => {
    // All tasks for TEST-TASKS-001 are already complete from previous tests
    const { result } = await runWorkState(['task-advance', ticket]);
    assert.equal(result.done, true);
    assert.ok(result.message.includes('already completed'));
  });
});

describe('parseTasks', () => {
  // parseTasks is inside work.workflow.js — test via the orchestrator plan output
  const ticket = 'GH-500';

  it('should detect tasks.md in plan and show task info', async () => {
    // GH-500 normalizes to #500 internally, which sanitizes to GH-500 on disk
    const tasksDir = path.join(TEMP_TASKS_BASE, 'GH-500');
    fs.mkdirSync(tasksDir, { recursive: true });

    // Create minimal spec.md and tasks.md
    fs.writeFileSync(path.join(tasksDir, 'spec.md'), '# Spec\nSome spec content');
    fs.writeFileSync(path.join(tasksDir, 'brief.md'), '# Brief\nSome brief content');
    fs.writeFileSync(
      path.join(tasksDir, 'tasks.md'),
      `# Tasks

_Generated from: brief.md, spec.md_
_Ticket: GH-500_

## Task 1 — Setup data models

### Type
backend

### Description
Create shared data models.

### Requirements Covered
- R1

### Deliverables
- [ ] 1.1 Create models module
  - Test: Models validate correctly
  - _Requirements: R1 (data layer)_

### Acceptance Criteria
- Models exist and validate

### Dependencies
- None

### Parallel
- Yes

---

## Task 2 — Implement API

### Type
backend

### Description
Build the REST API.

### Requirements Covered
- R2

### Deliverables
- [ ] 2.1 Create API endpoints
  - Test: Endpoints return correct responses
  - _Requirements: R2 (API layer)_

### Acceptance Criteria
- API endpoints work

### Dependencies
- Task 1 (needs models)

### Parallel
- No

---

## Task 3 — Checkpoint: Verify backend

### Type
checkpoint

### Description
Verify all prior tasks are correctly implemented.

### Acceptance Criteria
- All tests pass

### Dependencies
- Task 1, Task 2

---
`
    );

    // Init work state
    fs.writeFileSync(
      path.join(tasksDir, '.work-state.json'),
      JSON.stringify({
        ticketId: 'GH-500',
        status: 'in_progress',
        stepStatus: {},
        checkProgress: {},
        errors: [],
        startTime: new Date().toISOString(),
        lastUpdate: new Date().toISOString(),
      })
    );

    // Run orchestrator
    const ORCH_PATH = path.join(__dirname, '..', 'work.workflow.js');
    const { result } = await new Promise((resolve, reject) => {
      const proc = spawn('node', [ORCH_PATH, ticket], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          TASKS_BASE: TEMP_TASKS_BASE, // both base paths use temp dir for isolation
          WORKTREES_BASE: TEMP_TASKS_BASE,
          SESSION_GUARD_ENABLED: '0',
        },
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => {
        stdout += d.toString();
      });
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      proc.on('close', (code) => {
        try {
          resolve({ result: JSON.parse(stdout.trim()), code });
        } catch (e) {
          resolve({ result: null, stdout, stderr, code, parseError: e.message });
        }
      });
      proc.on('error', reject);
    });

    assert.ok(result, 'Orchestrator should return a plan');
    assert.ok(result.plan, 'Plan should exist');

    // Find the tasks step
    const tasksStep = result.plan.find((p) => p.step === 'tasks');
    assert.ok(tasksStep, 'tasks step should exist in plan');
    assert.equal(tasksStep.action, 'DEFER', 'tasks.md already exists so should be DEFER');

    // Find implement step — should reference Task 1
    const implStep = result.plan.find((p) => p.step === 'implement');
    assert.ok(implStep, 'implement step should exist');
    // The prompt should mention Task 1 since tasks.md exists and currentTaskIndex defaults to 0
    assert.ok(
      implStep.agentPrompt?.includes('Task 1') || implStep.reason?.includes('Task 1'),
      'implement should reference Task 1'
    );
  });

  it('should DEFER tasks step when spec.md is missing', async () => {
    const tasksDir = path.join(TEMP_TASKS_BASE, 'GH-501');
    fs.mkdirSync(tasksDir, { recursive: true });

    // Create brief but NO spec.md and NO tasks.md
    fs.writeFileSync(path.join(tasksDir, 'brief.md'), '# Brief\nSome brief content');

    // Init work state
    fs.writeFileSync(
      path.join(tasksDir, '.work-state.json'),
      JSON.stringify({
        ticketId: 'GH-501',
        status: 'in_progress',
        stepStatus: {},
        checkProgress: {},
        errors: [],
        startTime: new Date().toISOString(),
        lastUpdate: new Date().toISOString(),
      })
    );

    const ORCH_PATH = path.join(__dirname, '..', 'work.workflow.js');
    const { result } = await new Promise((resolve, reject) => {
      const proc = spawn('node', [ORCH_PATH, 'GH-501'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          TASKS_BASE: TEMP_TASKS_BASE,
          WORKTREES_BASE: TEMP_TASKS_BASE,
          SESSION_GUARD_ENABLED: '0',
        },
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => {
        stdout += d.toString();
      });
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      proc.on('close', (code) => {
        try {
          resolve({ result: JSON.parse(stdout.trim()), code });
        } catch (e) {
          resolve({ result: null, stdout, stderr, code, parseError: e.message });
        }
      });
      proc.on('error', reject);
    });

    assert.ok(result, 'Orchestrator should return a plan');
    assert.ok(result.plan, 'Plan should exist');

    const tasksStep = result.plan.find((p) => p.step === 'tasks');
    assert.ok(tasksStep, 'tasks step should exist in plan');
    assert.equal(tasksStep.action, 'DEFER', 'tasks should DEFER when spec.md is missing');
    assert.equal(tasksStep.agentType, 'skill', 'DEFER tasks should have agentType');
    assert.ok(tasksStep.agentPrompt, 'DEFER tasks should have agentPrompt');
  });
});
