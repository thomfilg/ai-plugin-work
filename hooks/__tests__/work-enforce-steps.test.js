/**
 * Tests for work-enforce-steps.js hook
 * Uses TOOL_INPUT and CLAUDE_HOOK_TYPE env vars, not stdin.
 *
 * Run with: node --test hooks/__tests__/work-enforce-steps.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('../../lib/config');

const HOOK_PATH = path.join(__dirname, '..', 'work-enforce-steps.js');

function runHook(toolInput, hookType = 'PostToolUse') {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TOOL_INPUT: JSON.stringify(toolInput),
        CLAUDE_HOOK_TYPE: hookType
      }
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
    proc.on('error', reject);
    proc.stdin.end();
  });
}

describe('work-enforce-steps hook', () => {
  it('should exit 0 for non-work/work-pr skills', async () => {
    const { code } = await runHook({ skill: 'work-implement', args: 'PROJ-123' });
    assert.strictEqual(code, 0);
  });

  it('should exit 0 when no ticket ID in args', async () => {
    const { code } = await runHook({ skill: 'work', args: '' });
    assert.strictEqual(code, 0);
  });

  it('should create session file on PreToolUse for /work', async () => {
    const ticketId = `PROJ-${Date.now()}`;
    const { code } = await runHook(
      { skill: 'work', args: ticketId },
      'PreToolUse'
    );
    assert.strictEqual(code, 0);

    // Check session file was created
    const tasksDir = config.tasksDir(ticketId);
    const sessionFile = path.join(tasksDir, '.work-session');
    assert.ok(fs.existsSync(sessionFile));

    // Cleanup
    fs.rmSync(tasksDir, { recursive: true, force: true });
  });

  it('should mark work-pr as executed on PreToolUse', async () => {
    const ticketId = `PROJ-${Date.now()}`;
    const tasksDir = config.tasksDir(ticketId);
    fs.mkdirSync(tasksDir, { recursive: true });

    const { code } = await runHook(
      { skill: 'work-pr', args: ticketId },
      'PreToolUse'
    );
    assert.strictEqual(code, 0);

    const prFile = path.join(tasksDir, '.work-pr-executed');
    assert.ok(fs.existsSync(prFile));

    // Cleanup
    fs.rmSync(tasksDir, { recursive: true, force: true });
  });
});
