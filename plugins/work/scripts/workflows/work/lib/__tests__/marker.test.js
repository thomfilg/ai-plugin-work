/**
 * Tests for marker.js — findActiveMarker session/worktree scoping.
 *
 * Regression: multiple agents share one TASKS_BASE; a PostToolUse hook firing in
 * worktree/session A must select ONLY a marker owned by A, never the first marker
 * it happens to find (which cross-wired follow-up/work into other tickets).
 *
 * node:test + node:assert/strict; temp TASKS_BASE via fs.mkdtempSync.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { findActiveMarker } = require(path.join(__dirname, '..', 'marker'));

const MARKER = '.work.pid';
let TASKS_BASE;

function writeMarker(ticket, fields) {
  const dir = path.join(TASKS_BASE, ticket);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, MARKER),
    JSON.stringify({ ticket, startedAt: new Date().toISOString(), ...fields })
  );
}

describe('marker.findActiveMarker', () => {
  beforeEach(() => {
    TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-test-'));
  });
  afterEach(() => {
    fs.rmSync(TASKS_BASE, { recursive: true, force: true });
  });

  it('selects the marker owned by the caller session, skipping a foreign one', () => {
    writeMarker('AAA-1', { sessionId: 'sess-A', worktreeRoot: '/wt/a' });
    writeMarker('BBB-2', { sessionId: 'sess-B', worktreeRoot: '/wt/b' });

    const m = findActiveMarker(TASKS_BASE, MARKER, { sessionId: 'sess-B', worktreeRoot: '/wt/b' });
    assert.equal(m.ticket, 'BBB-2');
  });

  it('returns null when every marker is owned by a different session', () => {
    writeMarker('AAA-1', { sessionId: 'sess-A', worktreeRoot: '/wt/a' });

    const m = findActiveMarker(TASKS_BASE, MARKER, {
      sessionId: 'sess-OTHER',
      worktreeRoot: '/wt/other',
    });
    assert.equal(m, null, 'foreign marker must not be selected');
  });

  it('skips a marker owned by a different worktree even if session is unknown', () => {
    writeMarker('AAA-1', { sessionId: 'sess-A', worktreeRoot: '/wt/a' });

    const m = findActiveMarker(TASKS_BASE, MARKER, { sessionId: null, worktreeRoot: '/wt/mine' });
    assert.equal(m, null, 'different worktree must not be selected');
  });

  it('falls back to first-match for legacy markers without identity', () => {
    writeMarker('LEG-1', {}); // no sessionId / worktreeRoot

    const m = findActiveMarker(TASKS_BASE, MARKER, { sessionId: 'sess-X', worktreeRoot: '/wt/x' });
    assert.equal(m.ticket, 'LEG-1', 'legacy marker is never foreign (backward compatible)');
  });

  it('falls back to first-match when caller identity is unknown', () => {
    writeMarker('AAA-1', { sessionId: 'sess-A', worktreeRoot: '/wt/a' });

    const m = findActiveMarker(TASKS_BASE, MARKER, {});
    assert.equal(m.ticket, 'AAA-1', 'unknown caller → preserve single-agent behavior');
  });

  it('prefers an explicitly-owned marker over a non-foreign legacy one', () => {
    writeMarker('LEG-1', {}); // legacy, non-foreign
    writeMarker('OWN-2', { sessionId: 'sess-me', worktreeRoot: '/wt/me' });

    const m = findActiveMarker(TASKS_BASE, MARKER, {
      sessionId: 'sess-me',
      worktreeRoot: '/wt/me',
    });
    assert.equal(m.ticket, 'OWN-2');
  });

  it('returns null for an unreadable tasksBase (fail-open)', () => {
    const m = findActiveMarker(path.join(TASKS_BASE, 'does-not-exist'), MARKER, {
      sessionId: 'x',
    });
    assert.equal(m, null);
  });

  it('skips foreign markers but selects a co-resident owned one', () => {
    writeMarker('FOREIGN-1', { sessionId: 'sess-A', worktreeRoot: '/wt/a' });
    writeMarker('MINE-2', { sessionId: 'sess-me', worktreeRoot: '/wt/me' });

    const m = findActiveMarker(TASKS_BASE, MARKER, {
      sessionId: 'sess-me',
      worktreeRoot: '/wt/me',
    });
    assert.equal(m.ticket, 'MINE-2');
  });
});
