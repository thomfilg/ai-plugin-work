'use strict';

/**
 * Tests for remind-once.js — the session-scoped reminder ledger primitive.
 *
 * Coverage:
 *   1. resolveSessionId — payload-first via normalizeHookPayload; empty payload
 *      → stable sha256 hash (never a raw cwd); unsafe ids hashed via SAFE_ID_RE.
 *   2. shouldRemind — every-prompt always true; once-per-session true only
 *      before a record and false after; ledger read error fails toward true.
 *   3. recordReminder — writes { firedAt, count }; second call increments count.
 *   4. Keying isolation — two session ids in the SAME folder → distinct files;
 *      recording under one does not dedupe the other.
 *   5. resetForSession re-arms; gcStaleLedgers removes stale files, keeps fresh.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const remindOnce = require('../remind-once');

let tmp;
let savedEnv;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remind-once-'));
  process.env.REMIND_ONCE_SESSION_DIR = tmp;
  // Scrub the ambient session-id env legs so "empty payload" tests exercise
  // the sha256(cwd+start) degradation, not the launching terminal's id.
  savedEnv = {
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    AGENT_SESSION_ID: process.env.AGENT_SESSION_ID,
  };
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.AGENT_SESSION_ID;
});

afterEach(() => {
  delete process.env.REMIND_ONCE_SESSION_DIR;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('resolveSessionId', () => {
  it('resolves payload.session_id first', () => {
    assert.equal(remindOnce.resolveSessionId({ session_id: 'sess-ABC_123' }), 'sess-ABC_123');
  });

  it('falls back to a stable sha256 hash (never raw cwd) on empty payload', () => {
    const id = remindOnce.resolveSessionId({});
    assert.match(id, /^[a-f0-9]{32}$/);
    assert.notEqual(id, process.cwd());
    // Stable within a process (same cwd + processStart).
    assert.equal(id, remindOnce.resolveSessionId({}));
  });

  it('sanitizes unsafe session ids via SAFE_ID_RE (hashes path-traversal)', () => {
    const id = remindOnce.resolveSessionId({ session_id: '../../etc/passwd' });
    assert.match(id, /^[a-f0-9]{32}$/);
    assert.ok(!id.includes('/'));
  });
});

describe('shouldRemind cadence', () => {
  it('every-prompt always returns true', () => {
    assert.equal(remindOnce.shouldRemind('s1', 'r1', 'every-prompt'), true);
    remindOnce.recordReminder('s1', 'r1');
    assert.equal(remindOnce.shouldRemind('s1', 'r1', 'every-prompt'), true);
  });

  it('once-per-session true before a record, false after', () => {
    assert.equal(remindOnce.shouldRemind('s2', 'r1', 'once-per-session'), true);
    remindOnce.recordReminder('s2', 'r1');
    assert.equal(remindOnce.shouldRemind('s2', 'r1', 'once-per-session'), false);
  });

  it('ledger read error fails toward true (never suppresses first fire)', () => {
    // Point the dir at a path that cannot be read as a directory of files by
    // writing a bogus (non-JSON) ledger; shouldRemind must still return true.
    const file = path.join(tmp, 's3.json');
    fs.writeFileSync(file, 'not-json{{{');
    assert.equal(remindOnce.shouldRemind('s3', 'r1', 'once-per-session'), true);
  });
});

describe('recordReminder ledger shape', () => {
  it('writes { firedAt, count } and increments count on repeat', () => {
    remindOnce.recordReminder('s4', 'agent-picker');
    let raw = JSON.parse(fs.readFileSync(path.join(tmp, 's4.json'), 'utf8'));
    assert.equal(raw.reminders['agent-picker'].count, 1);
    assert.equal(typeof raw.reminders['agent-picker'].firedAt, 'string');
    remindOnce.recordReminder('s4', 'agent-picker');
    raw = JSON.parse(fs.readFileSync(path.join(tmp, 's4.json'), 'utf8'));
    assert.equal(raw.reminders['agent-picker'].count, 2);
  });

  it('stores only reminder ids + counters + timestamps (no bodies/prompts)', () => {
    remindOnce.recordReminder('s5', 'r1');
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, 's5.json'), 'utf8'));
    const keys = Object.keys(raw.reminders.r1);
    assert.deepEqual(keys.sort(), ['count', 'firedAt']);
  });
});

describe('keying isolation (session id, never cwd)', () => {
  it('two session ids in the same folder → distinct ledger files', () => {
    remindOnce.recordReminder('sessA', 'r1');
    assert.equal(remindOnce.shouldRemind('sessA', 'r1', 'once-per-session'), false);
    // Different session, SAME working folder → not deduped.
    assert.equal(remindOnce.shouldRemind('sessB', 'r1', 'once-per-session'), true);
    assert.ok(fs.existsSync(path.join(tmp, 'sessA.json')));
    assert.ok(!fs.existsSync(path.join(tmp, 'sessB.json')));
  });
});

describe('resetForSession + gcStaleLedgers', () => {
  it('resetForSession re-arms all once-per-session reminders', () => {
    remindOnce.recordReminder('s6', 'r1');
    assert.equal(remindOnce.shouldRemind('s6', 'r1', 'once-per-session'), false);
    remindOnce.resetForSession('s6');
    assert.equal(remindOnce.shouldRemind('s6', 'r1', 'once-per-session'), true);
  });

  it('gcStaleLedgers removes files older than maxAgeMs, keeps fresh', () => {
    remindOnce.recordReminder('stale', 'r1');
    remindOnce.recordReminder('fresh', 'r1');
    const staleFile = path.join(tmp, 'stale.json');
    const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
    fs.utimesSync(staleFile, old / 1000, old / 1000);
    remindOnce.gcStaleLedgers({ maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
    assert.ok(!fs.existsSync(staleFile));
    assert.ok(fs.existsSync(path.join(tmp, 'fresh.json')));
  });
});
