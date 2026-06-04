'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function withTempHome(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-telemetry-unit-'));
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

// AC5 — First write seeds the telemetry .gitignore
test('first recordFired write seeds .telemetry/ dir and .gitignore with *', () => {
  withTempHome((home) => {
    const telemetry = require('../telemetry');
    telemetry.recordFired({ name: 'demo-mem', meta: {} }, { session_id: 'sess-1' }, 'UserPromptSubmit');
    const dir = path.join(home, '.claude', 'synapsys', '.telemetry');
    const gi = path.join(dir, '.gitignore');
    assert.ok(fs.existsSync(dir));
    assert.ok(fs.existsSync(gi));
    assert.equal(fs.readFileSync(gi, 'utf8'), '*\n');
  });
});

// R1 — JSONL line shape with ISO ts + reason
test('recordFired writes one JSONL line with ts, memory, event=fired, reason', () => {
  withTempHome((home) => {
    const telemetry = require('../telemetry');
    telemetry.recordFired({ name: 'mem-a', meta: {} }, { session_id: 'sess-X' }, 'UserPromptSubmit');
    const file = path.join(home, '.claude', 'synapsys', '.telemetry', 'sess-X.jsonl');
    const rows = readJsonl(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].memory, 'mem-a');
    assert.equal(rows[0].event, 'fired');
    assert.equal(rows[0].reason, 'UserPromptSubmit');
    assert.match(rows[0].ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// AC2 — SYNAPSYS_TELEMETRY=0 suppresses all writes
test('SYNAPSYS_TELEMETRY=0 suppresses recordFired writes', () => {
  withTempHome((home) => {
    process.env.SYNAPSYS_TELEMETRY = '0';
    const telemetry = require('../telemetry');
    telemetry.recordFired({ name: 'mem-a', meta: {} }, { session_id: 'sess-1' }, 'UserPromptSubmit');
    const file = path.join(home, '.claude', 'synapsys', '.telemetry', 'sess-1.jsonl');
    assert.equal(fs.existsSync(file), false);
  });
});

// AC3 — per-memory telemetry:false suppresses for that memory only
test('per-memory telemetry:false skips only that memory', () => {
  withTempHome((home) => {
    const telemetry = require('../telemetry');
    telemetry.recordFired({ name: 'silent', meta: { telemetry: false } }, { session_id: 's' }, 'r');
    telemetry.recordFired({ name: 'loud', meta: {} }, { session_id: 's' }, 'r');
    const file = path.join(home, '.claude', 'synapsys', '.telemetry', 's.jsonl');
    const rows = readJsonl(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].memory, 'loud');
  });
});

// AC4 — fail-open under unwritable dir (mock fs.appendFileSync throw)
test('recordFired is fail-open when fs.appendFileSync throws', () => {
  withTempHome(() => {
    const telemetry = require('../telemetry');
    const orig = fs.appendFileSync;
    fs.appendFileSync = () => {
      const e = new Error('EACCES');
      e.code = 'EACCES';
      throw e;
    };
    try {
      assert.doesNotThrow(() => {
        telemetry.recordFired({ name: 'm', meta: {} }, { session_id: 's' }, 'r');
      });
    } finally {
      fs.appendFileSync = orig;
    }
  });
});

// isDisabled unit
test('isDisabled returns true for env var and per-memory flag', () => {
  withTempHome(() => {
    const telemetry = require('../telemetry');
    assert.equal(telemetry.isDisabled({ name: 'a', meta: {} }), false);
    assert.equal(telemetry.isDisabled({ name: 'a', meta: { telemetry: false } }), true);
    process.env.SYNAPSYS_TELEMETRY = '0';
    assert.equal(telemetry.isDisabled({ name: 'a', meta: {} }), true);
  });
});

// AC7 — cite_signals wins over auto-extraction
test('extractSignals returns declared cite_signals when non-empty', () => {
  withTempHome(() => {
    const telemetry = require('../telemetry');
    const memory = {
      name: 'mem-1',
      meta: { cite_signals: ['flagA', 'flagB'] },
      body: '## Heading\n`autoIdent`',
    };
    const sigs = telemetry.extractSignals(memory);
    assert.deepEqual(sigs.sort(), ['flagA', 'flagB'].sort());
  });
});

// AC8 — auto-extracted signals when cite_signals absent
test('extractSignals auto-extracts backticked identifiers, first H2/H3 heading, and memory name', () => {
  withTempHome(() => {
    const telemetry = require('../telemetry');
    const memory = {
      name: 'mem-auto',
      meta: {},
      body: '## My Heading Text\nUse `doThing` and `xy`.\n```\n`shouldSkip`\n```',
    };
    const sigs = telemetry.extractSignals(memory);
    assert.ok(sigs.includes('mem-auto'));
    assert.ok(sigs.includes('doThing'));
    assert.ok(sigs.includes('xy'));
    assert.ok(sigs.includes('My Heading Text'));
    assert.ok(!sigs.includes('shouldSkip'), 'must skip code-fence backticks');
  });
});

// AC9 — missing session_id → _unknown-session.jsonl; reason carries pid+start token
test('resolveSessionId falls back to _unknown-session; recordFired reason has pid+start token', () => {
  withTempHome((home) => {
    const telemetry = require('../telemetry');
    assert.equal(telemetry.resolveSessionId({}), '_unknown-session');
    assert.equal(telemetry.resolveSessionId({ session_id: 'abc' }), 'abc');
    telemetry.recordFired({ name: 'm', meta: {} }, {}, 'UserPromptSubmit');
    const file = path.join(home, '.claude', 'synapsys', '.telemetry', '_unknown-session.jsonl');
    const rows = readJsonl(file);
    assert.equal(rows.length, 1);
    assert.match(rows[0].reason, new RegExp(`${process.pid}-\\d+`));
  });
});

// R2 — scanForCitations dedupe + match cap
test('scanForCitations dedupes per memory and caps match at 200 chars', () => {
  withTempHome(() => {
    const telemetry = require('../telemetry');
    const memories = [
      { name: 'alpha', meta: { cite_signals: ['alpha'] } },
      { name: 'beta', meta: { cite_signals: ['beta'] } },
    ];
    const text = 'alpha shows up. alpha again. beta also here.';
    const hits = telemetry.scanForCitations(memories, text);
    assert.equal(hits.length, 2);
    const names = hits.map((h) => h.memory.name).sort();
    assert.deepEqual(names, ['alpha', 'beta']);

    const longText = 'x'.repeat(500) + 'alpha' + 'y'.repeat(500);
    const hits2 = telemetry.scanForCitations([memories[0]], longText);
    assert.equal(hits2.length, 1);
    assert.ok(hits2[0].match.length <= 200);
  });
});

// recordCited writes JSONL line
test('recordCited writes a cited JSONL line with match field', () => {
  withTempHome((home) => {
    const telemetry = require('../telemetry');
    telemetry.recordCited({ name: 'mem-c', meta: {} }, { session_id: 's2' }, 'alpha-match');
    const file = path.join(home, '.claude', 'synapsys', '.telemetry', 's2.jsonl');
    const rows = readJsonl(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event, 'cited');
    assert.equal(rows[0].memory, 'mem-c');
    assert.equal(rows[0].match, 'alpha-match');
  });
});

// telemetryDir returns correct path
test('telemetryDir returns ~/.claude/synapsys/.telemetry', () => {
  withTempHome((home) => {
    const telemetry = require('../telemetry');
    assert.equal(telemetry.telemetryDir(), path.join(home, '.claude', 'synapsys', '.telemetry'));
  });
});

// PR #524 cursor[bot] Low — isDisabled must honor top-level memory.telemetry
test('isDisabled honors top-level memory.telemetry === false (memory-store normalized field)', () => {
  withTempHome(() => {
    const telemetry = require('../telemetry');
    assert.equal(telemetry.isDisabled({ name: 'm', telemetry: false }), true);
    assert.equal(telemetry.isDisabled({ name: 'm', telemetry: true }), false);
    assert.equal(telemetry.isDisabled({ name: 'm' }), false);
    // meta fallback still works
    assert.equal(telemetry.isDisabled({ name: 'm', meta: { telemetry: false } }), true);
  });
});

// PR #524 cursor[bot] Medium — extractSignals must honor top-level memory.citeSignals
test('extractSignals honors top-level memory.citeSignals (scalar normalized to array by memory-store)', () => {
  withTempHome(() => {
    const telemetry = require('../telemetry');
    // Scalar in YAML becomes a one-element array on top-level via memory-store.
    const memScalar = { name: 'm', citeSignals: ['solo'], body: 'unused', meta: {} };
    assert.deepEqual(telemetry.extractSignals(memScalar), ['solo']);
    // Array form
    const memArr = { name: 'm', citeSignals: ['a', 'b'], body: 'unused', meta: {} };
    assert.deepEqual(telemetry.extractSignals(memArr), ['a', 'b']);
    // meta fallback still works when top-level absent
    const memMeta = { name: 'm', body: 'unused', meta: { cite_signals: ['c'] } };
    assert.deepEqual(telemetry.extractSignals(memMeta), ['c']);
  });
});

// PR #524 cursor[bot] Medium — session_id sanitization (path traversal defense)
test('resolveSessionId rejects unsafe values (path separators, dotdot, absolute)', () => {
  withTempHome(() => {
    const telemetry = require('../telemetry');
    // Allowed
    assert.equal(telemetry.resolveSessionId({ session_id: 'abc123' }), 'abc123');
    assert.equal(telemetry.resolveSessionId({ session_id: 'a-b_c.1' }), 'a-b_c.1');
    // Disallowed — fall back to _unknown-session
    assert.equal(telemetry.resolveSessionId({ session_id: '../evil' }), '_unknown-session');
    assert.equal(telemetry.resolveSessionId({ session_id: '/etc/passwd' }), '_unknown-session');
    assert.equal(telemetry.resolveSessionId({ session_id: 'a/b' }), '_unknown-session');
    assert.equal(telemetry.resolveSessionId({ session_id: 'a\\b' }), '_unknown-session');
    assert.equal(telemetry.resolveSessionId({ session_id: '..' }), '_unknown-session');
    assert.equal(telemetry.resolveSessionId({ session_id: '.hidden' }), '_unknown-session');
    assert.equal(telemetry.resolveSessionId({ session_id: 'x'.repeat(200) }), '_unknown-session');
  });
});
