'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function withTempHome(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-rotation-'));
  const prevHome = process.env.HOME;
  const prevSessionDir = process.env.SYNAPSYS_SESSION_DIR;
  const prevDisabled = process.env.SYNAPSYS_SESSION_ROTATION_DISABLED;
  process.env.HOME = tmp;
  delete process.env.SYNAPSYS_SESSION_DIR;
  delete process.env.SYNAPSYS_SESSION_ROTATION_DISABLED;
  delete require.cache[require.resolve('../session-id-rotation')];
  const mod = require('../session-id-rotation');
  mod.__resetForTests();
  try {
    return fn(tmp, mod);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevSessionDir === undefined) delete process.env.SYNAPSYS_SESSION_DIR;
    else process.env.SYNAPSYS_SESSION_DIR = prevSessionDir;
    if (prevDisabled === undefined) delete process.env.SYNAPSYS_SESSION_ROTATION_DISABLED;
    else process.env.SYNAPSYS_SESSION_ROTATION_DISABLED = prevDisabled;
    delete require.cache[require.resolve('../session-id-rotation')];
  }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('first observation seeds the last-observed pointer without emitting a rotation event', () => {
  withTempHome((_home, mod) => {
    mod.observeRotation('session-a');
    assert.ok(fs.existsSync(mod.lastObservedFile()));
    assert.equal(readJsonl(mod.rotationsFile()).length, 0);
  });
});

test('idempotent: same id observed twice records nothing', () => {
  withTempHome((_home, mod) => {
    mod.observeRotation('session-a');
    mod.observeRotation('session-a');
    mod.observeRotation('session-a');
    assert.equal(readJsonl(mod.rotationsFile()).length, 0);
  });
});

test('distinct id observation appends a rotation event with prev/next/delta', () => {
  withTempHome((_home, mod) => {
    mod.observeRotation('session-a');
    mod.observeRotation('session-b');
    const records = readJsonl(mod.rotationsFile());
    assert.equal(records.length, 1);
    assert.equal(records[0].prevId, 'session-a');
    assert.equal(records[0].nextId, 'session-b');
    assert.ok(typeof records[0].deltaMs === 'number');
    assert.ok(records[0].deltaMs >= 0);
    assert.equal(records[0].pid, process.pid);
  });
});

test('records appear for each rotation in a chain', () => {
  withTempHome((_home, mod) => {
    mod.observeRotation('a');
    mod.observeRotation('b');
    mod.observeRotation('c');
    const records = readJsonl(mod.rotationsFile());
    assert.equal(records.length, 2);
    assert.equal(records[0].prevId, 'a');
    assert.equal(records[0].nextId, 'b');
    assert.equal(records[1].prevId, 'b');
    assert.equal(records[1].nextId, 'c');
  });
});

test('fast rotation under threshold flags fastRotation: true and warns on stderr (once per process)', () => {
  withTempHome((_home, mod) => {
    const captured = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      captured.push(String(chunk));
      return true;
    };
    try {
      mod.observeRotation('alpha-12345678');
      // Force a rapid second observation by patching readLastObserved-source.
      mod.observeRotation('beta-12345678');
      mod.observeRotation('gamma-12345678');
    } finally {
      process.stderr.write = orig;
    }
    const records = readJsonl(mod.rotationsFile());
    assert.equal(records.length, 2);
    // Both records should be flagged fast (test runs in milliseconds).
    assert.equal(records[0].fastRotation, true);
    assert.equal(records[1].fastRotation, true);
    // Warning emitted exactly once.
    const warnings = captured.filter((s) => s.includes('CLAUDE_CODE_SESSION_ID rotated'));
    assert.equal(warnings.length, 1);
  });
});

test('disabled via env var SYNAPSYS_SESSION_ROTATION_DISABLED=1 short-circuits', () => {
  withTempHome((_home, mod) => {
    process.env.SYNAPSYS_SESSION_ROTATION_DISABLED = '1';
    mod.observeRotation('session-a');
    mod.observeRotation('session-b');
    assert.equal(fs.existsSync(mod.lastObservedFile()), false);
    assert.equal(readJsonl(mod.rotationsFile()).length, 0);
  });
});

test('empty / null / non-string ids are no-ops', () => {
  withTempHome((_home, mod) => {
    mod.observeRotation('');
    mod.observeRotation(null);
    mod.observeRotation(undefined);
    mod.observeRotation(123);
    assert.equal(fs.existsSync(mod.lastObservedFile()), false);
    assert.equal(readJsonl(mod.rotationsFile()).length, 0);
  });
});

test('inject-ledger resolveSessionId integrates with rotation tracker', () => {
  withTempHome((_home, mod) => {
    const prevEnv = process.env.CLAUDE_CODE_SESSION_ID;
    try {
      delete require.cache[require.resolve('../inject-ledger')];
      process.env.CLAUDE_CODE_SESSION_ID = 'conv-1-abcd';
      const ledger = require('../inject-ledger');
      ledger.resolveSessionId({});
      process.env.CLAUDE_CODE_SESSION_ID = 'conv-2-abcd';
      ledger.resolveSessionId({});
      const records = readJsonl(mod.rotationsFile());
      assert.equal(records.length, 1);
      assert.equal(records[0].prevId, 'conv-1-abcd');
      assert.equal(records[0].nextId, 'conv-2-abcd');
    } finally {
      if (prevEnv === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = prevEnv;
      delete require.cache[require.resolve('../inject-ledger')];
    }
  });
});
