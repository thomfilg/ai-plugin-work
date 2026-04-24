/**
 * Tests for protect-tasks-md.js hook (PreToolUse)
 *
 * Blocks edits to tasks.md outside the `tasks` and `task_review` steps.
 *
 * Run with: node --test workflows/work/hooks/__tests__/protect-tasks-md.test.js
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOOK_PATH = path.join(__dirname, '..', 'protect-tasks-md.js');

/**
 * Create a temporary TASKS_BASE directory with a `.work-state.json` for
 * the given ticket. Returns { tasksBase, ticketDir, cleanup }.
 */
function createStateFixture(ticketId, stepStatus = {}) {
  const tasksBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ptm-test-'));
  const ticketDir = path.join(tasksBase, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });

  const defaultStepStatus = {
    ticket: 'completed',
    bootstrap: 'completed',
    brief: 'completed',
    spec: 'completed',
    tasks: 'completed',
    implement: 'in_progress',
    commit: 'pending',
    task_review: 'pending',
    check: 'pending',
    pr: 'pending',
  };

  const state = {
    ticketId,
    status: 'in_progress',
    stepStatus: { ...defaultStepStatus, ...stepStatus },
    startTime: new Date().toISOString(),
    lastUpdate: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(ticketDir, '.work-state.json'), JSON.stringify(state, null, 2));

  return {
    tasksBase,
    ticketDir,
    cleanup: () => fs.rmSync(tasksBase, { recursive: true, force: true }),
  };
}

/**
 * Run the hook with given stdin input and env overrides.
 * Returns { code, stderr, stdout }.
 */
function runHook(input, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...envOverrides },
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
      resolve({ code, stderr, stdout });
    });
    proc.on('error', reject);
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
}

/**
 * Run hook with a state fixture. Cleans up temp dir after.
 */
function runHookWithState(input, ticketId, stepStatus = {}, envExtras = {}) {
  const fixture = createStateFixture(ticketId, stepStatus);
  const env = {
    TASKS_BASE: fixture.tasksBase,
    TICKET_ID: ticketId,
    ...envExtras,
  };
  return runHook(input, env).finally(() => fixture.cleanup());
}

