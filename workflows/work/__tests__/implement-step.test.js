/**
 * implement-step.test.js
 *
 * GH-219 Task 16: Tests for dependency-aware messaging in implement.js.
 *
 * Verifies that implement step output includes:
 *   - Task id (task_N) when tasksMeta exists
 *   - Claim owner (PR{N}) when a claim is active
 *   - Dependency status when tasks have dependencies
 *
 * Uses node:test + node:assert/strict with in-memory fixture state.
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const implementStep = require('../steps/implement');

// ─── Lock file helpers (claim tests write real lock files) ──────────────────
let _claimCleanupDirs = [];
function writeClaim(tasksDir, taskNum, ownerId) {
  const claimsDir = path.join(tasksDir, '.claims');
  fs.mkdirSync(claimsDir, { recursive: true });
  _claimCleanupDirs.push(claimsDir);
  fs.writeFileSync(
    path.join(claimsDir, `task-${taskNum}.lock`),
    JSON.stringify({ ownerId, taskNum })
  );
}
function cleanupClaims() {
  for (const dir of _claimCleanupDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  _claimCleanupDirs = [];
}

// ─── Test helpers ────────────────────────────────────────────────────────────

/**
 * Build a minimal `s` (inspected state) fixture.
 * Mirrors the shape produced by inspect.js and consumed by step handlers.
 */
function makeState(overrides = {}) {
  return {
    hasTasks: true,
    workState: {
      status: 'in_progress',
      stepStatus: { implement: 'pending' },
      tasksMeta: {
        totalTasks: 3,
        currentTaskIndex: 0,
        tasks: [
          { id: 'task_1', status: 'pending', dependencies: [] },
          { id: 'task_2', status: 'pending', dependencies: [1] },
          { id: 'task_3', status: 'pending', dependencies: [1, 2] },
        ],
      },
      ...overrides.workState,
    },
    hasDiffVsMain: false,
    diffSummary: '',
    stepIs: (step) => overrides.stepStatus?.[step] ?? 'pending',
    ...overrides,
  };
}

/**
 * Build task data as parseTasks would return.
 */
function makeTaskData(tasks) {
  return tasks.map((t, i) => ({
    id: `task_${t.num ?? i + 1}`,
    num: t.num ?? i + 1,
    title: t.title ?? `Task ${t.num ?? i + 1} title`,
    type: t.type ?? 'backend',
    isCheckpoint: t.isCheckpoint ?? false,
    dependencies: t.dependencies ?? [],
    requirementsCovered: '',
    acceptanceCriteria: '',
    suggestedScope: '',
    rawContent: `## Task ${t.num ?? i + 1} — ${t.title ?? `Task ${t.num ?? i + 1} title`}`,
  }));
}

/**
 * Build minimal `ctx` with stubs for functions the step calls.
 */
function makeCtx(overrides = {}) {
  const tasksDir = overrides.tasksDir ?? '/tmp/fake-tasks';
  const taskData = overrides.taskData ?? null;
  return {
    STEPS: {
      implement: 'implement',
    },
    safeName: 'GH-219',
    tasksDir,
    planningContext: '',
    getDocsPrompt: () => '',
    parseTasks: () => taskData,
    buildTaskPrompt: (task) =>
      `## Current Task: Task ${task.num} — ${task.title}\n\nYou are implementing ONE task.\n\n### Task Details\n${task.rawContent}`,
    fileExists: () => false,
    path,
    execFileSync: () => '',
    workStatePath: path.join(__dirname, '..', 'work-state.js'),
    ...overrides,
  };
}

/**
 * Capture the plan entry emitted by implementStep via the add() callback.
 */
