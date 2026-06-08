'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENV_KEY = 'CLAUDE_CODE_SESSION_ID';

function makeTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-ledger-env-'));
}

function withHomeAndEnv(home, envValue, fn) {
  const prevHome = process.env.HOME;
  const hadEnv = Object.prototype.hasOwnProperty.call(process.env, ENV_KEY);
  const prevEnv = process.env[ENV_KEY];
  process.env.HOME = home;
  if (envValue === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = envValue;
  }
  const modPath = require.resolve('../inject-ledger');
  delete require.cache[modPath];
  try {
    const mod = require('../inject-ledger');
    return fn(mod);
  } finally {
    process.env.HOME = prevHome;
    if (hadEnv) {
      process.env[ENV_KEY] = prevEnv;
    } else {
      delete process.env[ENV_KEY];
    }
    delete require.cache[require.resolve('../inject-ledger')];
  }
}

function sessionDir(home) {
  return path.join(home, '.claude', 'synapsys', '.session');
}

test('(a) safe env id is returned verbatim and ledger file lives under <HOME>/.claude/synapsys/.session/<id>.json', () => {
  const home = makeTmpHome();
  withHomeAndEnv(home, 'env-session-safe_123', (ledger) => {
    const sid = ledger.resolveSessionId({});
    assert.equal(sid, 'env-session-safe_123');
    ledger.recordInjection(sid, 'mem-x', { full: true });
    const expected = path.join(sessionDir(home), 'env-session-safe_123.json');
    assert.equal(fs.existsSync(expected), true, 'ledger file should be at env-derived path');
  });
});

test('(b) unsafe env id ("../evil/path") is sha256-hashed; no ".." segment lands on disk', () => {
  const home = makeTmpHome();
  withHomeAndEnv(home, '../evil/path', (ledger) => {
    const sid = ledger.resolveSessionId({});
    assert.notEqual(sid, '../evil/path');
    assert.match(sid, /^[A-Za-z0-9_-]+$/);
    ledger.recordInjection(sid, 'mem-x', { full: true });
    const dir = sessionDir(home);
    const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    for (const name of entries) {
      assert.equal(name.includes('..'), false, `disk entry ${name} must not contain ".."`);
      assert.equal(name.includes('/'), false, `disk entry ${name} must not contain "/"`);
    }
    assert.ok(entries.some((n) => n === `${sid}.json`), 'hashed-id ledger file should exist');
  });
});

test('(c) env-var rotation between two resolveSessionId calls produces two distinct ledger files with independent contents', () => {
  const home = makeTmpHome();
  withHomeAndEnv(home, 'env-rot-A', (ledger) => {
    const idA = ledger.resolveSessionId({});
    assert.equal(idA, 'env-rot-A');
    ledger.recordInjection(idA, 'mem', { full: true });
    const a = ledger.loadLedger(idA);
    assert.equal(a.memories.mem.injectedCount, 1);
  });
  withHomeAndEnv(home, 'env-rot-B', (ledger) => {
    const idB = ledger.resolveSessionId({});
    assert.equal(idB, 'env-rot-B');
    const b = ledger.loadLedger(idB);
    assert.deepEqual(b.memories, {}, 'rotated session must start fresh (no inherited counts)');
    ledger.recordInjection(idB, 'mem', { full: true });
    const after = ledger.loadLedger(idB);
    assert.equal(after.memories.mem.injectedCount, 1);
  });
  const dir = sessionDir(home);
  assert.equal(fs.existsSync(path.join(dir, 'env-rot-A.json')), true);
  assert.equal(fs.existsSync(path.join(dir, 'env-rot-B.json')), true);
});

test('(d) stale .current does NOT override a present env var', () => {
  const home = makeTmpHome();
  const dir = sessionDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.current'), 'stale-current-id');
  withHomeAndEnv(home, 'env-wins', (ledger) => {
    const sid = ledger.resolveSessionId({});
    assert.equal(sid, 'env-wins', 'env var must beat stale .current');
  });
});

test('(e) env var beats payload.session_id', () => {
  const home = makeTmpHome();
  withHomeAndEnv(home, 'env-priority', (ledger) => {
    const sid = ledger.resolveSessionId({ session_id: 'payload-id' });
    assert.equal(sid, 'env-priority');
  });
});

test('(f) empty-string env var is treated as absent (falls through to payload)', () => {
  const home = makeTmpHome();
  withHomeAndEnv(home, '', (ledger) => {
    const sid = ledger.resolveSessionId({ session_id: 'payload-fallthrough' });
    assert.equal(sid, 'payload-fallthrough');
  });
});

test('(g) back-compat: env var unset and no payload → .current still wins', () => {
  const home = makeTmpHome();
  const dir = sessionDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.current'), 'persisted-current');
  withHomeAndEnv(home, undefined, (ledger) => {
    const sid = ledger.resolveSessionId({});
    assert.equal(sid, 'persisted-current');
  });
});

// --- Task 2: resolveSessionIdWithSource tagged export ---

test('(h) resolveSessionIdWithSource tags source="env" when env var resolves', () => {
  const home = makeTmpHome();
  withHomeAndEnv(home, 'env-tagged', (ledger) => {
    assert.equal(typeof ledger.resolveSessionIdWithSource, 'function',
      'resolveSessionIdWithSource must be exported');
    const result = ledger.resolveSessionIdWithSource({ session_id: 'payload-id' });
    assert.equal(result.sessionId, 'env-tagged');
    assert.equal(result.source, 'env');
  });
});

test('(i) resolveSessionIdWithSource tags source="payload" when only payload resolves', () => {
  const home = makeTmpHome();
  withHomeAndEnv(home, undefined, (ledger) => {
    assert.equal(typeof ledger.resolveSessionIdWithSource, 'function',
      'resolveSessionIdWithSource must be exported');
    const result = ledger.resolveSessionIdWithSource({ session_id: 'payload-only' });
    assert.equal(result.sessionId, 'payload-only');
    assert.equal(result.source, 'payload');
  });
});

test('(j) resolveSessionIdWithSource tags source="current" when only .current resolves', () => {
  const home = makeTmpHome();
  const dir = sessionDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.current'), 'current-only-id');
  withHomeAndEnv(home, undefined, (ledger) => {
    assert.equal(typeof ledger.resolveSessionIdWithSource, 'function',
      'resolveSessionIdWithSource must be exported');
    const result = ledger.resolveSessionIdWithSource({});
    assert.equal(result.sessionId, 'current-only-id');
    assert.equal(result.source, 'current');
  });
});

test('(k) resolveSessionIdWithSource tags source="fallback" when only sha1(cwd+processStartTime) leg fires', () => {
  const home = makeTmpHome();
  withHomeAndEnv(home, undefined, (ledger) => {
    assert.equal(typeof ledger.resolveSessionIdWithSource, 'function',
      'resolveSessionIdWithSource must be exported');
    const result = ledger.resolveSessionIdWithSource({});
    assert.equal(typeof result.sessionId, 'string');
    assert.ok(result.sessionId.length > 0);
    assert.equal(result.source, 'fallback');
  });
});
