'use strict';

/**
 * Tests for session-guard stand-down (GH-752, outcome-verification Phase 1.1).
 *
 * Behavior under test (session-guard/stand-down.js wired into handleStop):
 *  - fires 1..CAP with an unchanged workflow fingerprint still BLOCK (exit 2);
 *  - the fire after the cap STANDS DOWN (exit 0) with one conductor line;
 *  - workflow-state progress (fingerprint change) re-arms the counter;
 *  - rate-limit stops (stop message or transcript tail) stand down immediately;
 *  - an abandoned workflow (stale .work-state.json mtime) stands down immediately;
 *  - every stand-down writes an enforcement audit row.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnHook } = require('./_helpers/run-hook');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'session-guard.js');
const SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'session-guard-standdown-'));
const TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'session-guard-standdown-tasks-'));
const TICKET = 'TEST-SD-1';
const WORKFLOW = '/work';

function cleanupAllSessions() {
  try {
    for (const f of fs.readdirSync(SESSION_DIR)) {
      if (f.startsWith('claude-session-guard-')) fs.unlinkSync(path.join(SESSION_DIR, f));
    }
  } catch {
    /* ignore */
  }
}

function ticketDir() {
  const dir = path.join(TASKS_BASE, TICKET);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function resetTicketDir() {
  fs.rmSync(path.join(TASKS_BASE, TICKET), { recursive: true, force: true });
  ticketDir();
}

function baseEnv(extra = {}) {
  return {
    SESSION_GUARD_DIR: SESSION_DIR,
    SESSION_GUARD_TICKET_ID: TICKET,
    TASKS_BASE,
    CLAUDE_CODE_SESSION_ID: undefined,
    ...extra,
  };
}

function runCli(args, extraEnv = {}) {
  return spawnHook(HOOK_PATH, null, baseEnv(extraEnv), { args });
}

function fireStop(hookData = {}, extraEnv = {}) {
  return spawnHook(
    HOOK_PATH,
    { session_id: 'test-session', ...hookData },
    baseEnv({ ...extraEnv, CLAUDE_HOOK_TYPE: 'Stop' })
  );
}

function readAuditRows() {
  try {
    return JSON.parse(fs.readFileSync(path.join(TASKS_BASE, TICKET, '.work-actions.json'), 'utf8'));
  } catch {
    return [];
  }
}

function readSessionFile() {
  return JSON.parse(
    fs.readFileSync(path.join(SESSION_DIR, `claude-session-guard-${TICKET}.json`), 'utf8')
  );
}

describe('session-guard stand-down (GH-752)', () => {
  before(() => {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  });
  after(() => {
    cleanupAllSessions();
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    fs.rmSync(TASKS_BASE, { recursive: true, force: true });
  });
  beforeEach(() => {
    cleanupAllSessions();
    resetTicketDir();
  });

  it('blocks fires 1-3, stands down on the 4th identical block, and audits it', async () => {
    await runCli(['init', TICKET, WORKFLOW]);

    for (let fire = 1; fire <= 3; fire++) {
      const r = await fireStop();
      assert.equal(r.code, 2, `fire ${fire} must still block`);
      assert.doesNotMatch(r.stderr, /STAND-DOWN/, `fire ${fire} must not mention stand-down`);
    }

    const fourth = await fireStop();
    assert.equal(fourth.code, 0, '4th identical block must allow the stop');
    assert.match(fourth.stderr, /STAND-DOWN \(repeat-cap\)/);
    assert.match(fourth.stderr, new RegExp(TICKET));

    assert.equal(readSessionFile().standDown.count, 4);

    const rows = readAuditRows().filter((row) => row.action === 'session-guard-stand-down');
    assert.equal(rows.length, 1, 'exactly one stand-down audit row');
    assert.equal(rows[0].allow, true);
    assert.equal(rows[0].reason, 'repeat-cap');
    assert.equal(rows[0].meta.count, 4);

    // 5th-and-beyond fires stand down SILENTLY: still exit 0, but no new
    // conductor line and no new audit row — a long-stalled session cannot
    // grow the trail without bound.
    const fifth = await fireStop();
    assert.equal(fifth.code, 0, '5th fire still allows the stop');
    assert.doesNotMatch(fifth.stderr, /STAND-DOWN/, 'repeat stand-down is silent');
    const rowsAfter = readAuditRows().filter((row) => row.action === 'session-guard-stand-down');
    assert.equal(rowsAfter.length, 1, 'no audit-row growth on repeat stand-downs');
  });

  it('workflow progress (fingerprint change) re-arms the counter', async () => {
    await runCli(['init', TICKET, WORKFLOW]);

    for (let fire = 1; fire <= 3; fire++) {
      assert.equal((await fireStop()).code, 2);
    }

    // Progress: the workflow state moves to a different step/task.
    fs.writeFileSync(
      path.join(ticketDir(), '.work-state.json'),
      JSON.stringify({ currentStep: 9, tasksMeta: { currentTaskIndex: 2 } })
    );

    const afterProgress = await fireStop();
    assert.equal(afterProgress.code, 2, 'fingerprint changed — guard re-arms and blocks again');
    assert.equal(readSessionFile().standDown.count, 1, 'counter reset on progress');
  });

  it('stands down immediately on a rate-limited stop message (announcing once)', async () => {
    await runCli(['init', TICKET, WORKFLOW]);
    const r = await fireStop({ stop_message: 'request failed: API rate limit reached (429)' });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /STAND-DOWN \(rate-limit\)/);
    const rows = readAuditRows().filter((row) => row.action === 'session-guard-stand-down');
    assert.equal(rows[0].reason, 'rate-limit');

    const again = await fireStop({ stop_message: 'request failed: API rate limit reached (429)' });
    assert.equal(again.code, 0);
    assert.doesNotMatch(again.stderr, /STAND-DOWN/, 'repeat rate-limit stand-down is silent');
    const rowsAfter = readAuditRows().filter((row) => row.action === 'session-guard-stand-down');
    assert.equal(rowsAfter.length, 1, 'one audit row per stand-down reason');
  });

  it('stands down immediately when the transcript tail shows a rate limit', async () => {
    await runCli(['init', TICKET, WORKFLOW]);
    const transcript = path.join(TASKS_BASE, 'transcript.jsonl');
    fs.writeFileSync(transcript, '{"type":"error","error":{"type":"overloaded_error"}}\n');
    const r = await fireStop({ transcript_path: transcript });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /STAND-DOWN \(rate-limit\)/);
  });

  it('stands down immediately on an abandoned workflow (stale state mtime)', async () => {
    await runCli(['init', TICKET, WORKFLOW]);
    const stateFile = path.join(ticketDir(), '.work-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({ currentStep: 9 }));
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(stateFile, past, past);

    const r = await fireStop({}, { WORK_GUARD_ABANDON_MS: '1000' });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /STAND-DOWN \(abandoned\)/);
  });

  it('a fresh state file does not trip the abandonment detector', async () => {
    await runCli(['init', TICKET, WORKFLOW]);
    fs.writeFileSync(
      path.join(ticketDir(), '.work-state.json'),
      JSON.stringify({ currentStep: 9 })
    );
    const r = await fireStop({}, { WORK_GUARD_ABANDON_MS: String(60 * 60 * 1000) });
    assert.equal(r.code, 2, 'recent state — normal block');
  });
});
