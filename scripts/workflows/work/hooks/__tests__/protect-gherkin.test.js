/**
 * Tests for protect-gherkin.js hook (PreToolUse)
 *
 * Blocks edits to gherkin.feature outside the `spec` step.
 * GH-350 Task 6: Implementation hook tests.
 *
 * Run with: node --test workflows/work/hooks/__tests__/protect-gherkin.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOOK_PATH = path.join(__dirname, '..', 'protect-gherkin.js');

/**
 * Create a temporary TASKS_BASE directory with a `.work-state.json` for
 * the given ticket. Returns { tasksBase, ticketDir, cleanup }.
 */
function createStateFixture(ticketId, stepStatus = {}) {
  const tasksBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-test-'));
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

describe('protect-gherkin hook', () => {
  it('should BLOCK Edit to gherkin.feature when step is implement (exit 2)', async () => {
    const { code, stderr } = await runHookWithState(
      {
        tool_name: 'Edit',
        tool_input: { file_path: '/home/user/project/tasks/GH-99/gherkin.feature' },
      },
      'GH-99',
      { implement: 'in_progress', spec: 'completed' }
    );
    assert.strictEqual(code, 2, `Expected exit 2 (block), got ${code}. stderr: ${stderr}`);
    assert.ok(stderr.length > 0, 'Expected stderr message explaining block');
  });

  it('should ALLOW Edit to gherkin.feature when step is spec (exit 0)', async () => {
    const { code } = await runHookWithState(
      {
        tool_name: 'Edit',
        tool_input: { file_path: '/home/user/project/tasks/GH-99/gherkin.feature' },
      },
      'GH-99',
      { spec: 'in_progress', implement: 'pending' }
    );
    assert.strictEqual(code, 0, `Expected exit 0 (allow) during spec step, got ${code}`);
  });

  it('should exit 0 when no workflow is active (fail-open)', async () => {
    const noopBase = path.join(os.tmpdir(), 'pg-noop-' + Date.now());
    const { code } = await runHook(
      {
        tool_name: 'Edit',
        tool_input: { file_path: '/home/user/project/tasks/GH-99/gherkin.feature' },
      },
      { TASKS_BASE: noopBase, TICKET_ID: 'GH-NOOP' }
    );
    assert.strictEqual(code, 0, 'Expected exit 0 (fail-open) when no workflow active');
  });
});
