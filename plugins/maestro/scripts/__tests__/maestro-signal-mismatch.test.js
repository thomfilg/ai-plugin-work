// maestro-signal.js footgun guard (GH-622 follow-up): a /signal that finds no
// listener must warn LOUDLY when the agent is running under a different
// namespace, instead of silently dropping the message.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { buildMismatchWarning } = require(path.resolve(__dirname, '..', 'maestro-signal.js'));

test('warns when an agent for the channel runs under a different namespace', () => {
  const w = buildMismatchWarning({
    channel: 'GH-42',
    inboxDir: '/tmp/claude-agent-inbox',
    ownNs: '', // signaling from a global/unnamespaced shell
    sessionNames: ['proj-a/GH-42-work', 'proj-a/GH-42-listen', 'maestro-alerts'],
  });
  assert.ok(w, 'expected a warning');
  assert.match(w, /different namespace/);
  assert.match(w, /proj-a\/GH-42-work/);
  assert.match(w, /set MAESTRO_NS=proj-a/);
});

test('no warning when the matching session is in OUR namespace', () => {
  const w = buildMismatchWarning({
    channel: 'GH-42',
    inboxDir: '/tmp/claude-agent-inbox/proj-a',
    ownNs: 'proj-a',
    sessionNames: ['proj-a/GH-42-work'], // same namespace — just no -listen pane
  });
  assert.equal(w, null);
});

test('no warning when no session matches the channel', () => {
  const w = buildMismatchWarning({
    channel: 'GH-99',
    inboxDir: '/tmp/claude-agent-inbox',
    ownNs: '',
    sessionNames: ['proj-a/GH-42-work', 'unrelated'],
  });
  assert.equal(w, null);
});

test('namespaced signaler, agent in GLOBAL ns → tells operator to UNSET MAESTRO_NS', () => {
  const w = buildMismatchWarning({
    channel: 'ECHO-7',
    inboxDir: '/tmp/claude-agent-inbox/proj-b',
    ownNs: 'proj-b',
    sessionNames: ['ECHO-7-work'], // bare = global namespace ≠ proj-b
  });
  assert.ok(w);
  assert.match(w, /ECHO-7-work/);
  // The fix for a global agent is to unset — NOT "set MAESTRO_NS=<placeholder>".
  assert.match(w, /unset MAESTRO_NS/);
  assert.doesNotMatch(w, /set MAESTRO_NS=/);
  assert.doesNotMatch(w, /<their-namespace>/);
});

test('no false warning when our-namespace -work exists alongside a bare global -dev', () => {
  // Regression: a bare <ticket>-dev (un-namespaced by design) must NOT trigger a
  // mismatch when the operator's MAESTRO_NS already matches the -work session.
  const w = buildMismatchWarning({
    channel: 'GH-42',
    inboxDir: '/tmp/claude-agent-inbox/proj-a',
    ownNs: 'proj-a',
    sessionNames: ['proj-a/GH-42-work', 'GH-42-dev'],
  });
  assert.equal(w, null);
});

test('-dev sessions are ignored entirely (never the basis for a warning)', () => {
  const w = buildMismatchWarning({
    channel: 'GH-42',
    inboxDir: '/tmp/claude-agent-inbox',
    ownNs: '',
    sessionNames: ['proj-a/GH-42-dev'], // only a dev session, in another ns
  });
  assert.equal(w, null);
});

test('channel with regex-special chars is matched literally (no injection)', () => {
  const w = buildMismatchWarning({
    channel: 'GH-1.0',
    inboxDir: '/tmp/claude-agent-inbox',
    ownNs: '',
    sessionNames: ['proj-a/GH-1X0-work'], // '.' must NOT match 'X'
  });
  assert.equal(w, null);
});
