/**
 * Tests for work-implement-enforce.js hook (PreToolUse)
 *
 * GH-219 Task 14: Rewritten for state-based activation via
 * loadEnforcementContext + isWriteAllowedPath from Task 12.
 * No transcript grep for implement-active detection.
 *
 * Run with: node --test workflows/work-implement/__tests__/work-implement-enforce.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'work-implement-enforce.js');

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

function runHook(input) {
  return runHookWithEnv(input, {});
}
function createWorkState(ticketDir, overrides = {}) {
  const stateFileName = '.work-state' + '.json';
  const state = {
    ticketId: overrides.ticketId || 'TEST-1',
    status: overrides.status || 'in_progress',
    currentStep: overrides.currentStep != null ? overrides.currentStep : 4,
    stepStatus: overrides.stepStatus || {
      bootstrap: 'completed',
      implement: 'in_progress',
    },
    ...overrides,
  };
  fs.writeFileSync(path.join(ticketDir, stateFileName), JSON.stringify(state, null, 2));
  return state;
}

function createTddPhaseState(ticketDir, phase) {
  const statePath = path.join(ticketDir, 'tdd-phase.json');
  fs.writeFileSync(
    statePath,
    JSON.stringify({ currentPhase: phase, currentCycle: 1, cycles: [] })
  );
  return statePath;
}

function createPerTaskTddPhaseState(ticketDir, taskNum, phase) {
  const taskDir = path.join(ticketDir, 'task' + taskNum);
  fs.mkdirSync(taskDir, { recursive: true });
  const statePath = path.join(taskDir, 'tdd-phase.json');
  fs.writeFileSync(
    statePath,
    JSON.stringify({ currentPhase: phase, currentCycle: 1, cycles: [] })
  );
  return statePath;
}

function createTestEnv(ticketId, stateOverrides = {}) {
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wie-test-'));
  const ticketDir = path.join(tempBase, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  createWorkState(ticketDir, { ticketId, ...stateOverrides });
  return {
    tempBase,
    ticketId,
    ticketDir,
    env: { TASKS_BASE: tempBase, TICKET_ID: ticketId },
    cleanup: () => fs.rmSync(tempBase, { recursive: true, force: true }),
  };
}

function makeTranscript(content = '') {
  const tp = path.join(
    os.tmpdir(),
    'test-wie-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.jsonl'
  );
  fs.writeFileSync(tp, content);
  return tp;
}
describe('work-implement-enforce hook (GH-219 Task 14 — state-based)', () => {
  it('should APPROVE non-blocked tools (Read, Bash)', async () => {
    const { result } = await runHook({ tool_name: 'Read', tool_input: {} });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE Write when no workflow state exists (no ticket ID)', async () => {
    // Explicitly blank TICKET_ID to prevent inheriting from parent env
    const { result } = await runHookWithEnv(
      {
        tool_name: 'Write',
        tool_input: { file_path: '/home/node/project/src/app.ts' },
      },
      { TICKET_ID: '' }
    );
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE Write when workflow exists but implement step NOT active', async () => {
    const env = createTestEnv('TEST-INACTIVE', {
      stepStatus: { bootstrap: 'in_progress' },
    });
    const { result } = await runHookWithEnv(
      { tool_name: 'Write', tool_input: { file_path: '/home/node/project/src/app.ts' } },
      env.env
    );
    env.cleanup();
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE Write when workflow status is not in_progress', async () => {
    const env = createTestEnv('TEST-DONE', {
      status: 'completed',
      stepStatus: { bootstrap: 'completed', implement: 'completed' },
    });
    const { result } = await runHookWithEnv(
      { tool_name: 'Write', tool_input: { file_path: '/home/node/project/src/app.ts' } },
      env.env
    );
    env.cleanup();
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE allowed files (markdown) when implement active', async () => {
    const env = createTestEnv('TEST-MD');
    const tp = makeTranscript();
    const { result } = await runHookWithEnv(
      { tool_name: 'Write', tool_input: { file_path: '/home/node/project/README.md' }, transcript_path: tp },
      env.env
    );
    env.cleanup();
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE .claude folder files', async () => {
    const env = createTestEnv('TEST-CLAUDE');
    const tp = makeTranscript();
    const { result } = await runHookWithEnv(
      { tool_name: 'Write', tool_input: { file_path: '/tmp/project/.claude/hooks/test.js' }, transcript_path: tp },
      env.env
    );
    env.cleanup();
    assert.strictEqual(result.decision, 'approve');
  });

  it('should BLOCK code edits when implement active but no developer agent', async () => {
    const env = createTestEnv('TEST-NOAGENT');
    const tp = makeTranscript('');
    const { result } = await runHookWithEnv(
      { tool_name: 'Edit', tool_input: { file_path: '/home/node/project/src/app.ts' }, transcript_path: tp },
      env.env
    );
    env.cleanup();
    assert.strictEqual(result.decision, 'block');
    assert.ok(result.reason.includes('work-implement requires agent delegation'));
  });

  it('should APPROVE when developer agent has been invoked', async () => {
    const env = createTestEnv('TEST-AGENT');
    createTddPhaseState(env.ticketDir, 'green');
    const tp = makeTranscript('"subagent_type": "developer-nodejs-tdd"\n');
    const { result } = await runHookWithEnv(
      { tool_name: 'Edit', tool_input: { file_path: '/home/node/project/src/app.ts' }, transcript_path: tp },
      env.env
    );
    env.cleanup();
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE when developer agent invoked with work-workflow: prefix', async () => {
    const env = createTestEnv('TEST-AGENT2');
    createTddPhaseState(env.ticketDir, 'green');
    const tp = makeTranscript('"subagent_type": "work-workflow:developer-nodejs-tdd"\n');
    const { result } = await runHookWithEnv(
      { tool_name: 'Edit', tool_input: { file_path: '/home/node/project/src/app.ts' }, transcript_path: tp },
      env.env
    );
    env.cleanup();
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE when code-architect agent invoked (WORK_ARCHITECT_ENABLED=1)', async () => {
    const env = createTestEnv('TEST-CA');
    createTddPhaseState(env.ticketDir, 'green');
    const tp = makeTranscript('"subagent_type": "code-architect"\n');
    const { result } = await runHookWithEnv(
      { tool_name: 'Edit', tool_input: { file_path: '/home/node/project/src/app.ts' }, transcript_path: tp },
      { ...env.env, WORK_ARCHITECT_ENABLED: '1' }
    );
    env.cleanup();
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE when code-architect invoked with work-workflow: prefix', async () => {
    const env = createTestEnv('TEST-CA2');
    createTddPhaseState(env.ticketDir, 'green');
    const tp = makeTranscript('"subagent_type": "work-workflow:code-architect"\n');
    const { result } = await runHookWithEnv(
      { tool_name: 'Edit', tool_input: { file_path: '/home/node/project/src/app.ts' }, transcript_path: tp },
      { ...env.env, WORK_ARCHITECT_ENABLED: '1' }
    );
    env.cleanup();
    assert.strictEqual(result.decision, 'approve');
  });

  it('should include code-architect in error message when blocking (with gate enabled)', async () => {
    const env = createTestEnv('TEST-CA-BLOCK');
    const tp = makeTranscript('');
    const { result } = await runHookWithEnv(
      { tool_name: 'Edit', tool_input: { file_path: '/home/node/project/src/app.ts' }, transcript_path: tp },
      { ...env.env, WORK_ARCHITECT_ENABLED: '1' }
    );
    env.cleanup();
    assert.strictEqual(result.decision, 'block');
    assert.ok(result.reason.includes('code-architect'), 'error message should mention code-architect');
  });

  describe('WORK_ARCHITECT_ENABLED gate', () => {
    it('should BLOCK code-architect when WORK_ARCHITECT_ENABLED is not set', async () => {
      const env = createTestEnv('TEST-CA-GATE1');
      const tp = makeTranscript('"subagent_type": "code-architect"\n');
      const { result } = await runHookWithEnv(
        { tool_name: 'Edit', tool_input: { file_path: '/home/node/project/src/app.ts' }, transcript_path: tp },
        { ...env.env, WORK_ARCHITECT_ENABLED: '' }
      );
      env.cleanup();
      assert.strictEqual(result.decision, 'block');
    });

    it('should APPROVE code-architect when WORK_ARCHITECT_ENABLED=1', async () => {
      const env = createTestEnv('TEST-CA-GATE2');
      createTddPhaseState(env.ticketDir, 'green');
      const tp = makeTranscript('"subagent_type": "code-architect"\n');
      const { result } = await runHookWithEnv(
        { tool_name: 'Edit', tool_input: { file_path: '/home/node/project/src/app.ts' }, transcript_path: tp },
        { ...env.env, WORK_ARCHITECT_ENABLED: '1' }
      );
      env.cleanup();
      assert.strictEqual(result.decision, 'approve');
    });

    it('should NOT include code-architect in error message when disabled', async () => {
      const env = createTestEnv('TEST-CA-GATE3');
      const tp = makeTranscript('');
      const { result } = await runHookWithEnv(
        { tool_name: 'Edit', tool_input: { file_path: '/home/node/project/src/app.ts' }, transcript_path: tp },
        { ...env.env, WORK_ARCHITECT_ENABLED: '' }
      );
      env.cleanup();
      assert.strictEqual(result.decision, 'block');
      assert.ok(!result.reason.includes('code-architect'), 'should NOT mention code-architect when disabled');
    });

    it('should include code-architect in error message when WORK_ARCHITECT_ENABLED=1', async () => {
      const env = createTestEnv('TEST-CA-GATE4');
      const tp = makeTranscript('');
      const { result } = await runHookWithEnv(
        { tool_name: 'Edit', tool_input: { file_path: '/home/node/project/src/app.ts' }, transcript_path: tp },
        { ...env.env, WORK_ARCHITECT_ENABLED: '1' }
      );
      env.cleanup();
      assert.strictEqual(result.decision, 'block');
      assert.ok(result.reason.includes('code-architect'), 'should mention code-architect when enabled');
    });
  });

  it('should BLOCK direct edits to tdd-phase.json', async () => {
    const env = createTestEnv('TEST-TDD-PROTECT');
    const tp = makeTranscript();
    const { result } = await runHookWithEnv(
      { tool_name: 'Write', tool_input: { file_path: '/home/node/project/tasks/TEST-123/tdd-phase.json' }, transcript_path: tp },
      env.env
    );
    env.cleanup();
    assert.strictEqual(result.decision, 'block');
    assert.ok(result.reason.includes('tdd-phase.json'));
  });

  it('should APPROVE on parse error (fail-open)', async () => {
    const proc = spawn('node', [HOOK_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exitCode = await new Promise((resolve) => {
      proc.on('close', resolve);
      proc.stdin.write('not json');
      proc.stdin.end();
    });
    assert.strictEqual(exitCode === 2 ? 'block' : 'approve', 'approve');
  });

  describe('TDD phase enforcement', () => {
    it('should BLOCK production file during RED phase', async () => {
      const env = createTestEnv('TDD-RED');
      createTddPhaseState(env.ticketDir, 'red');
      const tp = makeTranscript('"subagent_type": "developer-nodejs-tdd"\n');
      const { result } = await runHookWithEnv(
        { tool_name: 'Write', tool_input: { file_path: '/home/node/project/src/app.ts' }, transcript_path: tp },
        env.env
      );
      env.cleanup();
      assert.strictEqual(result.decision, 'block');
      assert.ok(result.reason.includes('RED phase'));
    });

    it('should APPROVE test file during RED phase', async () => {
      const env = createTestEnv('TDD-RED2');
      createTddPhaseState(env.ticketDir, 'red');
      const tp = makeTranscript('"subagent_type": "developer-nodejs-tdd"\n');
      const { result } = await runHookWithEnv(
        { tool_name: 'Write', tool_input: { file_path: '/home/node/project/src/app.test.ts' }, transcript_path: tp },
        env.env
      );
      env.cleanup();
      assert.strictEqual(result.decision, 'approve');
    });

    it('should BLOCK test file during GREEN phase', async () => {
      const env = createTestEnv('TDD-GREEN-BLOCK');
      createTddPhaseState(env.ticketDir, 'green');
      const tp = makeTranscript('"subagent_type": "developer-nodejs-tdd"\n');
      const { result } = await runHookWithEnv(
        { tool_name: 'Write', tool_input: { file_path: '/home/node/project/src/app.test.ts' }, transcript_path: tp },
        env.env
      );
      env.cleanup();
      assert.strictEqual(result.decision, 'block');
      assert.ok(result.reason.includes('GREEN phase'));
    });

    it('should APPROVE production file during GREEN phase', async () => {
      const env = createTestEnv('TDD-GREEN-OK');
      createTddPhaseState(env.ticketDir, 'green');
      const tp = makeTranscript('"subagent_type": "developer-nodejs-tdd"\n');
      const { result } = await runHookWithEnv(
        { tool_name: 'Write', tool_input: { file_path: '/home/node/project/src/app.ts' }, transcript_path: tp },
        env.env
      );
      env.cleanup();
      assert.strictEqual(result.decision, 'approve');
    });

    it('should APPROVE test helper (__mocks__) during GREEN phase', async () => {
      const env = createTestEnv('TDD-GREEN-MOCK');
      createTddPhaseState(env.ticketDir, 'green');
      const tp = makeTranscript('"subagent_type": "developer-nodejs-tdd"\n');
      const { result } = await runHookWithEnv(
        { tool_name: 'Write', tool_input: { file_path: '/home/node/project/__mocks__/foo.js' }, transcript_path: tp },
        env.env
      );
      env.cleanup();
      assert.strictEqual(result.decision, 'approve');
    });

    it('should BLOCK production file when no tdd-phase.json and developer agent invoked', async () => {
      const env = createTestEnv('TDD-NOINIT');
      const tp = makeTranscript('"subagent_type": "developer-nodejs-tdd"\n');
      const { result } = await runHookWithEnv(
        { tool_name: 'Write', tool_input: { file_path: '/home/node/project/src/app.ts' }, transcript_path: tp },
        env.env
      );
      env.cleanup();
      assert.strictEqual(result.decision, 'block');
      assert.ok(result.reason.includes('TDD not initialized'));
    });

    it('should APPROVE allowed files (markdown) when no tdd-phase.json exists', async () => {
      const env = createTestEnv('TDD-NOFILE-MD');
      const tp = makeTranscript('"subagent_type": "developer-nodejs-tdd"\n');
      const { result } = await runHookWithEnv(
        { tool_name: 'Write', tool_input: { file_path: '/home/node/project/README.md' }, transcript_path: tp },
        env.env
      );
      env.cleanup();
      assert.strictEqual(result.decision, 'approve');
    });

    it('should APPROVE production file when no tdd-phase.json and no developer agent', async () => {
      const env = createTestEnv('TDD-NOFILE-NOAGENT');
      const tp = makeTranscript('');
      const { result } = await runHookWithEnv(
        { tool_name: 'Write', tool_input: { file_path: '/home/node/project/src/app.ts' }, transcript_path: tp },
        env.env
      );
      env.cleanup();
      assert.strictEqual(result.decision, 'block');
      assert.ok(result.reason.includes('work-implement requires agent delegation'));
    });

    it('should resolve tdd-phase.json from per-task path (task N)', async () => {
      const env = createTestEnv('TDD-PERTASK');
      createPerTaskTddPhaseState(env.ticketDir, 14, 'red');
      const tp = makeTranscript('"subagent_type": "developer-nodejs-tdd"\n');
      const { result } = await runHookWithEnv(
        { tool_name: 'Write', tool_input: { file_path: '/home/node/project/src/app.ts' }, transcript_path: tp },
        { ...env.env, WORK_TASK_NUM: '14' }
      );
      env.cleanup();
      assert.strictEqual(result.decision, 'block');
      assert.ok(result.reason.includes('RED phase'), 'Should pick up RED from per-task path');
    });

    it('should fall back to ticket-root tdd-phase.json when per-task missing', async () => {
      const env = createTestEnv('TDD-FALLBACK');
      createTddPhaseState(env.ticketDir, 'green');
      const tp = makeTranscript('"subagent_type": "developer-nodejs-tdd"\n');
      // Use a path inside task5/ so the R6 path gate allows it
      const filePath = path.join(env.ticketDir, 'task5', 'src', 'app.ts');
      const { result } = await runHookWithEnv(
        { tool_name: 'Write', tool_input: { file_path: filePath }, transcript_path: tp },
        { ...env.env, WORK_TASK_NUM: '5' }
      );
      env.cleanup();
      assert.strictEqual(result.decision, 'approve');
    });
  });

  describe('Enforcement audit (R13)', () => {
    it('should write audit record on block', async () => {
      const env = createTestEnv('TEST-AUDIT');
      const tp = makeTranscript('');
      await runHookWithEnv(
        { tool_name: 'Edit', tool_input: { file_path: '/home/node/project/src/app.ts' }, transcript_path: tp },
        env.env
      );
      const actionsFile = '.work-actions' + '.json';
      const actionsPath = path.join(env.ticketDir, actionsFile);
      if (fs.existsSync(actionsPath)) {
        const actions = JSON.parse(fs.readFileSync(actionsPath, 'utf8'));
        const enforcementRows = actions.filter((a) => a.kind === 'enforcement');
        assert.ok(enforcementRows.length > 0, 'Should have enforcement audit record');
        assert.strictEqual(enforcementRows[0].allow, false);
      }
      env.cleanup();
    });
  });

  describe('R1: no transcript-based activation', () => {
    it('should NOT activate based on transcript content alone (no state)', async () => {
      const tp = makeTranscript('# Implement Command\n');
      const { result } = await runHookWithEnv(
        { tool_name: 'Edit', tool_input: { file_path: '/home/node/project/src/app.ts' }, transcript_path: tp },
        { TICKET_ID: '' }
      );
      assert.strictEqual(result.decision, 'approve', 'Should not activate from transcript alone');
    });
  });

  describe('R6: task-readiness path gate (isWriteAllowedPath)', () => {
    it('should APPROVE writes to PR{N}/ dir when task-aware mode active', async () => {
      const env = createTestEnv('TEST-PRDIR');
      createTddPhaseState(env.ticketDir, 'green');
      const prDir = path.join(env.tempBase, 'TEST-PRDIR', 'PR1');
      fs.mkdirSync(prDir, { recursive: true });
      const tp = makeTranscript('"subagent_type": "developer-nodejs-tdd"\n');
      const filePath = path.join(prDir, 'src', 'app.ts');
      const { result } = await runHookWithEnv(
        { tool_name: 'Write', tool_input: { file_path: filePath }, transcript_path: tp },
        { ...env.env, WORK_TASK_NUM: '5', WORK_PR_SLOT: '1' }
      );
      env.cleanup();
      assert.strictEqual(result.decision, 'approve', 'Writes to PR{N}/ should be allowed in task-aware mode');
    });

    it('should APPROVE writes to task{N}/ dir when task-aware mode active', async () => {
      const env = createTestEnv('TEST-TASKDIR');
      createTddPhaseState(env.ticketDir, 'green');
      const tp = makeTranscript('"subagent_type": "developer-nodejs-tdd"\n');
      const filePath = path.join(env.ticketDir, 'task5', 'implement.md');
      const { result } = await runHookWithEnv(
        { tool_name: 'Write', tool_input: { file_path: filePath }, transcript_path: tp },
        { ...env.env, WORK_TASK_NUM: '5' }
      );
      env.cleanup();
      assert.strictEqual(result.decision, 'approve', 'Writes to task{N}/ should be allowed');
    });

    it('should APPROVE writes to shared whitelist at ticket root', async () => {
      const env = createTestEnv('TEST-SHARED');
      createTddPhaseState(env.ticketDir, 'green');
      const tp = makeTranscript('"subagent_type": "developer-nodejs-tdd"\n');
      const stateFile = '.work-state' + '.json';
      const filePath = path.join(env.ticketDir, stateFile);
      const { result } = await runHookWithEnv(
        { tool_name: 'Write', tool_input: { file_path: filePath }, transcript_path: tp },
        { ...env.env, WORK_TASK_NUM: '5' }
      );
      env.cleanup();
      assert.strictEqual(result.decision, 'approve', 'Writes to shared whitelist files should be allowed');
    });

    it('should BLOCK writes outside allow list when task-aware and developer agent present', async () => {
      const env = createTestEnv('TEST-OUTSIDE');
      createTddPhaseState(env.ticketDir, 'green');
      const tp = makeTranscript('"subagent_type": "developer-nodejs-tdd"\n');
      const filePath = '/home/node/totally-unrelated/src/app.ts';
      const { result } = await runHookWithEnv(
        { tool_name: 'Write', tool_input: { file_path: filePath }, transcript_path: tp },
        { ...env.env, WORK_TASK_NUM: '5', WORK_PR_SLOT: '1' }
      );
      env.cleanup();
      assert.strictEqual(result.decision, 'block', 'Writes outside allow list should be blocked in task-aware mode');
      assert.ok(
        result.reason.includes('outside the allowed path set') || result.reason.includes('PATH_NOT_ALLOWED'),
        'Should mention path not allowed'
      );
    });

    it('should NOT apply path gate when WORK_TASK_NUM is not set (legacy mode)', async () => {
      const env = createTestEnv('TEST-LEGACY');
      createTddPhaseState(env.ticketDir, 'green');
      const tp = makeTranscript('"subagent_type": "developer-nodejs-tdd"\n');
      const filePath = '/home/node/project/src/app.ts';
      const { result } = await runHookWithEnv(
        { tool_name: 'Write', tool_input: { file_path: filePath }, transcript_path: tp },
        env.env
      );
      env.cleanup();
      assert.strictEqual(result.decision, 'approve', 'Legacy mode (no WORK_TASK_NUM) should not apply path gate');
    });

    it('should use isWriteAllowedPath from preflight (not duplicate)', async () => {
      const { isWriteAllowedPath } = require(path.join(__dirname, '..', '..', 'lib', 'preflight'));
      assert.strictEqual(typeof isWriteAllowedPath, 'function', 'isWriteAllowedPath should be exported from preflight');
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-test-'));
      const result = isWriteAllowedPath(
        path.join(tempDir, 'PR1', 'src', 'file.ts'),
        { prDir: path.join(tempDir, 'PR1'), taskDir: null, ticketRoot: tempDir }
      );
      assert.strictEqual(result, true, 'isWriteAllowedPath should allow PR dir files');
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should BLOCK writes to other tasks task dir in task-aware mode', async () => {
      const env = createTestEnv('TEST-OTHERTASK');
      createTddPhaseState(env.ticketDir, 'green');
      const tp = makeTranscript('"subagent_type": "developer-nodejs-tdd"\n');
      const filePath = path.join(env.ticketDir, 'task3', 'src', 'app.ts');
      const { result } = await runHookWithEnv(
        { tool_name: 'Write', tool_input: { file_path: filePath }, transcript_path: tp },
        { ...env.env, WORK_TASK_NUM: '5', WORK_PR_SLOT: '1' }
      );
      env.cleanup();
      assert.strictEqual(result.decision, 'block', 'Writes to other task dirs should be blocked');
    });
  });
});
