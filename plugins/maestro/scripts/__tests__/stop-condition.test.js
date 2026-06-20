// stop-condition.js — deterministic oracle evaluation + kill/rotate on exit 0.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MOD = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'stop-condition.js');

function load() {
  delete require.cache[MOD];
  return require(MOD);
}

const eligible = () => true;
const ctx = { session: 'GH-1-work', ticket: 'GH-1', worktree: '/tmp' };

function stubActions() {
  const calls = [];
  return {
    calls,
    freeStopConditionSlot(args) {
      calls.push(args);
      return true;
    },
  };
}

test('no oracle → no-op (never calls freeStopConditionSlot)', () => {
  const sc = load();
  const actions = stubActions();
  const r = sc.maybeStopOnOracle({
    ctx,
    actions,
    manifest: { stopOracleForTask: () => null },
    restartEligible: eligible,
  });
  assert.equal(r, false);
  assert.equal(actions.calls.length, 0);
});

test('oracle exit 0 → frees the slot', () => {
  const sc = load();
  const actions = stubActions();
  const r = sc.maybeStopOnOracle({
    ctx,
    actions,
    manifest: { stopOracleForTask: () => 'exit 0' },
    restartEligible: eligible,
  });
  assert.equal(r, true);
  assert.equal(actions.calls.length, 1);
  assert.equal(actions.calls[0].ticket, 'GH-1');
});

test('oracle exit 1 → not done, no kill', () => {
  const sc = load();
  const actions = stubActions();
  const r = sc.maybeStopOnOracle({
    ctx,
    actions,
    manifest: { stopOracleForTask: () => 'exit 1' },
    restartEligible: eligible,
  });
  assert.equal(r, false);
  assert.equal(actions.calls.length, 0);
});

test('oracle sees $TICKET in env (deterministic, no interpolation)', () => {
  const sc = load();
  const actions = stubActions();
  // Exit 0 only when the env var equals the ticket — proves env injection.
  const r = sc.maybeStopOnOracle({
    ctx,
    actions,
    manifest: { stopOracleForTask: () => '[ "$TICKET" = "GH-1" ]' },
    restartEligible: eligible,
  });
  assert.equal(r, true);
  assert.equal(actions.calls.length, 1);
});

test('timeout → fail-safe, treated as not done', () => {
  process.env.ORACLE_TIMEOUT_MS = '150';
  const sc = load();
  const actions = stubActions();
  const r = sc.maybeStopOnOracle({
    ctx,
    actions,
    manifest: { stopOracleForTask: () => 'sleep 5' },
    restartEligible: eligible,
  });
  delete process.env.ORACLE_TIMEOUT_MS;
  assert.equal(r, false);
  assert.equal(actions.calls.length, 0);
});

test('non-work / ineligible session → never evaluated', () => {
  const sc = load();
  const actions = stubActions();
  let oracleAsked = false;
  const r = sc.maybeStopOnOracle({
    ctx: { session: 'GH-1-listen', ticket: 'GH-1', worktree: '/tmp' },
    actions,
    manifest: {
      stopOracleForTask() {
        oracleAsked = true;
        return 'exit 0';
      },
    },
    restartEligible: (s) => s.endsWith('-work'),
  });
  assert.equal(r, false);
  assert.equal(oracleAsked, false);
  assert.equal(actions.calls.length, 0);
});
