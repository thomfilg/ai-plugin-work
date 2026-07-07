'use strict';

/**
 * Dual-runtime tests for work-enforce-steps.js (WP-07):
 *   - the hook reads tool_input from the stdin payload (the TOOL_INPUT env
 *     channel is legacy — codex never sets it, and current claude delivers
 *     tool_input in the payload); env still wins when present (byte-identity)
 *   - the hook is an explicit NO-OP on codex (no Skill tool there — design
 *     C5/C13; the Skill matcher lane is already dead, this pins the guard)
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'work-enforce-steps.js');
const TICKET_PROJECT_KEY = 'TESTWES';

describe('work-enforce-steps — dual runtime', () => {
  let tasksBase;
  let counter = 0;

  before(() => {
    tasksBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wes-rt-'));
  });

  after(() => {
    fs.rmSync(tasksBase, { recursive: true, force: true });
  });

  function nextTicket() {
    counter += 1;
    return `${TICKET_PROJECT_KEY}-${process.pid}${counter}`;
  }

  function runHook({ payload, env = {} }) {
    const merged = {
      ...process.env,
      TASKS_BASE: tasksBase,
      TICKET_PROJECT_KEY,
      ...env,
    };
    for (const key of [
      'AGENT_RUNTIME',
      'AGENT_SESSION_ID',
      'CODEX_THREAD_ID',
      'PLUGIN_ROOT',
      'TOOL_INPUT',
      'CLAUDE_HOOK_TYPE',
    ]) {
      if (!(key in env)) delete merged[key];
    }
    const r = spawnSync(process.execPath, [HOOK_PATH], {
      input: payload === undefined ? '' : JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 15000,
      env: merged,
    });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  }

  it('claude: reads tool_input from the stdin payload when TOOL_INPUT is unset', () => {
    const ticket = nextTicket();
    const r = runHook({
      payload: {
        session_id: 's-1',
        hook_event_name: 'PreToolUse',
        tool_name: 'Skill',
        tool_input: { skill: 'work', args: ticket },
      },
      env: { AGENT_RUNTIME: 'claude', CLAUDE_HOOK_TYPE: 'PreToolUse' },
    });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /\/work session started/);
    assert.equal(fs.existsSync(path.join(tasksBase, ticket, '.work-session')), true);
  });

  it('claude: the TOOL_INPUT env leg still wins when set (byte-identity)', () => {
    const envTicket = nextTicket();
    const payloadTicket = nextTicket();
    const r = runHook({
      payload: {
        session_id: 's-1',
        hook_event_name: 'PreToolUse',
        tool_name: 'Skill',
        tool_input: { skill: 'work', args: payloadTicket },
      },
      env: {
        AGENT_RUNTIME: 'claude',
        CLAUDE_HOOK_TYPE: 'PreToolUse',
        TOOL_INPUT: JSON.stringify({ skill: 'work', args: envTicket }),
      },
    });
    assert.equal(r.code, 0);
    assert.equal(fs.existsSync(path.join(tasksBase, envTicket, '.work-session')), true);
    assert.equal(fs.existsSync(path.join(tasksBase, payloadTicket, '.work-session')), false);
  });

  it('codex: no-ops silently (exit 0, no session file, no output)', () => {
    const ticket = nextTicket();
    const r = runHook({
      payload: {
        session_id: 's-1',
        turn_id: 't-1',
        hook_event_name: 'PreToolUse',
        tool_name: 'Skill',
        tool_input: { skill: 'work', args: ticket },
      },
      env: { AGENT_RUNTIME: 'codex', CLAUDE_HOOK_TYPE: 'PreToolUse' },
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(fs.existsSync(path.join(tasksBase, ticket)), false);
  });
});
