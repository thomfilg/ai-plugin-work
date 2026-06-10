'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Load the module under test defensively. While the source does not yet
// exist (RED phase), every test fails on a plain assertion ("module not
// loadable") rather than letting a raw MODULE_NOT_FOUND stack escape — the
// latter reads as a structural/load failure, this reads as the genuine
// behavior gap the GREEN implementation must close.
function loadCache() {
  let mod;
  try {
    mod = require('../lib/session-cache');
  } catch {
    mod = null;
  }
  assert.ok(mod, 'lib/session-cache module must be loadable and export its API');
  return mod;
}

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-cache-'));
}

function cleanup(home) {
  fs.rmSync(home, { recursive: true, force: true });
}

function cacheFile(home, sessionId) {
  return path.join(home, '.claude', 'synapsys', '.cache', `${sessionId}.json`);
}

test('write -> read round-trips the same object', () => {
  const home = mkHome();
  const cache = loadCache();
  try {
    const data = { queries: [{ query: 'GH-519', results: [] }], ranAt: 123 };
    cache.write('sess-1', data, { home });
    const read = cache.read('sess-1', { home });
    assert.deepEqual(read, data);
  } finally {
    cleanup(home);
  }
});

test('write creates the cache file with mode 0o600', () => {
  const home = mkHome();
  const cache = loadCache();
  try {
    cache.write('sess-mode', { ok: true }, { home });
    const file = cacheFile(home, 'sess-mode');
    assert.ok(fs.existsSync(file), 'cache file should exist');
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0o600, got 0o${mode.toString(8)}`);
  } finally {
    cleanup(home);
  }
});

test('read returns null when the cache file is missing', () => {
  const home = mkHome();
  const cache = loadCache();
  try {
    assert.equal(cache.read('does-not-exist', { home }), null);
  } finally {
    cleanup(home);
  }
});

test('write lazily creates the .cache directory', () => {
  const home = mkHome();
  const cache = loadCache();
  try {
    const dir = path.dirname(cacheFile(home, 'x'));
    assert.ok(!fs.existsSync(dir), 'precondition: cache dir absent');
    cache.write('x', { a: 1 }, { home });
    assert.ok(fs.existsSync(dir), 'cache dir created by write');
  } finally {
    cleanup(home);
  }
});

test('delete removes the named cache file', () => {
  const home = mkHome();
  const cache = loadCache();
  try {
    cache.write('sess-del', { a: 1 }, { home });
    const file = cacheFile(home, 'sess-del');
    assert.ok(fs.existsSync(file));
    cache.delete('sess-del', { home });
    assert.ok(!fs.existsSync(file), 'file removed after delete');
  } finally {
    cleanup(home);
  }
});

test('delete does not throw when the file is absent (idempotent)', () => {
  const home = mkHome();
  const cache = loadCache();
  try {
    assert.doesNotThrow(() => cache.delete('never-written', { home }));
    cache.write('twice', { a: 1 }, { home });
    cache.delete('twice', { home });
    assert.doesNotThrow(() => cache.delete('twice', { home }));
  } finally {
    cleanup(home);
  }
});

test('pruneStale removes files older than 7 days and keeps newer ones', () => {
  const home = mkHome();
  const cache = loadCache();
  try {
    cache.write('old', { a: 1 }, { home });
    cache.write('fresh', { a: 1 }, { home });

    const now = Date.now();
    const eightDaysMs = 8 * 24 * 60 * 60 * 1000;
    const oldFile = cacheFile(home, 'old');
    const oldTime = new Date(now - eightDaysMs);
    fs.utimesSync(oldFile, oldTime, oldTime);

    cache.pruneStale({ home, now });

    assert.ok(!fs.existsSync(oldFile), 'stale file (>7d) removed');
    assert.ok(fs.existsSync(cacheFile(home, 'fresh')), 'fresh file kept');
  } finally {
    cleanup(home);
  }
});

test('pruneStale does not throw when the cache directory is missing', () => {
  const home = mkHome();
  const cache = loadCache();
  try {
    assert.doesNotThrow(() => cache.pruneStale({ home, now: Date.now() }));
  } finally {
    cleanup(home);
  }
});
