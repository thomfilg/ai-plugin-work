'use strict';

/**
 * Unit tests for lib/cortex-provider — the single shared recall-provider
 * resolver (GH-662). Precedence under test: explicit
 * `SYNAPSYS_CORTEX_RECALL_MODULE` > default cortex-bridge > disabled, with a
 * broken explicit module NEVER falling back to the bridge. Bridge fixtures
 * need `node:sqlite`, so those tests skip on Node < 22.5.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveRecall } = require('../cortex-provider');

const sqlite = (() => {
  try {
    return require('node:sqlite');
  } catch {
    return null;
  }
})();

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-provider-'));
}

/** Create a fixture cortex db (real `memories` schema) with one row. */
function makeDb(dir) {
  const file = path.join(dir, 'memory.db');
  const db = new sqlite.DatabaseSync(file);
  db.exec(
    'CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT, content_hash TEXT, ' +
      'embedding BLOB, project_id TEXT, source_session TEXT, timestamp TEXT, created_at TEXT)'
  );
  db.prepare('INSERT INTO memories (content, project_id, timestamp) VALUES (?, ?, ?)').run(
    'bridge fixture memory about rebasing',
    '',
    new Date().toISOString()
  );
  db.close();
  return file;
}

test('explicit valid module wins over an available bridge', { skip: !sqlite }, async () => {
  const dir = mkTmp();
  try {
    const dbFile = makeDb(dir);
    const modFile = path.join(dir, 'provider-valid.js');
    fs.writeFileSync(
      modFile,
      "'use strict';\nmodule.exports = { recall: (q, p) => [{ id: 'from-module', q, p }] };\n"
    );

    const out = resolveRecall({
      env: { SYNAPSYS_CORTEX_RECALL_MODULE: modFile, SYNAPSYS_CORTEX_DB: dbFile },
      home: dir,
    });
    assert.equal(out.provider, 'module');
    assert.equal(out.source, modFile);
    const results = await out.recall('rebasing', '');
    assert.equal(results[0].id, 'from-module', 'the module, not the bridge, serves recall');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit broken module → recall null; the bridge is NOT used as fallback', {
  skip: !sqlite,
}, () => {
  const dir = mkTmp();
  try {
    const dbFile = makeDb(dir); // bridge WOULD be available…
    const out = resolveRecall({
      env: {
        SYNAPSYS_CORTEX_RECALL_MODULE: path.join(dir, 'no-such-provider.js'),
        SYNAPSYS_CORTEX_DB: dbFile,
      },
      home: dir,
    });
    assert.equal(out.recall, null, 'a configured-but-broken module disables recall');
    assert.equal(out.provider, null);
    assert.equal(out.source, 'module-error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('module exporting no recall function → recall null (never the bridge)', {
  skip: !sqlite,
}, () => {
  const dir = mkTmp();
  try {
    const dbFile = makeDb(dir);
    const modFile = path.join(dir, 'provider-malformed.js');
    fs.writeFileSync(modFile, "'use strict';\nmodule.exports = { notRecall: true };\n");
    const out = resolveRecall({
      env: { SYNAPSYS_CORTEX_RECALL_MODULE: modFile, SYNAPSYS_CORTEX_DB: dbFile },
      home: dir,
    });
    assert.equal(out.recall, null);
    assert.equal(out.provider, null);
    assert.equal(out.source, 'module-error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('env unset + available bridge → the default bridge serves recall', {
  skip: !sqlite,
}, async () => {
  const dir = mkTmp();
  try {
    const dbFile = makeDb(dir);
    const out = resolveRecall({ env: { SYNAPSYS_CORTEX_DB: dbFile }, home: dir });
    assert.equal(out.provider, 'bridge');
    assert.equal(out.source, dbFile, 'source is the resolved db path');
    const results = await out.recall('rebasing', '');
    assert.equal(results.length, 1);
    assert.match(results[0].body, /rebasing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('env unset + no detectable bridge → recall null with the detect reason', () => {
  const dir = mkTmp();
  try {
    const out = resolveRecall({
      env: { SYNAPSYS_CORTEX_DB: path.join(dir, 'absent', 'memory.db') },
      home: dir,
    });
    assert.equal(out.recall, null);
    assert.equal(out.provider, null);
    assert.equal(typeof out.source, 'string');
    assert.ok(out.source.length > 0, 'source carries the human-readable detect reason');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
