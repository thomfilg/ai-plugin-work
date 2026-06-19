// namespace.js tests (GH-622) — MAESTRO_NS isolates state/log/alert/inbox/lock
// locations and tmux session names so N conductors run unconflicted on one box.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const NS_LIB = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'namespace.js');

// Reload with a fresh env so each case sees its own MAESTRO_NS / overrides.
function load(env = {}) {
  delete require.cache[require.resolve(NS_LIB)];
  for (const k of [
    'MAESTRO_NS',
    'STATE_DIR',
    'LOG_FILE',
    'ALERT_FILE',
    'ALERT_SESSION',
    'MAESTRO_INBOX_DIR',
  ]) {
    delete process.env[k];
  }
  Object.assign(process.env, env);
  return require(NS_LIB);
}

test('unset MAESTRO_NS → historical global defaults (back-compat)', () => {
  const ns = load();
  assert.equal(ns.ns(), '');
  assert.equal(ns.sessionSeg(), '');
  assert.equal(ns.stateDir(), path.join(os.homedir(), '.cache', 'maestro-conduct'));
  assert.equal(ns.logFile(), '/tmp/maestro-conduct.log');
  assert.equal(ns.alertFile(), '/tmp/maestro-alerts.jsonl');
  assert.equal(ns.alertSession(), 'maestro-alerts');
  assert.equal(ns.inboxDir(), '/tmp/claude-agent-inbox');
  assert.equal(ns.sessionName('GH-42', 'work'), 'GH-42-work');
});

test('MAESTRO_NS=proj-a → every resource gets the namespace segment', () => {
  const ns = load({ MAESTRO_NS: 'proj-a' });
  assert.equal(ns.ns(), 'proj-a');
  assert.equal(ns.sessionSeg(), 'proj-a/');
  assert.equal(ns.stateDir(), path.join(os.homedir(), '.cache', 'maestro-conduct', 'proj-a'));
  assert.equal(ns.logFile(), '/tmp/maestro-conduct-proj-a.log');
  assert.equal(ns.alertFile(), '/tmp/maestro-alerts-proj-a.jsonl');
  assert.equal(ns.alertSession(), 'maestro-alerts-proj-a');
  assert.equal(ns.inboxDir(), '/tmp/claude-agent-inbox/proj-a');
  assert.equal(ns.lockFile(), path.join(ns.stateDir(), 'conductor.lock'));
  assert.equal(ns.sessionName('GH-42', 'work'), 'proj-a/GH-42-work');
});

test('explicit per-resource env vars win over NS-derived defaults', () => {
  const ns = load({
    MAESTRO_NS: 'proj-a',
    STATE_DIR: '/custom/state',
    LOG_FILE: '/custom/log',
    ALERT_SESSION: 'my-alerts',
    MAESTRO_INBOX_DIR: '/custom/inbox',
  });
  assert.equal(ns.stateDir(), '/custom/state');
  assert.equal(ns.logFile(), '/custom/log');
  assert.equal(ns.alertSession(), 'my-alerts');
  assert.equal(ns.inboxDir(), '/custom/inbox');
  // lockFile follows the (overridden) state dir
  assert.equal(ns.lockFile(), path.join('/custom/state', 'conductor.lock'));
});

test('malformed MAESTRO_NS fails open to global (no slash/dot/space injection)', () => {
  for (const bad of ['a/b', 'a.b', 'a b', '', '   ']) {
    const ns = load({ MAESTRO_NS: bad });
    assert.equal(ns.ns(), '', `"${bad}" should collapse to global`);
    assert.equal(ns.sessionName('GH-1', 'work'), 'GH-1-work');
  }
});

test('ticketIdFor strips both NS segment and suffix', () => {
  const ns = load({ MAESTRO_NS: 'proj-a' });
  const ALT = 'work|dev|listen';
  assert.equal(ns.ticketIdFor('proj-a/GH-42-work', ALT), 'GH-42');
  assert.equal(ns.ticketIdFor('proj-a/ECHO-7-listen', ALT), 'ECHO-7');
  // global names (no segment) still parse
  assert.equal(ns.ticketIdFor('GH-42-dev', ALT), 'GH-42');
});

test('defaultSessionPattern only matches sessions inside the namespace', () => {
  const ns = load({ MAESTRO_NS: 'proj-a' });
  const re = ns.defaultSessionPattern('GH', 'work|dev|listen');
  assert.ok(re.test('proj-a/GH-42-work'));
  assert.ok(re.test('proj-a/GH-7-listen'));
  assert.ok(!re.test('GH-42-work'), 'global session must NOT match a namespaced pattern');
  assert.ok(!re.test('proj-b/GH-42-work'), 'other namespace must not match');
});

test('global defaultSessionPattern matches bare names but not namespaced ones', () => {
  const ns = load();
  const re = ns.defaultSessionPattern('GH', 'work|dev|listen');
  assert.ok(re.test('GH-42-work'));
  assert.ok(!re.test('proj-a/GH-42-work'));
});
