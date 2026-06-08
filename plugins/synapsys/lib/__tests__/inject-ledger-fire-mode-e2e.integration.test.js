'use strict';

/**
 * Integration tests for the GH-583 behavior-table scenarios:
 *   (1) first prompt in a new Claude Code session writes the env-keyed ledger
 *   (2) /clear rotates CLAUDE_CODE_SESSION_ID -> new ledger file, fresh count
 *   (3) new Claude Code session in same cwd ignores stale .current + stale
 *       per-session ledger file
 *   (4) gcStaleLedgers still removes stale *.json files (7-day cutoff) while
 *       preserving the .current non-json publish file (C2/C4)
 *
 * Drives recordInjection / loadLedger / gcStaleLedgers directly under an
 * isolated HOME tmpdir + stubbed CLAUDE_CODE_SESSION_ID — no dispatcher
 * subprocess.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENV_KEY = 'CLAUDE_CODE_SESSION_ID';

function makeTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-ledger-e2e-'));
}

function sessionDir(home) {
  return path.join(home, '.claude', 'synapsys', '.session');
}

function loadFreshLedgerModule() {
  const modPath = require.resolve('../inject-ledger');
  delete require.cache[modPath];
  return require('../inject-ledger');
}

/**
 * Local test-only helper: stub HOME + CLAUDE_CODE_SESSION_ID for a single
 * call, reload the ledger module so module-level caches honor the stubs,
 * then restore. Symmetric to withHomeAndEnv in inject-ledger-session-env.test.js
 * but scoped to the e2e harness.
 */
function withSession(home, envValue, fn) {
  const prevHome = process.env.HOME;
  const hadEnv = Object.prototype.hasOwnProperty.call(process.env, ENV_KEY);
  const prevEnv = process.env[ENV_KEY];
  process.env.HOME = home;
  if (envValue === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = envValue;
  }
  try {
    return fn(loadFreshLedgerModule());
  } finally {
    process.env.HOME = prevHome;
    if (hadEnv) {
      process.env[ENV_KEY] = prevEnv;
    } else {
      delete process.env[ENV_KEY];
    }
    const modPath = require.resolve('../inject-ledger');
    delete require.cache[modPath];
  }
}

test('@e2e scenario 1: first prompt in a fresh CLAUDE_CODE_SESSION_ID writes <sessionDir>/<env-id>.json with injectedCount 1, lastFullInjectAt 1', () => {
  const home = makeTmpHome();
  withSession(home, 'session-fresh-1', (ledger) => {
    const sid = ledger.resolveSessionId({});
    assert.equal(sid, 'session-fresh-1');
    ledger.recordInjection(sid, 'policy-a', { full: true });

    const expectedPath = path.join(sessionDir(home), 'session-fresh-1.json');
    assert.equal(fs.existsSync(expectedPath), true, 'env-keyed ledger file must exist');

    const loaded = ledger.loadLedger(sid);
    assert.equal(loaded.memories['policy-a'].injectedCount, 1);
    assert.equal(loaded.memories['policy-a'].lastFullInjectAt, 1);
  });
});

