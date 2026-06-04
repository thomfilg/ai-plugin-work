'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function withTempHome(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-telemetry-int-'));
  const prevHome = process.env.HOME;
  const prevDisable = process.env.SYNAPSYS_TELEMETRY;
  process.env.HOME = tmp;
  delete process.env.SYNAPSYS_TELEMETRY;
  delete require.cache[require.resolve('../telemetry')];
  try {
    return fn(tmp);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevDisable === undefined) delete process.env.SYNAPSYS_TELEMETRY;
    else process.env.SYNAPSYS_TELEMETRY = prevDisable;
    delete require.cache[require.resolve('../telemetry')];
  }
}

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// AC5 — real fs: first write seeds dir + .gitignore with *
test('integration: first recordFired creates .telemetry dir + .gitignore on real fs', () => {
  withTempHome((home) => {
    const telemetry = require('../telemetry');
    telemetry.recordFired(
      { name: 'real-mem', meta: {} },
      { session_id: 'real-sess' },
      'UserPromptSubmit'
    );
    const dir = path.join(home, '.claude', 'synapsys', '.telemetry');
    const gi = path.join(dir, '.gitignore');
    const sessFile = path.join(dir, 'real-sess.jsonl');
    assert.ok(fs.existsSync(dir));
    assert.equal(fs.readFileSync(gi, 'utf8'), '*\n');
    assert.ok(fs.existsSync(sessFile));
    const rows = readJsonl(sessFile);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event, 'fired');
  });
});

// AC4 — fail-open: real EACCES on dir (read-only) does not throw
test('integration: recordFired fail-open under EACCES on real read-only dir', () => {
  withTempHome((home) => {
    const telemetry = require('../telemetry');
    // Pre-create the dir read-only.
    const dir = path.join(home, '.claude', 'synapsys', '.telemetry');
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o500); // r-x only
    try {
      assert.doesNotThrow(() => {
        telemetry.recordFired({ name: 'm', meta: {} }, { session_id: 's' }, 'r');
      });
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });
});

// End-to-end fired + cite scan + recordCited pipeline on real fs
test('integration: fired → scanForCitations → recordCited writes both event rows', () => {
  withTempHome((home) => {
    const telemetry = require('../telemetry');
    const memory = {
      name: 'flowmem',
      meta: { cite_signals: ['flowmem'] },
    };
    telemetry.recordFired(memory, { session_id: 'flow' }, 'UserPromptSubmit');

    const responseText = 'The assistant mentioned flowmem in this reply.';
    const hits = telemetry.scanForCitations([memory], responseText);
    assert.equal(hits.length, 1);
    for (const hit of hits) {
      telemetry.recordCited(hit.memory, { session_id: 'flow' }, hit.match);
    }

    const file = path.join(home, '.claude', 'synapsys', '.telemetry', 'flow.jsonl');
    const rows = readJsonl(file);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].event, 'fired');
    assert.equal(rows[1].event, 'cited');
  });
});
