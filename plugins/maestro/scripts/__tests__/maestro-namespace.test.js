// namespace.js tests (GH-622) — MAESTRO_NS isolates state/log/alert/inbox/lock
// locations and tmux session names so N conductors run unconflicted on one box.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const NS_LIB = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'namespace.js');
const STATE_LIB = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'state.js');

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

test('state markers keyed by a namespaced SESSION name round-trip (no ENOENT)', () => {
  // Regression for GH-622: per-session markers (spinner/silence/restart-loop)
  // are keyed by the FULL session name, which under MAESTRO_NS contains a "/".
  // Before flattenKey, path.join built a nested path whose parent dir didn't
  // exist and writeFileSync threw ENOENT, breaking the conduct loop.
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-state-rt-'));
  delete require.cache[require.resolve(STATE_LIB)];
  delete require.cache[require.resolve(NS_LIB)];
  process.env.MAESTRO_NS = 'proj-a';
  process.env.STATE_DIR = stateDir;
  const state = require(STATE_LIB);
  assert.doesNotThrow(() => state.write('proj-a/GH-42-work', 'spinner', { lastInterruptAt: 1 }));
  assert.deepEqual(state.read('proj-a/GH-42-work', 'spinner'), { lastInterruptAt: 1 });
  // File lands flat (cleanup's bare-id matcher relies on this), not nested.
  assert.ok(fs.existsSync(path.join(stateDir, 'GH-42-work.spinner.json')));
  assert.ok(!fs.existsSync(path.join(stateDir, 'proj-a')));
  delete require.cache[require.resolve(STATE_LIB)];
  delete process.env.STATE_DIR;
});

test('flattenKey strips the <ns>/ segment so persistence keys stay flat', () => {
  const ns = load({ MAESTRO_NS: 'proj-a' });
  // Full session names → bare filename segment (no "/" → no nested-path ENOENT).
  assert.equal(ns.flattenKey('proj-a/GH-42-work'), 'GH-42-work');
  assert.equal(ns.flattenKey('proj-a/ECHO-7-listen'), 'ECHO-7-listen');
  // Bare ids and global names are unchanged (no segment to strip).
  assert.equal(ns.flattenKey('GH-42'), 'GH-42');
  assert.equal(ns.flattenKey('GH-42-work'), 'GH-42-work');
});
