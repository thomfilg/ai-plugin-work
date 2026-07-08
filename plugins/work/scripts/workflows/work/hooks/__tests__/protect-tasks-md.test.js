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
 * @param {object} input — JSON payload to pipe to stdin
 * @param {object} [envOverrides] — environment variable overrides
 * @param {object} [options] — additional spawn options (e.g. { cwd: '/some/dir' })
 * Returns { code, stderr, stdout }.
 */
function runHook(input, envOverrides = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const spawnOpts = {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...envOverrides },
    };
    if (options.cwd) spawnOpts.cwd = options.cwd;
    const proc = spawn('node', [HOOK_PATH], spawnOpts);
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

  it('should ALLOW Edit to tasks.md when step is tasks_gate (exit 0)', async () => {
    const { code } = await runHookWithState(
      {
        tool_name: 'Edit',
        tool_input: { file_path: '/home/user/project/tasks/GH-99/tasks.md' },
      },
      'GH-99',
      {
        tasks: 'completed',
        tasks_gate: 'in_progress',
        implement: 'pending',
      }
    );
    assert.strictEqual(code, 0, 'Expected exit 0 (allow) during tasks_gate step');
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

  describe('subfolder tasks.md — GH-309', () => {
    it('should ALLOW Edit to subfolder tasks.md when step is implement (exit 0)', async () => {
      const fixture = createStateFixture('GH-309', {
        implement: 'in_progress',
        tasks: 'completed',
        task_review: 'pending',
      });
      try {
        const subfolderPath = path.join(fixture.tasksBase, 'GH-309', 'flaky-tests', 'tasks.md');
        fs.mkdirSync(path.dirname(subfolderPath), { recursive: true });
        const { code } = await runHook(
          {
            tool_name: 'Edit',
            tool_input: { file_path: subfolderPath },
          },
          { TASKS_BASE: fixture.tasksBase, TICKET_ID: 'GH-309' }
        );
        assert.strictEqual(
          code,
          0,
          'Expected exit 0 (allow) for subfolder tasks.md during implement'
        );
      } finally {
        fixture.cleanup();
      }
    });

    it('should ALLOW Write to deeply nested subfolder tasks.md (exit 0)', async () => {
      const fixture = createStateFixture('GH-309', {
        implement: 'in_progress',
        tasks: 'completed',
        task_review: 'pending',
      });
      try {
        const deepPath = path.join(fixture.tasksBase, 'GH-309', 'sub', 'deep', 'tasks.md');
        fs.mkdirSync(path.dirname(deepPath), { recursive: true });
        const { code } = await runHook(
          {
            tool_name: 'Write',
            tool_input: { file_path: deepPath },
          },
          { TASKS_BASE: fixture.tasksBase, TICKET_ID: 'GH-309' }
        );
        assert.strictEqual(
          code,
          0,
          'Expected exit 0 (allow) for deeply nested tasks.md during implement'
        );
      } finally {
        fixture.cleanup();
      }
    });

    it('should ALLOW Bash redirect to subfolder tasks.md (exit 0)', async () => {
      const fixture = createStateFixture('GH-309', {
        implement: 'in_progress',
        tasks: 'completed',
        task_review: 'pending',
      });
      try {
        const subfolderPath = path.join(fixture.tasksBase, 'GH-309', 'flaky-tests', 'tasks.md');
        fs.mkdirSync(path.dirname(subfolderPath), { recursive: true });
        const { code } = await runHook(
          {
            tool_name: 'Bash',
            tool_input: {
              command: `echo "data" >> ${subfolderPath}`,
            },
          },
          { TASKS_BASE: fixture.tasksBase, TICKET_ID: 'GH-309' }
        );
        assert.strictEqual(
          code,
          0,
          'Expected exit 0 (allow) for Bash redirect to subfolder tasks.md'
        );
      } finally {
        fixture.cleanup();
      }
    });

    it('should ALLOW Bash relative-path write to tasks.md from subfolder cwd (exit 0)', async () => {
      const fixture = createStateFixture('GH-309', {
        implement: 'in_progress',
        tasks: 'completed',
        task_review: 'pending',
      });
      try {
        // Create a subfolder inside the ticket dir
        const subfolderDir = path.join(fixture.tasksBase, 'GH-309', 'flaky-tests');
        fs.mkdirSync(subfolderDir, { recursive: true });
        const { code } = await runHook(
          {
            tool_name: 'Bash',
            tool_input: {
              command: 'echo "data" >> tasks.md',
            },
          },
          { TASKS_BASE: fixture.tasksBase, TICKET_ID: 'GH-309' },
          { cwd: subfolderDir }
        );
        assert.strictEqual(
          code,
          0,
          'Expected exit 0 (allow) for relative tasks.md from subfolder cwd'
        );
      } finally {
        fixture.cleanup();
      }
    });

    it('should BLOCK Bash command that references subfolder AND root-level tasks.md (exit 2)', async () => {
      const fixture = createStateFixture('GH-309', {
        implement: 'in_progress',
        tasks: 'completed',
        task_review: 'pending',
      });
      try {
        const subfolderPath = path.join(fixture.tasksBase, 'GH-309', 'flaky-tests', 'tasks.md');
        const rootPath = path.join(fixture.tasksBase, 'GH-309', 'tasks.md');
        fs.mkdirSync(path.dirname(subfolderPath), { recursive: true });
        const { code, stderr } = await runHook(
          {
            tool_name: 'Bash',
            tool_input: {
              command: `cat ${subfolderPath} >> ${rootPath}`,
            },
          },
          { TASKS_BASE: fixture.tasksBase, TICKET_ID: 'GH-309' }
        );
        assert.strictEqual(
          code,
          2,
          `Expected exit 2 (block) when Bash references both subfolder and root tasks.md, got ${code}. stderr: ${stderr}`
        );
      } finally {
        fixture.cleanup();
      }
    });

    it('should still BLOCK Edit to root-level tasks.md when step is implement (exit 2) — regression', async () => {
      const fixture = createStateFixture('GH-309', {
        implement: 'in_progress',
        tasks: 'completed',
        task_review: 'pending',
      });
      try {
        const rootPath = path.join(fixture.tasksBase, 'GH-309', 'tasks.md');
        const { code, stderr } = await runHook(
          {
            tool_name: 'Edit',
            tool_input: { file_path: rootPath },
          },
          { TASKS_BASE: fixture.tasksBase, TICKET_ID: 'GH-309' }
        );
        assert.strictEqual(
          code,
          2,
          `Expected exit 2 (block) for root-level tasks.md, got ${code}. stderr: ${stderr}`
        );
        assert.ok(stderr.length > 0, 'Expected stderr message explaining block');
      } finally {
        fixture.cleanup();
      }
    });
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

// ── Coverage-check deadlock fixes (ECHO-5139/5145/5218/5320/5350/5818/5821) ──

describe('protect-tasks-md — allowlist honesty (ECHO-5145)', () => {
  it('should ALLOW Edit to tasks.md when step is complete (exit 0)', async () => {
    const { code, stderr } = await runHookWithState(
      {
        tool_name: 'Edit',
        tool_input: { file_path: '/home/user/project/tasks/GH-99/tasks.md' },
      },
      'GH-99',
      { tasks: 'completed', implement: 'completed', check: 'completed', complete: 'in_progress' }
    );
    assert.strictEqual(
      code,
      0,
      `Expected exit 0 (allow) during complete step (documented allowlist), got ${code}. stderr: ${stderr}`
    );
  });
});

describe('protect-tasks-md — one-shot completion write token (ECHO-5818)', () => {
  const TOKEN_BASENAME = 'protect-tasks-md.js';

  function mkTokenDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ptm-token-'));
  }

  function writeToken(tokenDir, ticketId, overrides = {}) {
    const tp = path.join(tokenDir, `${TOKEN_BASENAME}.${ticketId}`);
    fs.writeFileSync(tp, JSON.stringify({ ticket: ticketId, timestamp: Date.now(), ...overrides }));
    return tp;
  }

  it('should ALLOW ONE tasks.md Edit during check when a fresh token exists — and consume it', async () => {
    const tokenDir = mkTokenDir();
    const tp = writeToken(tokenDir, 'GH-99');
    try {
      const { code, stderr } = await runHookWithState(
        {
          tool_name: 'Edit',
          tool_input: { file_path: '/home/user/project/tasks/GH-99/tasks.md' },
        },
        'GH-99',
        { implement: 'completed', tasks: 'completed', check: 'in_progress' },
        { CLAUDE_WRITE_TOKEN_DIR: tokenDir }
      );
      assert.strictEqual(
        code,
        0,
        `Expected exit 0 (token honored), got ${code}. stderr: ${stderr}`
      );
      assert.strictEqual(fs.existsSync(tp), false, 'token must be consumed (deleted) after use');
    } finally {
      fs.rmSync(tokenDir, { recursive: true, force: true });
    }
  });

  it('should BLOCK the SECOND tasks.md Edit after the token is consumed (one-shot)', async () => {
    const tokenDir = mkTokenDir();
    writeToken(tokenDir, 'GH-99');
    try {
      const first = await runHookWithState(
        { tool_name: 'Edit', tool_input: { file_path: '/home/user/project/tasks/GH-99/tasks.md' } },
        'GH-99',
        { implement: 'completed', tasks: 'completed', check: 'in_progress' },
        { CLAUDE_WRITE_TOKEN_DIR: tokenDir }
      );
      assert.strictEqual(first.code, 0, 'first write should be allowed');
      const second = await runHookWithState(
        { tool_name: 'Edit', tool_input: { file_path: '/home/user/project/tasks/GH-99/tasks.md' } },
        'GH-99',
        { implement: 'completed', tasks: 'completed', check: 'in_progress' },
        { CLAUDE_WRITE_TOKEN_DIR: tokenDir }
      );
      assert.strictEqual(second.code, 2, 'second write must be blocked (token was one-shot)');
    } finally {
      fs.rmSync(tokenDir, { recursive: true, force: true });
    }
  });

  it('should BLOCK when the token is expired — and still consume it', async () => {
    const tokenDir = mkTokenDir();
    const tp = writeToken(tokenDir, 'GH-99', { timestamp: Date.now() - 16 * 60 * 1000 });
    try {
      const { code } = await runHookWithState(
        { tool_name: 'Edit', tool_input: { file_path: '/home/user/project/tasks/GH-99/tasks.md' } },
        'GH-99',
        { implement: 'completed', tasks: 'completed', check: 'in_progress' },
        { CLAUDE_WRITE_TOKEN_DIR: tokenDir }
      );
      assert.strictEqual(code, 2, 'expired token must not be honored');
      assert.strictEqual(fs.existsSync(tp), false, 'expired token must still be consumed');
    } finally {
      fs.rmSync(tokenDir, { recursive: true, force: true });
    }
  });

  it('should BLOCK when the token was minted for a different ticket', async () => {
    const tokenDir = mkTokenDir();
    // Keyed path for GH-99 but token payload claims GH-777
    const tp = path.join(tokenDir, `${TOKEN_BASENAME}.GH-99`);
    fs.writeFileSync(tp, JSON.stringify({ ticket: 'GH-777', timestamp: Date.now() }));
    try {
      const { code } = await runHookWithState(
        { tool_name: 'Edit', tool_input: { file_path: '/home/user/project/tasks/GH-99/tasks.md' } },
        'GH-99',
        { implement: 'completed', tasks: 'completed', check: 'in_progress' },
        { CLAUDE_WRITE_TOKEN_DIR: tokenDir }
      );
      assert.strictEqual(code, 2, 'cross-ticket token must not be honored');
    } finally {
      fs.rmSync(tokenDir, { recursive: true, force: true });
    }
  });

  it('block message should mention the completion-next.js token path', async () => {
    const { code, stderr } = await runHookWithState(
      { tool_name: 'Edit', tool_input: { file_path: '/home/user/project/tasks/GH-99/tasks.md' } },
      'GH-99',
      { implement: 'completed', tasks: 'completed', check: 'in_progress' }
    );
    assert.strictEqual(code, 2);
    assert.match(
      stderr,
      /completion-next\.js/,
      'block message must point at the legitimate repair path'
    );
  });

  it('should ALLOW Bash write to tasks.md during check when a fresh token exists', async () => {
    const tokenDir = mkTokenDir();
    const fixture = createStateFixture('GH-99', {
      implement: 'completed',
      tasks: 'completed',
      check: 'in_progress',
    });
    writeToken(tokenDir, 'GH-99');
    try {
      const tasksFilePath = path.join(fixture.tasksBase, 'GH-99', 'tasks.md');
      const { code, stderr } = await runHook(
        {
          tool_name: 'Bash',
          tool_input: { command: `echo "| R1 | x | DELIVERED | src/a.js:1 |" >> ${tasksFilePath}` },
        },
        { TASKS_BASE: fixture.tasksBase, TICKET_ID: 'GH-99', CLAUDE_WRITE_TOKEN_DIR: tokenDir }
      );
      assert.strictEqual(
        code,
        0,
        `Expected exit 0 (token honored for Bash), got ${code}. stderr: ${stderr}`
      );
    } finally {
      fixture.cleanup();
      fs.rmSync(tokenDir, { recursive: true, force: true });
    }
  });
});

describe('protect-tasks-md — basename boundary matching (ECHO-5538 secondary)', () => {
  it('should ALLOW Bash write to subtasks.md (substring must not match)', async () => {
    const fixture = createStateFixture('GH-99', {
      implement: 'in_progress',
      tasks: 'completed',
    });
    try {
      const target = path.join(fixture.tasksBase, 'GH-99', 'subtasks.md');
      const { code, stderr } = await runHook(
        { tool_name: 'Bash', tool_input: { command: `echo "notes" >> ${target}` } },
        { TASKS_BASE: fixture.tasksBase, TICKET_ID: 'GH-99' }
      );
      assert.strictEqual(
        code,
        0,
        `subtasks.md must not trip the tasks.md rule, got ${code}. stderr: ${stderr}`
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('should ALLOW Bash write to tasks.md.bak (suffixed name must not match)', async () => {
    const fixture = createStateFixture('GH-99', {
      implement: 'in_progress',
      tasks: 'completed',
    });
    try {
      const target = path.join(fixture.tasksBase, 'GH-99', 'tasks.md.bak');
      const { code, stderr } = await runHook(
        { tool_name: 'Bash', tool_input: { command: `echo "backup" >> ${target}` } },
        { TASKS_BASE: fixture.tasksBase, TICKET_ID: 'GH-99' }
      );
      assert.strictEqual(
        code,
        0,
        `tasks.md.bak must not trip the tasks.md rule, got ${code}. stderr: ${stderr}`
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('should ALLOW Bash write to tasks.mdx (extension superset must not match)', async () => {
    const fixture = createStateFixture('GH-99', {
      implement: 'in_progress',
      tasks: 'completed',
    });
    try {
      const target = path.join(fixture.tasksBase, 'GH-99', 'tasks.mdx');
      const { code, stderr } = await runHook(
        { tool_name: 'Bash', tool_input: { command: `echo "mdx" >> ${target}` } },
        { TASKS_BASE: fixture.tasksBase, TICKET_ID: 'GH-99' }
      );
      assert.strictEqual(
        code,
        0,
        `tasks.mdx must not trip the tasks.md rule, got ${code}. stderr: ${stderr}`
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('should still BLOCK Bash redirect to the real tasks.md — regression', async () => {
    const fixture = createStateFixture('GH-99', {
      implement: 'in_progress',
      tasks: 'completed',
    });
    try {
      const target = path.join(fixture.tasksBase, 'GH-99', 'tasks.md');
      const { code } = await runHook(
        { tool_name: 'Bash', tool_input: { command: `echo "sneaky" >> ${target}` } },
        { TASKS_BASE: fixture.tasksBase, TICKET_ID: 'GH-99' }
      );
      assert.strictEqual(code, 2, 'real tasks.md write must still be blocked');
    } finally {
      fixture.cleanup();
    }
  });
});
