/**
 * Tests for work-auto-advance.js — PostToolUse hook for /work.
 *
 * Tests the hook's guards (marker file, age check) and output behavior.
 * Uses child_process.spawn with stdin to simulate hook invocation.
 *
 * Uses node:test + node:assert/strict.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hookPath = path.join(__dirname, '..', 'hooks', 'work-auto-advance.js');

function runHook(hookData, env = {}) {
  const input = JSON.stringify(hookData);
  try {
    const result = execFileSync(process.execPath, [hookPath], {
      input,
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    return { exitCode: 0, stdout: result };
  } catch (err) {
    return { exitCode: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

describe('work-auto-advance hook', () => {
  it('exits 0 silently when no stdin', () => {
    try {
      const result = execFileSync(process.execPath, [hookPath], {
        input: '',
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      assert.equal(result.trim(), '');
    } catch (err) {
      assert.equal(err.status, 0);
    }
  });

  it('exits 0 when no matching marker file exists', () => {
    const result = runHook({
      tool_name: 'Task',
      tool_input: { description: 'brief generate brief' },
      session_id: 'test-session',
    });
    assert.equal(result.exitCode, 0);
  });

  it('exits 0 when invalid JSON stdin', () => {
    try {
      const result = execFileSync(process.execPath, [hookPath], {
        input: 'not-json',
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      assert.equal(result.trim(), '');
    } catch (err) {
      assert.equal(err.status, 0);
    }
  });
});

// Regression: a hook firing in session B must NOT advance a /work marker owned by
// session A (the cross-wiring that force-ran another ticket's workflow).
describe('work-auto-advance hook — session scoping', () => {
  let TASKS_BASE;
  beforeEach(() => {
    TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'work-aa-test-'));
  });
  afterEach(() => {
    fs.rmSync(TASKS_BASE, { recursive: true, force: true });
  });

  function writeMarker(ticket, fields) {
    const dir = path.join(TASKS_BASE, ticket);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.work.pid'),
      JSON.stringify({ ticket, startedAt: new Date().toISOString(), ...fields })
    );
  }

  it('does NOT advance a marker owned by a foreign session', () => {
    writeMarker('AAA-1', { sessionId: 'owner-A', worktreeRoot: '/wt/a' });

    // Fire as a different session — the foreign marker must be skipped, so the
    // hook produces no NEXT STEP output and exits 0 without invoking work-next.
    const result = runHook(
      { tool_name: 'Task', transcript_path: '/tmp/t.jsonl', session_id: 'other-B' },
      { TASKS_BASE, CLAUDE_CODE_SESSION_ID: 'other-B' }
    );
    assert.equal(result.exitCode, 0);
    assert.ok(!result.stdout.includes('WORK2'), 'must not advance a foreign-owned workflow');
  });
});
