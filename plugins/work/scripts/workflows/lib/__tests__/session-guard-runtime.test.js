'use strict';

/**
 * Dual-runtime tests for session-guard.js (WP-06): session-id resolution is
 * payload-first with CLAUDE_CODE_SESSION_ID then the runtime-neutral
 * AGENT_SESSION_ID bridge as env fallbacks (codex sets no CLAUDE_* vars).
 * The claude Stop block message is pinned byte-identical to the HEAD
 * characterization capture; the stop_hook_active self-gate holds for
 * codex-shaped payloads too.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GUARD = path.resolve(__dirname, '..', 'hooks', 'session-guard.js');

// Byte-identical HEAD capture of the claude /work Stop block (no work-state).
const CLAUDE_BLOCK_BYTES =
  'ACTIVE WORKFLOW SESSION — DO NOT ABANDON\n' +
  'Workflow: /work | Ticket: AAA-1\n' +
  'You MUST continue this workflow. Run:\n' +
  '  node "${CLAUDE_PLUGIN_ROOT}/scripts/workflows/work/work-next.js" AAA-1\n' +
  'Execute the returned instruction, then re-run work-next.js until action: "complete".\n' +
  'The session is locked with a passphrase. Complete all steps to unlock.\n';

describe('session-guard — dual runtime session identity', () => {
  let tmp;
  let cwd;
  let envBase;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-guard-rt-'));
    cwd = path.join(tmp, 'cwd');
    fs.mkdirSync(cwd, { recursive: true });
    envBase = {
      SESSION_GUARD_DIR: path.join(tmp, 'sg'),
      SESSION_GUARD_TICKET_ID: 'AAA-1',
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
      'CODEX_THREAD_ID',
      'PLUGIN_ROOT',
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

  it('claude: Stop block bytes are identical to the HEAD capture', () => {
    run(['init', 'AAA-1', '/work'], { env: { CLAUDE_CODE_SESSION_ID: 'owner-A' } });
    const r = stop(
      { session_id: 'owner-A', stop_hook_active: false },
      { CLAUDE_CODE_SESSION_ID: 'owner-A', AGENT_RUNTIME: 'claude' }
    );
    assert.equal(r.code, 2);
    assert.equal(r.stderr, CLAUDE_BLOCK_BYTES);
  });

  it('init stamps ownerSessionId from AGENT_SESSION_ID when CLAUDE var is absent', () => {
    run(['init', 'AAA-1', '/work'], { env: { AGENT_SESSION_ID: 'owner-B' } });
    const files = fs.readdirSync(path.join(tmp, 'sg'));
    assert.equal(files.length, 1);
    const session = JSON.parse(fs.readFileSync(path.join(tmp, 'sg', files[0]), 'utf8'));
    assert.equal(session.ownerSessionId, 'owner-B');
  });

  it('codex Stop with matching AGENT_SESSION_ID still holds the lock', () => {
    run(['init', 'AAA-1', '/work'], { env: { AGENT_SESSION_ID: 'owner-B' } });
    const r = stop(
      {
        turn_id: 't-1',
        transcript_path: '/tmp/h/sessions/2026/07/07/rollout-x.jsonl',
        stop_hook_active: false,
      },
      { AGENT_SESSION_ID: 'owner-B', AGENT_RUNTIME: 'codex' }
    );
    assert.equal(r.code, 2);
    assert.equal(r.stderr, CLAUDE_BLOCK_BYTES);
  });

  it('a foreign AGENT_SESSION_ID does not get force-held (lock scoping)', () => {
    run(['init', 'AAA-1', '/work'], { env: { AGENT_SESSION_ID: 'owner-B' } });
    const r = stop(
      { turn_id: 't-1', stop_hook_active: false },
      { AGENT_SESSION_ID: 'other-C', AGENT_RUNTIME: 'codex' }
    );
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
  });

  it('payload session_id ranks above the env fallbacks', () => {
    run(['init', 'AAA-1', '/work'], { env: { CLAUDE_CODE_SESSION_ID: 'owner-A' } });
    const r = stop(
      { session_id: 'other-C', stop_hook_active: false },
      { AGENT_SESSION_ID: 'owner-A', AGENT_RUNTIME: 'codex' }
    );
    assert.equal(r.code, 0, 'payload-identified foreign session must not be held');
  });

  it('stop_hook_active self-gate holds for codex-shaped payloads', () => {
    run(['init', 'AAA-1', '/work'], { env: { AGENT_SESSION_ID: 'owner-B' } });
    const r = stop(
      {
        turn_id: 't-1',
        transcript_path: '/tmp/h/sessions/2026/07/07/rollout-x.jsonl',
        stop_hook_active: true,
      },
      { AGENT_SESSION_ID: 'owner-B', AGENT_RUNTIME: 'codex' }
    );
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
  });
});
