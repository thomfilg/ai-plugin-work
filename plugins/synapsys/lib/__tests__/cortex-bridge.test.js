'use strict';

/**
 * Unit tests for lib/cortex-bridge — the zero-config default cortex recall
 * provider (GH-662). Fixture dbs are created with `node:sqlite`, so every test
 * that touches sqlite SKIPS cleanly on Node < 22.5 (CI runs Node 20 and 22).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bridge = require('../cortex-bridge');

/** node:sqlite when this runtime has it, else null (tests skip). */
const sqlite = (() => {
  try {
    return require('node:sqlite');
  } catch {
    return null;
  }
})();

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-bridge-'));
}

const MEMORIES_DDL =
  'CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT, content_hash TEXT, ' +
  'embedding BLOB, project_id TEXT, source_session TEXT, timestamp TEXT, created_at TEXT)';

/** Create a fixture cortex db with the real `memories` schema plus rows. */
function makeDb(file, rows = []) {
  const db = new sqlite.DatabaseSync(file);
  try {
    db.exec(MEMORIES_DDL);
    const ins = db.prepare(
      'INSERT INTO memories (content, project_id, timestamp, created_at) VALUES (?, ?, ?, ?)'
    );
    for (const r of rows) {
      ins.run(r.content, r.projectId ?? '', r.timestamp ?? new Date().toISOString(), null);
    }
  } finally {
    db.close();
  }
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

test('detect: missing db file → unavailable with the resolved path in the reason', () => {
  const dir = mkTmp();
  try {
    const missing = path.join(dir, 'nope', 'memory.db');
    const out = bridge.detect({ env: { SYNAPSYS_CORTEX_DB: missing } });
    assert.equal(out.available, false);
    // Reason differs by cause: no sqlite on this Node, else the missing path.
    if (sqlite) assert.ok(out.reason.includes(missing), `reason names the path: ${out.reason}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detect: default path is <home>/.cortex/memory.db when SYNAPSYS_CORTEX_DB is unset', () => {
  const dir = mkTmp();
  try {
    assert.equal(
      bridge.dbPath({ home: dir, env: {} }),
      path.join(dir, '.cortex', 'memory.db'),
      'dbPath falls back to the home-relative default'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detect: valid fixture db → available', { skip: !sqlite }, () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'memory.db');
    makeDb(file, [{ content: 'hello world' }]);
    const out = bridge.detect({ env: { SYNAPSYS_CORTEX_DB: file } });
    assert.deepEqual(out, { available: true, reason: 'ok' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detect: db without a memories table → unavailable', { skip: !sqlite }, () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'other.db');
    const db = new sqlite.DatabaseSync(file);
    db.exec('CREATE TABLE not_memories (id INTEGER)');
    db.close();
    const out = bridge.detect({ env: { SYNAPSYS_CORTEX_DB: file } });
    assert.equal(out.available, false);
    assert.match(out.reason, /memories table/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------------

test('recall: ranks a two-keyword match above a one-keyword match', { skip: !sqlite }, async () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'memory.db');
    makeDb(file, [
      { content: 'alpha only note', timestamp: isoDaysAgo(0) },
      { content: 'alpha beta both keywords here', timestamp: isoDaysAgo(30) },
    ]);
    const out = await bridge.recall('alpha beta', '', { env: { SYNAPSYS_CORTEX_DB: file } });
    assert.equal(out.length, 2);
    assert.match(out[0].body, /alpha beta both/, 'older two-keyword row still ranks first');
    assert.match(out[1].body, /alpha only/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recall: filters by projectId; empty projectId matches all projects', {
  skip: !sqlite,
}, async () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'memory.db');
    makeDb(file, [
      { content: 'alpha in project one', projectId: 'proj-one' },
      { content: 'alpha in project two', projectId: 'proj-two' },
    ]);
    const opts = { env: { SYNAPSYS_CORTEX_DB: file } };

    const scoped = await bridge.recall('alpha', 'proj-one', opts);
    assert.equal(scoped.length, 1);
    assert.match(scoped[0].body, /project one/);

    const all = await bridge.recall('alpha', '', opts);
    assert.equal(all.length, 2, 'empty projectId applies no project filter');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recall: LIKE wildcards in content do not over-match (escaping)', {
  skip: !sqlite,
}, async () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'memory.db');
    makeDb(file, [
      { content: 'progress at 100pct done' },
      { content: 'completely unrelated topic' },
    ]);
    const opts = { env: { SYNAPSYS_CORTEX_DB: file } };
    // Tokenizer strips symbols, so "100%" yields the keyword "100" — only the
    // row actually containing it may match, never everything.
    const out = await bridge.recall('100% milestone', '', opts);
    assert.equal(out.length, 1);
    assert.match(out[0].body, /100pct/);
    // Defense in depth: a wildcard inside a would-be token is escaped, not raw.
    assert.equal(bridge.escapeLike('50%_x\\'), '50\\%\\_x\\\\');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recall: result shape is {id, savedAt, title, body, ageDays}', { skip: !sqlite }, async () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'memory.db');
    const savedAt = isoDaysAgo(10);
    const longFirstLine = `heimdall guard blocks its own git commands ${'x'.repeat(60)}`;
    makeDb(file, [{ content: `${longFirstLine}\nsecond line body`, timestamp: savedAt }]);

    const out = await bridge.recall('heimdall guard', '', { env: { SYNAPSYS_CORTEX_DB: file } });
    assert.equal(out.length, 1);
    const r = out[0];
    assert.equal(typeof r.id, 'number');
    assert.equal(r.savedAt, savedAt, 'savedAt is the row timestamp');
    assert.equal(r.title.length, 61, 'title is the first line cut to 60 chars + ellipsis');
    assert.ok(r.title.endsWith('…'));
    assert.equal(r.body, `${longFirstLine}\nsecond line body`, 'body is the full content');
    assert.equal(r.ageDays, 10, 'ageDays is whole days since savedAt');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recall: invalid timestamp degrades to ageDays 0', { skip: !sqlite }, async () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'memory.db');
    makeDb(file, [{ content: 'alpha bad timestamp row', timestamp: 'not-a-date' }]);
    const out = await bridge.recall('alpha', '', { env: { SYNAPSYS_CORTEX_DB: file } });
    assert.equal(out.length, 1);
    assert.equal(out[0].ageDays, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recall: a query with zero usable keywords returns []', { skip: !sqlite }, async () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'memory.db');
    makeDb(file, [{ content: 'the and for with — all stopwords in here' }]);
    const opts = { env: { SYNAPSYS_CORTEX_DB: file } };
    assert.deepEqual(await bridge.recall('the and for with', '', opts), [], 'stopwords only');
    assert.deepEqual(await bridge.recall('a of %% __', '', opts), [], 'short tokens + symbols');
    assert.deepEqual(await bridge.recall('', '', opts), [], 'empty query');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recall: caps results at 5', { skip: !sqlite }, async () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'memory.db');
    const rows = [];
    for (let i = 0; i < 8; i += 1) {
      rows.push({ content: `alpha row number ${i}`, timestamp: isoDaysAgo(i) });
    }
    makeDb(file, rows);
    const out = await bridge.recall('alpha', '', { env: { SYNAPSYS_CORTEX_DB: file } });
    assert.equal(out.length, 5);
    assert.match(out[0].body, /number 0/, 'equal-hit rows order by recency');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recall: missing db / any error fails open to []', async () => {
  const out = await bridge.recall('alpha keywords', '', {
    env: { SYNAPSYS_CORTEX_DB: path.join(os.tmpdir(), 'no-such-cortex-db-662', 'memory.db') },
  });
  assert.deepEqual(out, []);
});

test('recall: returns a plain Array SYNCHRONOUSLY (not a Promise) — Phase 2 appendCortexQuery cannot await', {
  skip: !sqlite,
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-bridge-sync-'));
  try {
    const file = path.join(dir, 'memory.db');
    makeDb(file, [{ content: 'sync contract row', timestamp: isoDaysAgo(1) }]);
    const out = bridge.recall('sync contract', '', { env: { SYNAPSYS_CORTEX_DB: file } });
    assert.ok(Array.isArray(out), 'recall must return an Array, not a Promise/thenable');
    assert.equal(typeof out.then, 'undefined', 'recall return value must not be thenable');
    assert.equal(out.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
