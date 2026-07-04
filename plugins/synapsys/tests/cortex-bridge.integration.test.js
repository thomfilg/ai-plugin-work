'use strict';

/**
 * Integration tests for GH-662 — the zero-config default cortex bridge wired
 * through the dispatcher. Drives `hooks/synapsys.js` as a subprocess exactly
 * like tests/cortex-recall.integration.test.js:
 *
 *   - SessionStart with NO SYNAPSYS_CORTEX_RECALL_MODULE but a detectable
 *     cortex db (SYNAPSYS_CORTEX_DB → fixture) schedules Phase 1: the baseline
 *     session-cache appears. (Skips on Node < 22.5 — the bridge needs
 *     node:sqlite.)
 *   - SessionStart with no module AND no db produces ZERO cortex side effects
 *     (no baseline cache) — the pre-bridge default behavior is preserved.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'synapsys.js');

const sqlite = (() => {
  try {
    return require('node:sqlite');
  } catch {
    return null;
  }
})();

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-bridge-it-'));
}

function cleanup(dir) {
  // Detached recall jobs may still be writing at teardown (see the GH-519
  // integration suite) — retry so rmSync survives the readdir/rmdir race.
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

function cacheFilePath(home, sessionId) {
  return path.join(home, '.claude', 'synapsys', '.cache', `${sessionId}.json`);
}

/** Create a fixture cortex db (real `memories` schema) under `dir`. */
function makeDb(dir) {
  const file = path.join(dir, 'memory.db');
  const db = new sqlite.DatabaseSync(file);
  db.exec(
    'CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT, content_hash TEXT, ' +
      'embedding BLOB, project_id TEXT, source_session TEXT, timestamp TEXT, created_at TEXT)'
  );
  db.prepare('INSERT INTO memories (content, project_id, timestamp) VALUES (?, ?, ?)').run(
    'maestro cortex recall bridge fixture',
    'claude-plugin-work',
    new Date().toISOString()
  );
  db.close();
  return file;
}

function runHook(event, payload, { home, env = {} } = {}) {
  return spawnSync(process.execPath, [HOOK, event], {
    input: JSON.stringify(payload || {}),
    encoding: 'utf8',
    cwd: (payload && payload.cwd) || os.tmpdir(),
    env: { PATH: process.env.PATH, HOME: home, ...env },
  });
}

/** Poll (no sleep) for the session-cache file; null if it never appears. */
function waitForCache(home, sessionId, attempts = 200) {
  const file = cacheFilePath(home, sessionId);
  for (let i = 0; i < attempts; i += 1) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      for (let spin = 0; spin < 50000; spin += 1) {
        /* spin */
      }
    }
  }
  return null;
}

test('SessionStart with a detectable cortex db (no env module) schedules Phase 1 via the bridge', {
  skip: !sqlite,
}, () => {
  const home = mkHome();
  const sessionId = `sess-${process.pid}-${Date.now()}-bridge`;
  try {
    const dbFile = makeDb(home);
    const res = runHook(
      'SessionStart',
      { session_id: sessionId, cwd: home },
      {
        home,
        env: {
          // NO SYNAPSYS_CORTEX_RECALL_MODULE — the bridge is the provider.
          SYNAPSYS_CORTEX_DB: dbFile,
          SYNAPSYS_CORTEX_TICKET: 'GH-662',
          SYNAPSYS_CORTEX_PROJECT: 'claude-plugin-work',
          SYNAPSYS_CORTEX_KEYWORDS: 'maestro cortex recall',
          SYNAPSYS_NO_SETUP_HINT: '1',
        },
      }
    );
    assert.equal(res.status, 0, 'SessionStart exits 0');

    const record = waitForCache(home, sessionId);
    assert.ok(record, 'the baseline session-cache is written (recall scheduled)');
    assert.ok(Array.isArray(record.queries), 'cache record has a queries array');
    assert.equal(record.queries.length, 2, 'both queries scheduled (ticket + keywords)');
    const queryStrings = record.queries.map((q) => q.query);
    assert.ok(queryStrings.includes('GH-662'), 'ticket query scheduled');
  } finally {
    cleanup(home);
  }
});

test('SessionStart with no module and no cortex db has zero cortex side effects', () => {
  const home = mkHome();
  const sessionId = `sess-${process.pid}-${Date.now()}-nodb`;
  try {
    const res = runHook(
      'SessionStart',
      { session_id: sessionId, cwd: home },
      {
        home,
        env: {
          // No module env, and the db override points nowhere — the bridge is
          // undetectable, so Phase 1 must schedule nothing at all.
          SYNAPSYS_CORTEX_DB: path.join(home, 'absent', 'memory.db'),
          SYNAPSYS_CORTEX_TICKET: 'GH-662',
          SYNAPSYS_CORTEX_KEYWORDS: 'maestro cortex recall',
          SYNAPSYS_NO_SETUP_HINT: '1',
        },
      }
    );
    assert.equal(res.status, 0, 'SessionStart still exits 0');
    assert.equal(waitForCache(home, sessionId, 30), null, 'no baseline cache file is written');
    assert.ok(
      !fs.existsSync(path.join(home, '.claude', 'synapsys', '.cache')) ||
        fs.readdirSync(path.join(home, '.claude', 'synapsys', '.cache')).length === 0,
      'no cortex cache side effects at all'
    );
  } finally {
    cleanup(home);
  }
});