test('@e2e scenario 2: /clear rotates CLAUDE_CODE_SESSION_ID -> a new ledger file is written with fresh injectedCount: 1 (not 2)', () => {
  const home = makeTmpHome();

  // First session: record one injection under "session-pre-clear"
  withSession(home, 'session-pre-clear', (ledger) => {
    const sid = ledger.resolveSessionId({});
    assert.equal(sid, 'session-pre-clear');
    ledger.recordInjection(sid, 'policy-a', { full: true });
  });

  const preLedgerPath = path.join(sessionDir(home), 'session-pre-clear.json');
  assert.equal(fs.existsSync(preLedgerPath), true);

  // /clear rotation: env-var becomes "session-post-clear"
  withSession(home, 'session-post-clear', (ledger) => {
    const sid = ledger.resolveSessionId({});
    assert.equal(sid, 'session-post-clear');
    ledger.recordInjection(sid, 'policy-a', { full: true });

    const postLedgerPath = path.join(sessionDir(home), 'session-post-clear.json');
    assert.equal(fs.existsSync(postLedgerPath), true, 'rotated env id must get its own ledger file');
    assert.notEqual(postLedgerPath, preLedgerPath, 'paths must be distinct');

    const postLoaded = ledger.loadLedger(sid);
    assert.equal(postLoaded.memories['policy-a'].injectedCount, 1, 'fresh ledger -> count 1, not 2');
    assert.equal(postLoaded.memories['policy-a'].lastFullInjectAt, 1);

    // Pre-clear ledger is independent and still shows its own count
    const preLoaded = ledger.loadLedger('session-pre-clear');
    assert.equal(preLoaded.memories['policy-a'].injectedCount, 1);
  });
});

test('@e2e scenario 3: stale .current + stale per-session ledger do NOT carry over to a new env-derived session id', () => {
  const home = makeTmpHome();
  const dir = sessionDir(home);
  fs.mkdirSync(dir, { recursive: true });

  // Seed a stale ledger and a stale .current
  const staleLedger = {
    createdAt: new Date().toISOString(),
    sessionId: 'old-session',
    memories: { 'policy-a': { injectedCount: 1, lastFullInjectAt: 1 } },
  };
  fs.writeFileSync(path.join(dir, 'old-session.json'), JSON.stringify(staleLedger));
  fs.writeFileSync(path.join(dir, '.current'), 'old-session');

  withSession(home, 'new-session', (ledger) => {
    const sid = ledger.resolveSessionId({});
    assert.equal(sid, 'new-session', 'env var must override stale .current');

    // Fresh ledger for the new session
    const freshBefore = ledger.loadLedger(sid);
    assert.deepEqual(freshBefore.memories, {}, 'new session ledger must start empty');

    ledger.recordInjection(sid, 'policy-a', { full: true });

    const newPath = path.join(dir, 'new-session.json');
    assert.equal(fs.existsSync(newPath), true);

    const newLoaded = ledger.loadLedger(sid);
    assert.equal(newLoaded.memories['policy-a'].injectedCount, 1);

    // Old ledger is left untouched (GC will clean it up later)
    const oldRaw = fs.readFileSync(path.join(dir, 'old-session.json'), 'utf8');
    const oldParsed = JSON.parse(oldRaw);
    assert.equal(oldParsed.memories['policy-a'].injectedCount, 1, 'old ledger untouched');
  });
});

test('@e2e scenario 4: gcStaleLedgers removes *.json older than 7 days, preserves fresh *.json AND the .current non-json file', () => {
  const home = makeTmpHome();
  const dir = sessionDir(home);
  fs.mkdirSync(dir, { recursive: true });

  const oldPath = path.join(dir, 'old-session.json');
  const freshPath = path.join(dir, 'fresh-session.json');
  const currentPath = path.join(dir, '.current');

  fs.writeFileSync(oldPath, JSON.stringify({ memories: {} }));
  fs.writeFileSync(freshPath, JSON.stringify({ memories: {} }));
  fs.writeFileSync(currentPath, 'some-session-id');

  // Backdate old ledger mtime 10 days
  const tenDaysAgo = Date.now() - 10 * 24 * 3600 * 1000;
  fs.utimesSync(oldPath, tenDaysAgo / 1000, tenDaysAgo / 1000);

  withSession(home, undefined, (ledger) => {
    ledger.gcStaleLedgers({ maxAgeMs: 7 * 24 * 3600 * 1000 });

    assert.equal(fs.existsSync(oldPath), false, 'stale *.json must be removed');
    assert.equal(fs.existsSync(freshPath), true, 'fresh *.json must be preserved');
    assert.equal(fs.existsSync(currentPath), true, '.current (non-*.json) must be preserved');
  });
});