function captureStep(s, ctx) {
  const entries = [];
  function add(step, action, command, reason, meta) {
    entries.push({ step, action, command, reason, meta });
  }
  implementStep(add, s, ctx);
  return entries;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('implement step — dependency-aware messaging (GH-219 Task 16)', () => {
  describe('task id in output', () => {
    it('includes task id (task_N) in reason when tasksMeta exists', () => {
      const taskData = makeTaskData([
        { num: 1, title: 'Enforcement audit records' },
        { num: 2, title: 'Context adapter' },
      ]);
      const s = makeState({
        workState: {
          tasksMeta: {
            totalTasks: 2,
            currentTaskIndex: 0,
            tasks: [
              { id: 'task_1', status: 'pending', dependencies: [] },
              { id: 'task_2', status: 'pending', dependencies: [1] },
            ],
          },
        },
      });
      const ctx = makeCtx({ taskData });
      const entries = captureStep(s, ctx);

      assert.equal(entries.length, 1);
      const entry = entries[0];
      assert.equal(entry.action, 'RUN');
      // Reason should mention the task id
      // Strict: must include exact task_1 id, not just "Task 1"
      assert.ok(entry.reason.includes('task_1'),
        `reason should mention task id "task_1", got: "${entry.reason}"`);
    });

    it('includes task id for non-first task', () => {
      const taskData = makeTaskData([
        { num: 1, title: 'First task' },
        { num: 2, title: 'Second task' },
        { num: 3, title: 'Third task' },
      ]);
      const s = makeState({
        workState: {
          tasksMeta: {
            totalTasks: 3,
            currentTaskIndex: 1,
            tasks: [
              { id: 'task_1', status: 'completed', dependencies: [] },
              { id: 'task_2', status: 'pending', dependencies: [1] },
              { id: 'task_3', status: 'pending', dependencies: [1, 2] },
            ],
          },
        },
      });
      const ctx = makeCtx({ taskData });
      const entries = captureStep(s, ctx);

      const entry = entries[0];
      assert.equal(entry.action, 'RUN');
      // Must reference task_2
      assert.ok(
        entry.reason.includes('task_2'),
        `reason should mention current task id "task_2", got: "${entry.reason}"`
      );
    });
  });

  describe('claim and PR slot in output', () => {
    afterEach(() => cleanupClaims());

    it('includes claim owner (PR{N}) in reason when claim is present', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-test-'));
      _claimCleanupDirs.push(tmpDir);
      writeClaim(tmpDir, 1, 'PR1'); // claim via lock file, not tasksMeta.claimedBy
      const taskData = makeTaskData([
        { num: 1, title: 'First task' },
      ]);
      const s = makeState({
        workState: {
          tasksMeta: {
            totalTasks: 1,
            currentTaskIndex: 0,
            tasks: [ // no claimedBy — claim lives in lock file
              { id: 'task_1', status: 'pending', dependencies: [] },
            ], // claim ownership read from .claims/task-1.lock, not here
          },
        },
      });
      const ctx = makeCtx({ taskData, tasksDir: tmpDir }); // tasksDir points to tmpDir with lock file
      const entries = captureStep(s, ctx);

      const entry = entries[0];
      assert.equal(entry.action, 'RUN');
      // Reason or agentPrompt should mention PR1
      const text = (entry.reason || '') + (entry.meta?.agentPrompt || '');
      assert.ok(
        text.includes('PR1'),
        `output should mention claim owner PR1, got reason: "${entry.reason}", prompt: "${entry.meta?.agentPrompt?.substring(0, 200)}"`
      );
    });

    it('includes PR slot in agentPrompt when worker slot is allocated', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-test-'));
      _claimCleanupDirs.push(tmpDir);
      writeClaim(tmpDir, 1, 'PR2'); // claim via lock file, not tasksMeta.claimedBy
      const taskData = makeTaskData([
        { num: 1, title: 'First task' },
      ]);
      const s = makeState({
        workState: {
          tasksMeta: {
            totalTasks: 1,
            currentTaskIndex: 0,
            tasks: [ // no claimedBy — claim lives in lock file
              { id: 'task_1', status: 'pending', dependencies: [] },
            ], // claim ownership read from .claims/task-1.lock, not here
          },
          parallelWorkers: {
            nextSlot: 3,
            allocations: [
              { slot: 1, ownerId: 'PR1', releasedAt: '2026-01-01T00:00:00Z' },
              { slot: 2, ownerId: 'PR2', claimedAt: '2026-01-02T00:00:00Z' },
            ],
          },
        },
      });
      const ctx = makeCtx({ taskData, tasksDir: tmpDir });
      const entries = captureStep(s, ctx);

      const entry = entries[0];
      const prompt = entry.meta?.agentPrompt || '';
      assert.ok(
        prompt.includes('Worker slot:'),
        `agentPrompt should include "Worker slot:" line, got: "${prompt.substring(0, 300)}"`
      );
      assert.ok(
        prompt.includes('PR2'),
        `agentPrompt should mention PR2, got: "${prompt.substring(0, 300)}"`
      );
    });
  });

  describe('dependency status in output', () => {
    it('includes dependency status phrase when task has dependencies', () => {
      const taskData = makeTaskData([
        { num: 1, title: 'First task', dependencies: [] },
        { num: 2, title: 'Second task', dependencies: [1] },
      ]);
      const s = makeState({
        workState: {
          tasksMeta: {
            totalTasks: 2,
            currentTaskIndex: 1,
            tasks: [
              { id: 'task_1', status: 'completed', dependencies: [] },
              { id: 'task_2', status: 'pending', dependencies: [1] },
            ],
          },
        },
      });
      const ctx = makeCtx({ taskData });
      const entries = captureStep(s, ctx);

      const entry = entries[0];
      const text = (entry.reason || '') + (entry.meta?.agentPrompt || '');
      // Should mention dependencies are met / resolved / ready
      assert.ok(
        /dependenc/i.test(text) || /deps.*ready/i.test(text) || /deps.*met/i.test(text),
        `output should mention dependency status, got reason: "${entry.reason}"`
      );
    });

    it('does not mention dependencies when task has none', () => {
      const taskData = makeTaskData([
        { num: 1, title: 'First task', dependencies: [] },
      ]);
      const s = makeState({
        workState: {
          tasksMeta: {
            totalTasks: 1,
            currentTaskIndex: 0,
            tasks: [
              { id: 'task_1', status: 'pending', dependencies: [] },
            ],
          },
        },
      });
      const ctx = makeCtx({ taskData });
      const entries = captureStep(s, ctx);

      const entry = entries[0];
      assert.equal(entry.action, 'RUN'); // verify step runs
      // No dependency phrase should appear when task has no dependencies
      assert.ok(
        !/dependenc/i.test(entry.reason),
        `reason should not mention dependencies, got: "${entry.reason}"`
      );
      assert.ok(
        !/### Dependencies/i.test(entry.meta?.agentPrompt || ''),
        `agentPrompt should not include Dependencies section`
      );
    });
  });

  describe('existing behaviors preserved', () => {
    it('DEFERs when all tasks are done', () => {
      const taskData = makeTaskData([
        { num: 1, title: 'Only task' },
      ]);
      const s = makeState({
        workState: {
          tasksMeta: {
            totalTasks: 1,
            currentTaskIndex: 1,  // past the end
            tasks: [
              { id: 'task_1', status: 'completed', dependencies: [] },
            ],
          },
        },
      });
      const ctx = makeCtx({ taskData });
      const entries = captureStep(s, ctx);

      assert.equal(entries[0].action, 'DEFER');
      assert.ok(entries[0].reason.includes('All tasks completed'));
    });

    it('DEFERs checkpoint tasks', () => {
      const taskData = makeTaskData([
        { num: 1, title: 'Checkpoint task', isCheckpoint: true, type: 'checkpoint' },
      ]);
      const s = makeState({
        workState: {
          tasksMeta: {
            totalTasks: 1,
            currentTaskIndex: 0,
            tasks: [
              { id: 'task_1', status: 'pending', dependencies: [] },
            ],
          },
        },
      });
      const ctx = makeCtx({ taskData });
      const entries = captureStep(s, ctx);

      assert.equal(entries[0].action, 'DEFER');
      assert.ok(entries[0].reason.includes('checkpoint'));
    });

    it('DEFERs when implement previously completed with diff', () => {
      const taskData = makeTaskData([
        { num: 1, title: 'Task one' },
      ]);
      const s = makeState({
        hasDiffVsMain: true,
        diffSummary: '3 files changed',
        stepStatus: { implement: 'completed' },
        workState: {
          tasksMeta: {
            totalTasks: 1,
            currentTaskIndex: 0,
            tasks: [
              { id: 'task_1', status: 'pending', dependencies: [] },
            ],
          },
        },
      });
      const ctx = makeCtx({ taskData });
      const entries = captureStep(s, ctx);

      assert.equal(entries[0].action, 'DEFER');
    });

    it('emits RUN without tasks when hasTasks is false', () => {
      const s = makeState({ hasTasks: false });
      const ctx = makeCtx({ taskData: null });
      const entries = captureStep(s, ctx);

      assert.equal(entries[0].action, 'RUN');
      // No task-specific messaging when no tasks exist
    });

    it('exports task metadata on ctx for task-advance step', () => {
      const taskData = makeTaskData([
        { num: 1, title: 'First task' },
      ]);
      const s = makeState({
        workState: {
          tasksMeta: {
            totalTasks: 1,
            currentTaskIndex: 0,
            tasks: [
              { id: 'task_1', status: 'pending', dependencies: [] },
            ],
          },
        },
      });
      const ctx = makeCtx({ taskData });
      captureStep(s, ctx);

      assert.ok(ctx._taskData !== undefined, 'ctx._taskData should be set');
      assert.equal(ctx._allTasksDone, false);
      assert.equal(ctx._currentTaskIdx, 0);
    });
  });
});
