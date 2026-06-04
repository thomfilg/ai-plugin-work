'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const MONITOR = path.join(REPO_ROOT, 'scripts', 'monitor-manager.js');
const COMMUNICATE = path.join(REPO_ROOT, 'scripts', 'communicate.js');

const { extractTicket, TICKET_PREFIX_RE, DONE_SENTINEL } = require(MONITOR);

test('extractTicket pulls ticket id from "[ts] TICKET: msg" line', () => {
  assert.equal(extractTicket('[2026-05-18T12:00:00Z] ECHO-4560: hello there'), 'ECHO-4560');
  assert.equal(extractTicket('[ts] PR-1547: blah'), 'PR-1547');
  assert.equal(extractTicket('[ts] GH-365: thing'), 'GH-365');
  assert.equal(extractTicket('[ts] APPSUPEN-1119: x'), 'APPSUPEN-1119');
});

test('extractTicket returns null when no ticket prefix present', () => {
  assert.equal(extractTicket('[ts] just a bare line'), null);
  assert.equal(extractTicket('[ts] not-a-ticket: text'), null);
});

test('extractTicket is case-insensitive on output but requires uppercase tag', () => {
  // Pattern is uppercase-only by design — lowercase is rejected.
  assert.equal(extractTicket('[ts] echo-4560: lower'), null);
  // Already-uppercase passes through unchanged.
  assert.equal(extractTicket('[ts] ECHO-4560: x'), 'ECHO-4560');
});

test('DONE_SENTINEL is the agreed marker string', () => {
  assert.equal(DONE_SENTINEL, '__MONITOR_DONE__');
});

test('communicate.js --done writes sentinel to ticket channel + MONITOR', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-mgr-test-'));
  try {
    const r = spawnSync(
      process.execPath,
      [COMMUNICATE, '--done', 'echo-9999', 'workflow-complete'],
      {
        env: { ...process.env, CLAUDE_AGENT_INBOX_DIR: tmp },
        encoding: 'utf8',
      }
    );
    assert.equal(
      r.status,
      0,
      `expected exit 0, got ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`
    );
    const ticketLog = fs.readFileSync(path.join(tmp, 'ECHO-9999.log'), 'utf8');
    const monitorLog = fs.readFileSync(path.join(tmp, 'MONITOR.log'), 'utf8');
    assert.match(ticketLog, /__MONITOR_DONE__ workflow-complete/);
    assert.match(monitorLog, /ECHO-9999: __MONITOR_DONE__/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('TICKET_PREFIX_RE handles a stand-alone (no [ts] prefix) line too', () => {
  // For robustness — the test exists to lock the alternate match path
  // documented in the regex.
  assert.match('ECHO-4560: bare-start line', TICKET_PREFIX_RE);
});
