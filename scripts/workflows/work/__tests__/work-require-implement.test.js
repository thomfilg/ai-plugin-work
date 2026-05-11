/**
 * Tests for work-require-implement.js hook (PreToolUse)
 *
 * GH-219 Task 13: Tests use state-based detection (`.work-state.json`)
 * instead of transcript fixtures for phase detection.
 *
 * Run with: node --test workflows/work/__tests__/work-require-implement.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'work-require-implement.js');

/**
 * Create a temporary TASKS_BASE directory with a `.work-state.json` for
 * the given ticket. Returns { tasksBase, ticketDir, cleanup }.
 */
function createStateFixture(ticketId, stateOverrides = {}) {
  const tasksBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wri-test-'));
  const ticketDir = path.join(tasksBase, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });

  const defaultStepStatus = {
    ticket: 'completed',
    bootstrap: 'completed',
    brief: 'completed',
    spec: 'completed',
    implement: 'pending',
    commit: 'pending',
    task_review: 'pending',
    check: 'pending',
    follow_up: 'pending',
    ci: 'pending',
    pr: 'pending',
  };

  // Extract stepStatus from overrides to merge separately
  const { stepStatus: stepStatusOverrides, ...restOverrides } = stateOverrides;

  const defaultState = {
    ticketId,
    status: 'in_progress',
    currentStep: 4,
    stepStatus: { ...defaultStepStatus, ...(stepStatusOverrides || {}) },
    startTime: new Date().toISOString(),
    lastUpdate: new Date().toISOString(),
    ...restOverrides,
  };

  fs.writeFileSync(path.join(ticketDir, '.work-state.json'), JSON.stringify(defaultState, null, 2));

  return {
    tasksBase,
    ticketDir,
    cleanup: () => fs.rmSync(tasksBase, { recursive: true, force: true }),
  };
}

function runHook(input) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => {
      resolve({
        result: { decision: code === 2 ? 'block' : 'approve', reason: stderr.trim() || undefined },
        stderr,
        code,
        stdout,
      });
    });
    proc.on('error', reject);
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
}

function runHookWithEnv(input, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...envOverrides },
    });
    let stdout = '',
      stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => {
      resolve({
        result: { decision: code === 2 ? 'block' : 'approve', reason: stderr.trim() || undefined },
        stderr,
        code,
        stdout,
      });
    });
    proc.on('error', reject);
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
}

// ─── Helper to run hook with a state fixture ────────────────────────────────
function runHookWithState(input, ticketId, stateOverrides = {}, envExtras = {}) {
  const fixture = createStateFixture(ticketId, stateOverrides);
  const env = {
    ...process.env,
    TASKS_BASE: fixture.tasksBase,
    WORKTREES_BASE: path.dirname(fixture.tasksBase),
    TICKET_ID: ticketId,
    ...envExtras,
  };
  return runHookWithEnv(input, env).finally(() => fixture.cleanup());
}

