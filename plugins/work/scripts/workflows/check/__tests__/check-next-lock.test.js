/**
 * Lock-exclusion test for check-next.js (GH-611).
 *
 * The PostToolUse auto-advance hook and a manual invocation must never
 * interleave step execution: while one check-next.js holds the per-ticket
 * lock, a second invocation must back off with action 'locked' (which has no
 * banner in the hook → silent no-op) instead of running steps.
 *
 * node:test + node:assert/strict; temp TASKS_BASE via fs.mkdtempSync.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scriptPath = path.join(__dirname, '..', 'check-next.js');

let TASKS_BASE;

beforeEach(() => {
  TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'check-next-lock-test-'));
});
afterEach(() => {
  fs.rmSync(TASKS_BASE, { recursive: true, force: true });
});

function runCheckNext(ticket) {
  const stdout = execFileSync(process.execPath, [scriptPath, ticket], {
    encoding: 'utf8',
    timeout: 20000,
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: TASKS_BASE,
    env: { ...process.env, TASKS_BASE, WORKTREES_BASE: path.dirname(TASKS_BASE) },
  });
  return JSON.parse(stdout);
}

describe('check-next.js — per-ticket lock', () => {
  it('backs off with action "locked" while a live invocation holds the lock', () => {
    const ticketDir = path.join(TASKS_BASE, 'GH-611');
    fs.mkdirSync(ticketDir, { recursive: true });
    // Simulate a concurrent live invocation: fresh lock owned by a live pid
    fs.writeFileSync(path.join(ticketDir, '.check-next.lock'), String(process.pid));

    const out = runCheckNext('GH-611');
    assert.equal(out.type, 'check_instruction');
    assert.equal(out.action, 'locked');
    assert.match(out.reason, /already running/i);
    // The loser must not have executed steps: no state file was created
    assert.equal(fs.existsSync(path.join(ticketDir, '.check-state.json')), false);
    // And it must not have stolen the lock
    assert.equal(fs.existsSync(path.join(ticketDir, '.check-next.lock')), true);
  });
});