describe('protect-tasks-md hook', () => {
  it('should BLOCK Edit to tasks.md when step is implement (exit 2)', async () => {
    const { code, stderr } = await runHookWithState(
      {
        tool_name: 'Edit',
        tool_input: { file_path: '/home/user/project/tasks/GH-99/tasks.md' },
      },
      'GH-99',
      { implement: 'in_progress', tasks: 'completed', task_review: 'pending' }
    );
    assert.strictEqual(code, 2, `Expected exit 2 (block), got ${code}. stderr: ${stderr}`);
    assert.ok(stderr.length > 0, 'Expected stderr message explaining block'); // GH-258: verified with GitHub ID format tests
  });

  it('should ALLOW Edit to tasks.md when step is tasks (exit 0)', async () => {
    const { code } = await runHookWithState(
      {
        tool_name: 'Edit',
        tool_input: { file_path: '/home/user/project/tasks/GH-99/tasks.md' },
      },
      'GH-99',
      { tasks: 'in_progress', implement: 'pending', task_review: 'pending' }
    );
    assert.strictEqual(code, 0, 'Expected exit 0 (allow) during tasks step');
  });

  it('should ALLOW Edit to tasks.md when step is task_review (exit 0)', async () => {
    const { code } = await runHookWithState(
      {
        tool_name: 'Edit',
        tool_input: { file_path: '/home/user/project/tasks/GH-99/tasks.md' },
      },
      'GH-99',
      {
        tasks: 'completed',
        implement: 'completed',
        task_review: 'in_progress',
      }
    );
    assert.strictEqual(code, 0, 'Expected exit 0 (allow) during task_review step');
  });

  it('should ALLOW Edit to non-tasks.md files (exit 0)', async () => {
    const { code } = await runHookWithState(
      {
        tool_name: 'Edit',
        tool_input: { file_path: '/home/user/project/src/index.js' },
      },
      'GH-99',
      { implement: 'in_progress', tasks: 'completed', task_review: 'pending' }
    );
    assert.strictEqual(code, 0, 'Expected exit 0 (allow) for non-tasks.md file');
  });

  it('should exit 0 when no workflow is active (fail-open)', async () => {
    // Point TASKS_BASE to a nonexistent dir so no state file can be found
    const noopBase = path.join(os.tmpdir(), 'ptm-noop-' + Date.now());
    const { code } = await runHook(
      {
        tool_name: 'Edit',
        tool_input: { file_path: '/home/user/project/tasks/GH-99/tasks.md' },
      },
      { TASKS_BASE: noopBase, TICKET_ID: 'GH-NOOP' }
    );
    assert.strictEqual(code, 0, 'Expected exit 0 (fail-open) when no workflow active');
  });

  it('should BLOCK Write to tasks.md when step is implement', async () => {
    const { code } = await runHookWithState(
      {
        tool_name: 'Write',
        tool_input: { file_path: '/home/user/project/tasks/GH-99/tasks.md' },
      },
      'GH-99',
      { implement: 'in_progress', tasks: 'completed', task_review: 'pending' }
    );
    assert.strictEqual(code, 2, 'Expected exit 2 (block) for Write to tasks.md');
  });

  it('should BLOCK MultiEdit to tasks.md when step is implement', async () => {
    const { code } = await runHookWithState(
      {
        tool_name: 'MultiEdit',
        tool_input: { file_path: '/home/user/project/tasks/GH-99/tasks.md' },
      },
      'GH-99',
      { implement: 'in_progress', tasks: 'completed', task_review: 'pending' }
    );
    assert.strictEqual(code, 2, 'Expected exit 2 (block) for MultiEdit to tasks.md');
  });

  it('should ALLOW non-blocked tools like Read (exit 0)', async () => {
    const { code } = await runHookWithState(
      {
        tool_name: 'Read',
        tool_input: { file_path: '/some/path/tasks.md' },
      },
      'GH-99',
      { implement: 'in_progress', tasks: 'completed', task_review: 'pending' }
    );
    assert.strictEqual(code, 0, 'Expected exit 0 (allow) for non-blocked tool');
  });

  it('should BLOCK Edit to tasks.md for GitHub-style ticket ID GH-258 (exit 2)', async () => {
    const { code, stderr } = await runHookWithState(
      {
        tool_name: 'Edit',
        tool_input: { file_path: '/home/user/project/tasks/GH-258/tasks.md' },
      },
      'GH-258',
      { implement: 'in_progress', tasks: 'completed', task_review: 'pending' }
    );
    assert.strictEqual(
      code,
      2,
      `Expected exit 2 (block) for GH-258, got ${code}. stderr: ${stderr}`
    );
    assert.ok(stderr.length > 0, 'Expected stderr message explaining block');
  });

  it('should ALLOW Edit to tasks.md for GH-258 when step is tasks (exit 0)', async () => {
    const { code } = await runHookWithState(
      {
        tool_name: 'Edit',
        tool_input: { file_path: '/home/user/project/tasks/GH-258/tasks.md' },
      },
      'GH-258',
      { tasks: 'in_progress', implement: 'pending', task_review: 'pending' }
    );
    assert.strictEqual(code, 0, 'Expected exit 0 (allow) for GH-258 during tasks step');
  });

  it('should BLOCK Bash redirect to tasks.md when step is implement', async () => {
    const fixture = createStateFixture('GH-99', {
      implement: 'in_progress',
      tasks: 'completed',
      task_review: 'pending',
    });
    try {
      const tasksFilePath = path.join(fixture.tasksBase, 'GH-99', 'tasks.md');
      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: {
            command: `echo "modified" >> ${tasksFilePath}`,
          },
        },
        { TASKS_BASE: fixture.tasksBase, TICKET_ID: 'GH-99' }
      );
      assert.strictEqual(
        code,
        2,
        `Expected exit 2 (block) for Bash redirect to tasks.md, got ${code}. stderr: ${stderr}`
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('should normalize #N ticket IDs to GH-N for path matching', async () => {
    // Create fixture with GH-99 (filesystem format)
    const fixture = createStateFixture('GH-99', {
      implement: 'in_progress',
      tasks: 'completed',
      task_review: 'pending',
    });
    try {
      const { code, stderr } = await runHook(
        {
          tool_name: 'Edit',
          tool_input: { file_path: path.join(fixture.tasksBase, 'GH-99', 'tasks.md') },
        },
        {
          TASKS_BASE: fixture.tasksBase,
          TICKET_ID: '#99', // Raw format requiring normalization
          TICKET_PROVIDER: 'github', // Required for #N → GH-N normalization
        }
      );
      assert.strictEqual(
        code,
        2,
        `Should block even when TICKET_ID needs normalization (#99 → GH-99), got ${code}. stderr: ${stderr}`
      );
    } finally {
      fixture.cleanup();
    }
  });
});