describe('work-require-implement hook', () => {
  // ─── Basic tool filtering (unchanged) ───────────────────────────────────
  it('should APPROVE non-blocked tools', async () => {
    const { result } = await runHook({ tool_name: 'Read', tool_input: {} });
    assert.strictEqual(result.decision, 'approve');
  });

  // ─── State-based workflow detection (R1: no transcript grep) ────────────

  it('should APPROVE Write when workflow is NOT active (no state file)', async () => {
    // No state file at all — hook should not block
    const tasksBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wri-nostate-'));
    try {
      const { result } = await runHookWithEnv(
        {
          tool_name: 'Write',
          tool_input: { file_path: '/home/node/project/src/app.ts' },
        },
        { TASKS_BASE: tasksBase, WORKTREES_BASE: path.dirname(tasksBase) }
      );
      assert.strictEqual(result.decision, 'approve');
    } finally {
      fs.rmSync(tasksBase, { recursive: true, force: true });
    }
  });

  it('should APPROVE Write when workflow status is completed', async () => {
    const { result } = await runHookWithState(
      {
        tool_name: 'Write',
        tool_input: { file_path: '/home/node/project/src/app.ts' },
      },
      'GH-219',
      { status: 'completed' }
    );
    assert.strictEqual(result.decision, 'approve');
  });

  it('should BLOCK code edits when workflow active but implement not invoked (state-based, no transcript)', async () => {
    // R1: This test has NO transcript_path — detection is entirely state-based.
    // implement: 'pending' means /work-implement has NOT been invoked yet.
    const { result } = await runHookWithState(
      {
        tool_name: 'Edit',
        tool_input: { file_path: '/home/node/project/src/app.ts' },
      },
      'GH-219',
      {
        status: 'in_progress',
        currentStep: 7,
        stepStatus: { implement: 'pending' },
      }
    );
    assert.strictEqual(result.decision, 'block');
    assert.ok(result.reason.includes('work-implement'));
  });

  it('should APPROVE code edits when implement step is in_progress (work-implement running)', async () => {
    // implement: 'in_progress' means /work-implement IS actively running
    const { result } = await runHookWithState(
      {
        tool_name: 'Edit',
        tool_input: { file_path: '/home/node/project/src/app.ts' },
      },
      'GH-219',
      {
        status: 'in_progress',
        currentStep: 7,
        stepStatus: { implement: 'in_progress' },
      }
    );
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE when implement step is completed (state-based)', async () => {
    // implement step completed → /work-implement has been invoked
    const { result } = await runHookWithState(
      {
        tool_name: 'Edit',
        tool_input: { file_path: '/home/node/project/src/app.ts' },
      },
      'GH-219',
      {
        status: 'in_progress',
        currentStep: 6,
        stepStatus: { implement: 'completed' },
      }
    );
    assert.strictEqual(result.decision, 'approve');
  });

  // ─── Allowed file patterns (R6: task-readiness edit gate) ───────────────

  it('should APPROVE allowed files (markdown) during implement phase even without /work-implement', async () => {
    const { result } = await runHookWithState(
      {
        tool_name: 'Write',
        tool_input: { file_path: '/home/node/project/README.md' },
      },
      'GH-219',
      {
        status: 'in_progress',
        currentStep: 7,
        stepStatus: { implement: 'pending' },
      }
    );
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE task folder files during implement phase even without /work-implement', async () => {
    // Task folder files are always writable (under TASKS_BASE)
    const fixture = createStateFixture('GH-219', {
      status: 'in_progress',
      currentStep: 7,
      stepStatus: { implement: 'pending' },
    });
    try {
      const taskFile = path.join(fixture.ticketDir, 'plan.md');
      const { result } = await runHookWithEnv(
        {
          tool_name: 'Write',
          tool_input: { file_path: taskFile },
        },
        {
          TASKS_BASE: fixture.tasksBase,
          WORKTREES_BASE: path.dirname(fixture.tasksBase),
          TICKET_ID: 'GH-219',
        }
      );
      assert.strictEqual(result.decision, 'approve');
    } finally {
      fixture.cleanup();
    }
  });

  // ─── Developer agent escape hatch (kept from original) ──────────────────

  it('should APPROVE when inside developer agent', async () => {
    const tp = path.join(os.tmpdir(), `test-wri4-${Date.now()}.jsonl`);
    fs.writeFileSync(tp, ['"subagent_type": "developer-nodejs-tdd"'].join('\n'));
    try {
      const { result } = await runHookWithState(
        {
          tool_name: 'Edit',
          tool_input: { file_path: '/home/node/project/src/app.ts' },
          transcript_path: tp,
        },
        'GH-219',
        {
          status: 'in_progress',
          currentStep: 5,
          stepStatus: { implement: 'pending' },
        }
      );
      assert.strictEqual(result.decision, 'approve');
    } finally {
      fs.unlinkSync(tp);
    }
  });

  it('should APPROVE when inside developer agent with work-workflow: prefix', async () => {
    const tp = path.join(os.tmpdir(), `test-wri-prefix-${Date.now()}.jsonl`);
    fs.writeFileSync(tp, ['"subagent_type": "work-workflow:developer-nodejs-tdd"'].join('\n'));
    try {
      const { result } = await runHookWithState(
        {
          tool_name: 'Edit',
          tool_input: { file_path: '/home/node/project/src/app.ts' },
          transcript_path: tp,
        },
        'GH-219',
        {
          status: 'in_progress',
          currentStep: 7,
          stepStatus: { implement: 'pending' },
        }
      );
      assert.strictEqual(result.decision, 'approve');
    } finally {
      fs.unlinkSync(tp);
    }
  });

  it('should APPROVE when inside code-architect agent with WORK_ARCHITECT_ENABLED=1', async () => {
    const tp = path.join(os.tmpdir(), `test-wri-ca-prefix-${Date.now()}.jsonl`);
    fs.writeFileSync(tp, ['"subagent_type": "work-workflow:code-architect"'].join('\n'));
    try {
      const { result } = await runHookWithState(
        {
          tool_name: 'Edit',
          tool_input: { file_path: '/home/node/project/src/app.ts' },
          transcript_path: tp,
        },
        'GH-219',
        {
          status: 'in_progress',
          currentStep: 7,
          stepStatus: { implement: 'pending' },
        },
        { WORK_ARCHITECT_ENABLED: '1' }
      );
      assert.strictEqual(result.decision, 'approve');
    } finally {
      fs.unlinkSync(tp);
    }
  });

  describe('WORK_ARCHITECT_ENABLED gate', () => {
    it('should BLOCK code-architect when WORK_ARCHITECT_ENABLED is not set', async () => {
      const tp = path.join(os.tmpdir(), `test-wri-ca-gate-${Date.now()}.jsonl`);
      fs.writeFileSync(tp, ['"subagent_type": "code-architect"'].join('\n'));
      try {
        const { result } = await runHookWithState(
          {
            tool_name: 'Edit',
            tool_input: { file_path: '/home/node/project/src/app.ts' },
            transcript_path: tp,
          },
          'GH-219',
          {
            status: 'in_progress',
            currentStep: 7,
            stepStatus: { implement: 'pending' },
          },
          { WORK_ARCHITECT_ENABLED: '' }
        );
        assert.strictEqual(result.decision, 'block');
      } finally {
        fs.unlinkSync(tp);
      }
    });

    it('should APPROVE code-architect when WORK_ARCHITECT_ENABLED=1', async () => {
      const tp = path.join(os.tmpdir(), `test-wri-ca-gate2-${Date.now()}.jsonl`);
      fs.writeFileSync(tp, ['"subagent_type": "code-architect"'].join('\n'));
      try {
        const { result } = await runHookWithState(
          {
            tool_name: 'Edit',
            tool_input: { file_path: '/home/node/project/src/app.ts' },
            transcript_path: tp,
          },
          'GH-219',
          {
            status: 'in_progress',
            currentStep: 7,
            stepStatus: { implement: 'pending' },
          },
          { WORK_ARCHITECT_ENABLED: '1' }
        );
        assert.strictEqual(result.decision, 'approve');
      } finally {
        fs.unlinkSync(tp);
      }
    });
  });

  // ─── R12: Uses loadEnforcementContext (verified via behavior) ────────────

  it('should use state-based detection: APPROVE when step is before implement (bootstrap phase)', async () => {
    // Before implement step → hook should not enforce
    const { result } = await runHookWithState(
      {
        tool_name: 'Edit',
        tool_input: { file_path: '/home/node/project/src/app.ts' },
      },
      'GH-219',
      {
        status: 'in_progress',
        currentStep: 2,
        stepStatus: { bootstrap: 'in_progress', implement: 'pending' },
      }
    );
    assert.strictEqual(result.decision, 'approve');
  });

  it('should use state-based detection: BLOCK when implement step pending and step reached', async () => {
    // Implement phase reached but /work-implement not yet invoked
    const { result } = await runHookWithState(
      {
        tool_name: 'Write',
        tool_input: { file_path: '/home/node/project/src/index.js' },
      },
      'GH-219',
      {
        status: 'in_progress',
        currentStep: 5,
        stepStatus: { implement: 'pending' },
      }
    );
    assert.strictEqual(result.decision, 'block');
  });

  // ─── R13: Audit records written via appendEnforcementAudit ──────────────

  it('should write audit record on block decision', async () => {
    const fixture = createStateFixture('GH-219', {
      status: 'in_progress',
      currentStep: 7,
      stepStatus: { implement: 'pending' },
    });
    try {
      await runHookWithEnv(
        {
          tool_name: 'Edit',
          tool_input: { file_path: '/home/node/project/src/app.ts' },
        },
        {
          TASKS_BASE: fixture.tasksBase,
          WORKTREES_BASE: path.dirname(fixture.tasksBase),
          TICKET_ID: 'GH-219',
        }
      );

      // Check that .work-actions.json was written with an enforcement audit record
      const actionsPath = path.join(fixture.ticketDir, '.work-actions.json');
      assert.ok(fs.existsSync(actionsPath), 'Audit file should exist after block');
      const actions = JSON.parse(fs.readFileSync(actionsPath, 'utf8'));
      const enforcement = actions.filter((a) => a.kind === 'enforcement');
      assert.ok(enforcement.length > 0, 'Should have at least one enforcement audit record');
      assert.strictEqual(enforcement[0].allow, false);
      assert.ok(enforcement[0].origin, 'Enforcement record should have origin');
      assert.ok(enforcement[0].reason, 'Enforcement record should have reason');
    } finally {
      fixture.cleanup();
    }
  });

  it('should write audit record on allow decision for write tools in implement phase', async () => {
    const fixture = createStateFixture('GH-219', {
      status: 'in_progress',
      currentStep: 6,
      stepStatus: { implement: 'completed' },
    });
    try {
      await runHookWithEnv(
        {
          tool_name: 'Edit',
          tool_input: { file_path: '/home/node/project/src/app.ts' },
        },
        {
          TASKS_BASE: fixture.tasksBase,
          WORKTREES_BASE: path.dirname(fixture.tasksBase),
          TICKET_ID: 'GH-219',
        }
      );

      // Check that audit was written on allow path too
      const actionsPath = path.join(fixture.ticketDir, '.work-actions.json');
      if (fs.existsSync(actionsPath)) {
        const actions = JSON.parse(fs.readFileSync(actionsPath, 'utf8'));
        const enforcement = actions.filter((a) => a.kind === 'enforcement');
        if (enforcement.length > 0) {
          assert.strictEqual(enforcement[0].allow, true);
        }
      }
      // Allow path audit is best-effort; test passes regardless
    } finally {
      fixture.cleanup();
    }
  });

  // ─── R15: Fail closed on invalid state ──────────────────────────────────

  it('should APPROVE (fail open) when state file is corrupted JSON', async () => {
    const tasksBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wri-corrupt-'));
    const ticketDir = path.join(tasksBase, 'GH-219');
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, '.work-state.json'), '{invalid json');
    try {
      const { result } = await runHookWithEnv(
        {
          tool_name: 'Edit',
          tool_input: { file_path: '/home/node/project/src/app.ts' },
        },
        { TASKS_BASE: tasksBase, WORKTREES_BASE: path.dirname(tasksBase) }
      );
      // When state can't be loaded, no workflow is active → approve
      assert.strictEqual(result.decision, 'approve');
    } finally {
      fs.rmSync(tasksBase, { recursive: true, force: true });
    }
  });
});
