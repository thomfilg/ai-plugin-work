'use strict';

/**
 * hook-handlers.test.js — Stop-hook cancelled-status allowance (GH-339 Task 5).
 *
 * Spawns the session-guard Stop hook (child_process pattern, per CLAUDE.md) with
 * an owned active session and a `.work-state.json` fixture. Asserts:
 *   - status `cancelled`  → exit 0, no "DO NOT ABANDON" block on stderr
 *   - status `in_progress`→ exit 2, block message on stderr (no regression)
 *   - `abort workflow` keyword still allows the stop (exit 0) and redirects the
 *     operator toward the bookkept `work.workflow.js cancel` subcommand.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Stop-hook entrypoint: lib/hooks/session-guard.js (dispatches to handleStop).
const GUARD = path.resolve(__dirname, '..', '..', 'session-guard.js');

const TICKET = 'AAA-1';

describe('session-guard Stop hook — cancelled-status allowance', () => {
  let tmp;
  let cwd;
  let envBase;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-handlers-'));
    cwd = path.join(tmp, 'cwd');
    fs.mkdirSync(cwd, { recursive: true });
    envBase = {
      SESSION_GUARD_DIR: path.join(tmp, 'sg'),
      SESSION_GUARD_TICKET_ID: TICKET,
      TASKS_BASE: path.join(tmp, 'tasks'),
      WORKTREES_BASE: tmp,
    };
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function run(args, { input, env = {} } = {}) {
    const merged = { ...process.env, ...envBase, ...env };
    for (const key of [
      'AGENT_RUNTIME',
      'AGENT_SESSION_ID',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_HOOK_TYPE',
    ]) {
      if (!(key in env)) delete merged[key];
    }
    const r = spawnSync(process.execPath, [GUARD, ...args], {
      input: input === undefined ? '' : input,
      encoding: 'utf8',
      cwd,
      timeout: 15000,
      env: merged,
    });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  }

  function stop(payload, env = {}) {
    return run([], { input: JSON.stringify(payload), env: { CLAUDE_HOOK_TYPE: 'Stop', ...env } });
  }

  /** Write `$TASKS_BASE/<ticket>/.work-state.json` with the given status. */
  function writeWorkState(status) {
    const ticketDir = path.join(envBase.TASKS_BASE, TICKET);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ ticketId: TICKET, currentStep: 3, status }, null, 2)
    );
  }

  it('the Stop hook allows stopping when work state status is cancelled', () => {
    run(['init', TICKET, '/work'], { env: { CLAUDE_CODE_SESSION_ID: 'owner-A' } });
    writeWorkState('cancelled');
    const r = stop(
      { session_id: 'owner-A', stop_hook_active: false },
      { CLAUDE_CODE_SESSION_ID: 'owner-A' }
    );
    assert.equal(r.code, 0, 'cancelled state must allow the stop');
    assert.equal(r.stderr, '', 'no DO NOT ABANDON block message for a cancelled ticket');
  });

  it('the Stop hook still blocks an in-progress owned session (no regression)', () => {
    run(['init', TICKET, '/work'], { env: { CLAUDE_CODE_SESSION_ID: 'owner-A' } });
    writeWorkState('in_progress');
    const r = stop(
      { session_id: 'owner-A', stop_hook_active: false },
      { CLAUDE_CODE_SESSION_ID: 'owner-A' }
    );
    assert.equal(r.code, 2, 'in-progress state must still block the stop');
    assert.match(r.stderr, /DO NOT (STOP|ABANDON)/, 'in-progress block message must be present');
  });

  it('the abort workflow keyword allows the stop and redirects to the cancel subcommand', () => {
    run(['init', TICKET, '/work'], { env: { CLAUDE_CODE_SESSION_ID: 'owner-A' } });
    writeWorkState('in_progress');
    const r = stop(
      { session_id: 'owner-A', stop_hook_active: false, stop_message: 'please abort workflow now' },
      { CLAUDE_CODE_SESSION_ID: 'owner-A' }
    );
    assert.equal(r.code, 0, 'abort workflow keyword must allow the stop');
    assert.match(
      r.stderr,
      /work\.workflow\.js"? cancel/,
      'stderr must redirect the operator to the cancel subcommand'
    );
  });

  it('a stop message without the abort keyword is unaffected by the redirect', () => {
    run(['init', TICKET, '/work'], { env: { CLAUDE_CODE_SESSION_ID: 'owner-A' } });
    writeWorkState('in_progress');
    const r = stop(
      { session_id: 'owner-A', stop_hook_active: false, stop_message: 'just a normal message' },
      { CLAUDE_CODE_SESSION_ID: 'owner-A' }
    );
    assert.equal(r.code, 2, 'a non-keyword stop still blocks');
    assert.doesNotMatch(
      r.stderr,
      /work\.workflow\.js"? cancel/,
      'no cancel redirect for a non-keyword stop'
    );
  });
});
