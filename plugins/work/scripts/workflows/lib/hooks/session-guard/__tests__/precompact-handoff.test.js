'use strict';

/**
 * Tests for the PreCompact checkpoint write/validate + lock integrity in
 * session-guard/hook-handlers.js (Task 5, GH-315).
 *
 * Deliverable 5.1 — PreCompact must, for an owned active session on the current
 * ticket, write (or prompt for) a `.continue-here.md` checkpoint via the handoff
 * helpers and validate its three sections — flagging any missing required
 * heading — instead of only printing the stdout reminder. It must still
 * fail-open (exit 0) on any error and preserve the existing reminder text.
 *
 * Deliverable 5.2 — Lock integrity: the checkpoint write path only READS state
 * and WRITES the artifact. It MUST NOT reveal the passphrase, call
 * `session-guard reveal/finish`, or satisfy `blockStop` — a subsequent Stop
 * during `implement` still exits 2 and the passphrase never reaches stdio.
 *
 * The hook is spawned via `child_process.spawnSync` (the established session-
 * guard test pattern), asserting exit codes + stdio. Temp dirs use
 * fs.mkdtempSync + rmSync in afterEach.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GUARD = path.resolve(__dirname, '..', '..', 'session-guard.js');
const { REQUIRED_HANDOFF_SECTIONS, validateHandoffSections } = require(
  path.resolve(__dirname, '..', '..', '..', 'handoff.js')
);

const TICKET = 'AAA-1';
const HANDOFF_FILE = '.continue-here.md';

/** A handoff body missing the third required heading ("What was in flight"). */
function handoffMissingInFlight() {
  return (
    `## ${REQUIRED_HANDOFF_SECTIONS[0]}\n\nChose approach X over Y.\n\n` +
    `## ${REQUIRED_HANDOFF_SECTIONS[1]}\n\nWatch out for the flaky test.\n`
  );
}

