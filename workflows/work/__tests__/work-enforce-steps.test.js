/**
 * Tests for work-enforce-steps.js hook
 * Uses TOOL_INPUT and CLAUDE_HOOK_TYPE env vars, not stdin.
 *
 * Run with: node --test hooks/__tests__/work-enforce-steps.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'work-enforce-steps.js');

// Isolate all filesystem side effects to a temp dir so tests never touch the
// real tasks/ directory (which would leak orphaned ticket dirs on assertion
// failure). Use a stable project key so the hook's ticket-extraction regex
// resolves to the same dir the test inspects.
const TEMP_TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'work-enforce-steps-test-'));
const TICKET_PROJECT_KEY = 'TESTGH';

let ticketCounter = 0;
function nextTicketId() {
  ticketCounter += 1;
  return `${TICKET_PROJECT_KEY}-${process.pid}${ticketCounter}`;
}

// config.js reads TASKS_BASE/TICKET_PROJECT_KEY at require time, so we must
// set them before requiring it.
process.env.TASKS_BASE = TEMP_TASKS_BASE;
process.env.TICKET_PROJECT_KEY = TICKET_PROJECT_KEY;
const config = require('../../lib/config');

function runHook(toolInput, hookType = 'PostToolUse') {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TASKS_BASE: TEMP_TASKS_BASE,
        TICKET_PROJECT_KEY,
        TOOL_INPUT: JSON.stringify(toolInput),
        CLAUDE_HOOK_TYPE: hookType,
      },
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
      resolve({ code, stdout, stderr });
    });
    proc.on('error', reject);
    proc.stdin.end();
  });
}

describe('work-enforce-steps hook', () => {
  after(() => {
    try { fs.rmSync(TEMP_TASKS_BASE, { recursive: true, force: true }); } catch {}
  });

  it('should exit 0 for non-work/work-pr skills', async () => {
    const { code } = await runHook({ skill: 'work-implement', args: nextTicketId() });
    assert.strictEqual(code, 0);
  });

  it('should exit 0 when no ticket ID in args', async () => {
    const { code } = await runHook({ skill: 'work', args: '' });
    assert.strictEqual(code, 0);
  });

  it('should create session file on PreToolUse for /work', async () => {
    const ticketId = nextTicketId();
    const { code } = await runHook(
      { skill: 'work', args: ticketId },
      'PreToolUse'
    );
    assert.strictEqual(code, 0);

    // Check session file was created
    const tasksDir = config.tasksDir(ticketId);
    const sessionFile = path.join(tasksDir, '.work-session');
    assert.ok(fs.existsSync(sessionFile));
  });

  it('should mark work-pr as executed on PreToolUse', async () => {
    const ticketId = nextTicketId();
    const tasksDir = config.tasksDir(ticketId);
    fs.mkdirSync(tasksDir, { recursive: true });

    const { code } = await runHook({ skill: 'work-pr', args: ticketId }, 'PreToolUse');
    assert.strictEqual(code, 0);

    const prFile = path.join(tasksDir, '.work-pr-executed');
    assert.ok(fs.existsSync(prFile));
  });
});
