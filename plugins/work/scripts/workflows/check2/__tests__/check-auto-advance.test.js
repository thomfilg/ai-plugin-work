/**
 * Tests for check-auto-advance.js — PostToolUse hook for /check2.
 *
 * Regression guard: with multiple agents sharing one TASKS_BASE, a hook firing in
 * session/worktree B must NEVER advance a /check2 workflow owned by A.
 *
 * node:test + node:assert/strict; temp TASKS_BASE via fs.mkdtempSync.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hookPath = path.join(__dirname, '..', 'hooks', 'check-auto-advance.js');
const MARKER = '.check2-orchestrator.pid';
const BANNER = 'CHECK2'; // printed only when the hook actually advances

let TASKS_BASE;

function runHook(hookData, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [hookPath], {
      input: JSON.stringify(hookData),
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', ...env },
    });
    return { exitCode: 0, stdout };
  } catch (err) {
    return { exitCode: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

function writeMarker(ticket, fields) {
  const dir = path.join(TASKS_BASE, ticket);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, MARKER),
    JSON.stringify({ ticket, startedAt: new Date().toISOString(), workflow: '/check2', ...fields })
  );
}

describe('check-auto-advance hook — isolation', () => {
  beforeEach(() => {
    TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'check-aa-test-'));
  });
  afterEach(() => {
    fs.rmSync(TASKS_BASE, { recursive: true, force: true });
  });

  it('exits 0 silently when no marker exists', () => {
    const r = runHook(
      { tool_name: 'Task', transcript_path: '/tmp/t.jsonl', session_id: 'sess-X' },
      { TASKS_BASE, WORKTREES_BASE: path.dirname(TASKS_BASE), CLAUDE_CODE_SESSION_ID: 'sess-X' }
    );
    assert.equal(r.exitCode, 0);
    assert.ok(!r.stdout.includes(BANNER));
  });

  it('does NOT advance a marker owned by a foreign session', () => {
    writeMarker('AAA-1', { sessionId: 'owner-A', worktreeRoot: '/wt/a' });
    const r = runHook(
      { tool_name: 'Task', transcript_path: '/tmp/t.jsonl', session_id: 'other-B' },
      { TASKS_BASE, WORKTREES_BASE: path.dirname(TASKS_BASE), CLAUDE_CODE_SESSION_ID: 'other-B' }
    );
    assert.equal(r.exitCode, 0);
    assert.ok(!r.stdout.includes(BANNER), 'must not advance a foreign-owned check');
  });

  it('does NOT advance a marker owned by a foreign worktree', () => {
    writeMarker('AAA-1', { worktreeRoot: '/some/other/worktree' });
    const r = runHook(
      { tool_name: 'Task', transcript_path: '/tmp/t.jsonl' },
      { TASKS_BASE, WORKTREES_BASE: path.dirname(TASKS_BASE) }
    );
    assert.equal(r.exitCode, 0);
    assert.ok(!r.stdout.includes(BANNER), 'must not advance a check owned by another worktree');
  });

  it('exits 0 without advancing inside a sub-agent transcript', () => {
    writeMarker('AAA-1', {});
    const r = runHook(
      { tool_name: 'Task', transcript_path: '/x/subagents/y.jsonl', session_id: 'sess-X' },
      { TASKS_BASE, WORKTREES_BASE: path.dirname(TASKS_BASE), CLAUDE_CODE_SESSION_ID: 'sess-X' }
    );
    assert.equal(r.exitCode, 0);
    assert.ok(!r.stdout.includes(BANNER), 'must not advance from within a sub-agent');
  });
});