describe('session-guard PreCompact — checkpoint write/validate + lock integrity', () => {
  let tmp;
  let cwd;
  let tasksBase;
  let ticketDir;
  let envBase;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'precompact-handoff-'));
    cwd = path.join(tmp, 'cwd');
    tasksBase = path.join(tmp, 'tasks');
    ticketDir = path.join(tasksBase, TICKET);
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(ticketDir, { recursive: true });
    envBase = {
      SESSION_GUARD_DIR: path.join(tmp, 'sg'),
      SESSION_GUARD_TICKET_ID: TICKET,
      TASKS_BASE: tasksBase,
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

  function initSession(env = {}) {
    return run(['init', TICKET, '/work'], { env: { CLAUDE_CODE_SESSION_ID: 'owner-A', ...env } });
  }

  function preCompact(env = {}) {
    return run([], {
      input: JSON.stringify({ session_id: 'owner-A' }),
      env: { CLAUDE_HOOK_TYPE: 'PreCompact', CLAUDE_CODE_SESSION_ID: 'owner-A', ...env },
    });
  }

  function stop(payload = {}, env = {}) {
    return run([], {
      input: JSON.stringify({ session_id: 'owner-A', stop_hook_active: false, ...payload }),
      env: { CLAUDE_HOOK_TYPE: 'Stop', CLAUDE_CODE_SESSION_ID: 'owner-A', ...env },
    });
  }

  /** Write a `.work-state.json` placing the workflow at the `implement` step. */
  function writeImplementState() {
    // implement is 1-based step index 9 in STEP_ORDER; _work2Dispatched must NOT
    // be a user-review gate so a Stop blocks (exit 2).
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ ticketId: TICKET, currentStep: 9, _work2Dispatched: 'implement' }, null, 2)
    );
  }

  function readHandoffOnDisk() {
    const p = path.join(ticketDir, HANDOFF_FILE);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }

  function sessionPassphrase() {
    const dir = path.join(tmp, 'sg');
    const files = fs.readdirSync(dir);
    const session = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    return session.passphrase;
  }

  // ── 5.1 — PreCompact writes/validates a checkpoint (not just a reminder) ──

  it('PreCompact writes and validates a checkpoint instead of only a reminder', () => {
    initSession();
    const r = preCompact();

    assert.equal(r.code, 0, 'PreCompact must fail-open / allow (exit 0)');
    // The existing reminder text is preserved.
    assert.match(r.stdout, /ACTIVE WORKFLOW SESSION - DO NOT ABANDON/);

    // A checkpoint is written to disk OR the agent is prompted to author one.
    const onDisk = readHandoffOnDisk();
    const promptedToWrite = /continue-here\.md/i.test(r.stdout);
    assert.ok(
      onDisk !== null || promptedToWrite,
      'PreCompact must write a .continue-here.md checkpoint or prompt the agent to author one'
    );
    // If it wrote one, it carries the three required section headings.
    if (onDisk !== null) {
      assert.equal(
        validateHandoffSections(onDisk).ok,
        true,
        'a checkpoint written by PreCompact must carry all three required sections'
      );
    }
  });

  it('5.1.1: flags a pre-existing checkpoint missing a required section via validateHandoffSections; exits 0', () => {
    initSession();
    // The agent already left a skeleton missing "What was in flight".
    fs.writeFileSync(path.join(ticketDir, HANDOFF_FILE), handoffMissingInFlight());

    const r = preCompact();

    assert.equal(
      r.code,
      0,
      'PreCompact must fail-open (exit 0) even when the checkpoint is invalid'
    );
    // The missing section must be surfaced (validated, not silently accepted).
    const combined = r.stdout + r.stderr;
    assert.match(
      combined,
      new RegExp(REQUIRED_HANDOFF_SECTIONS[2].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), 'i'),
      'PreCompact must flag the missing "What was in flight" heading'
    );
  });

  it('5.1.1: does NOT write/prompt a checkpoint when no owned session exists (exit 0, no reminder)', () => {
    // No init → no owned active session.
    const r = preCompact();
    assert.equal(r.code, 0, 'no session → allow (exit 0)');
    assert.equal(r.stdout, '', 'no reminder or checkpoint prompt without an owned session');
    assert.equal(readHandoffOnDisk(), null, 'no checkpoint is written without an owned session');
  });

  // ── 5.2 — Lock integrity: checkpoint write never releases the lock ──

  it('5.2.1: the PreCompact path never emits the passphrase and does not reveal the session', () => {
    initSession();
    const passphrase = sessionPassphrase();

    const r = preCompact();

    assert.equal(r.code, 0);
    assert.ok(
      !r.stdout.includes(passphrase) && !r.stderr.includes(passphrase),
      'PreCompact must never write the passphrase to stdout/stderr'
    );

    // The session file must still be present and UNREVEALED (no reveal/finish).
    const dir = path.join(tmp, 'sg');
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1, 'the session file must still exist (no finish/complete)');
    const session = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    assert.notEqual(session.revealed, true, 'PreCompact must not mark the session revealed');
  });

  it('pause during implement does not release the session-guard lock', () => {
    initSession();
    writeImplementState();

    // Simulate compaction: PreCompact writes/validates the checkpoint.
    const pc = preCompact();
    assert.equal(pc.code, 0, 'PreCompact allows (exit 0)');

    // The lock must still be held — a Stop at implement blocks.
    const s = stop();
    assert.equal(s.code, 2, 'Stop during implement must still block (exit 2) after the checkpoint');
    assert.match(
      s.stderr,
      /DO NOT ABANDON|DO NOT STOP/,
      'the Stop block message is still emitted after PreCompact'
    );

    const passphrase = sessionPassphrase();
    assert.ok(
      !s.stdout.includes(passphrase) && !s.stderr.includes(passphrase),
      'the passphrase is never revealed on the blocked Stop'
    );
  });
});
