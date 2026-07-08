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
  const prevSessionEnv = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.HOME = tmp;
  delete process.env.SYNAPSYS_TELEMETRY;
  // Default: stub CLAUDE_CODE_SESSION_ID as unset so payload-only tests keep
  // exercising the payload path. Tests that exercise env-var precedence opt in
  // by setting it after withTempHome enters fn.
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete require.cache[require.resolve('../telemetry')];
  try {
    return fn(tmp);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevDisable === undefined) delete process.env.SYNAPSYS_TELEMETRY;
    else process.env.SYNAPSYS_TELEMETRY = prevDisable;
    if (prevSessionEnv === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prevSessionEnv;
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
    telemetry.recordFired(
      { name: 'demo-mem', meta: {} },
      { session_id: 'sess-1' },
      'UserPromptSubmit'
    );
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
    telemetry.recordFired(
      { name: 'mem-a', meta: {} },
      { session_id: 'sess-X' },
      'UserPromptSubmit'
    );
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
    telemetry.recordFired(
      { name: 'mem-a', meta: {} },
      { session_id: 'sess-1' },
      'UserPromptSubmit'
    );
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

// Task 2 (GH-559) R1 — recordBehaviorChanged writes JSONL line with reason+evidence
test('recordBehaviorChanged appends one JSONL line with event=behavior_changed, reason, evidence', () => {
  withTempHome((home) => {
    const telemetry = require('../telemetry');
    telemetry.recordBehaviorChanged(
      { name: 'mem-b', meta: {} },
      { session_id: 'sess-bc' },
      { reason: 'pretool-divergence', evidence: 'expected=git push got=git commit' }
    );
    const file = path.join(home, '.claude', 'synapsys', '.telemetry', 'sess-bc.jsonl');
    const rows = readJsonl(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].memory, 'mem-b');
    assert.equal(rows[0].event, 'behavior_changed');
    assert.equal(rows[0].reason, 'pretool-divergence');
    assert.equal(rows[0].evidence, 'expected=git push got=git commit');
    assert.match(rows[0].ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// Task 2 (GH-559) R8 — evidence capped at MATCH_CAP=200
test('recordBehaviorChanged caps evidence at MATCH_CAP (200 chars)', () => {
  withTempHome((home) => {
    const telemetry = require('../telemetry');
    const huge = 'e'.repeat(500);
    telemetry.recordBehaviorChanged(
      { name: 'mem-cap', meta: {} },
      { session_id: 'sess-cap' },
      { reason: 'self-report', evidence: huge }
    );
    const file = path.join(home, '.claude', 'synapsys', '.telemetry', 'sess-cap.jsonl');
    const rows = readJsonl(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].evidence.length, 200);
    assert.equal(rows[0].evidence, 'e'.repeat(200));
  });
});

// Task 2 (GH-559) R6 — isDisabled propagation
test('recordBehaviorChanged is suppressed when memory is disabled (per-memory + env)', () => {
  withTempHome((home) => {
    const telemetry = require('../telemetry');
    telemetry.recordBehaviorChanged(
      { name: 'silent', meta: { telemetry: false } },
      { session_id: 'sess-dis' },
      { reason: 'self-report', evidence: 'x' }
    );
    const file = path.join(home, '.claude', 'synapsys', '.telemetry', 'sess-dis.jsonl');
    assert.equal(fs.existsSync(file), false);

    process.env.SYNAPSYS_TELEMETRY = '0';
    telemetry.recordBehaviorChanged(
      { name: 'loud', meta: {} },
      { session_id: 'sess-dis2' },
      { reason: 'self-report', evidence: 'x' }
    );
    const file2 = path.join(home, '.claude', 'synapsys', '.telemetry', 'sess-dis2.jsonl');
    assert.equal(fs.existsSync(file2), false);
  });
});

// Task 2 (GH-559) R7 — fail-open when writeLine throws
test('recordBehaviorChanged is fail-open when fs.appendFileSync throws', () => {
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
        telemetry.recordBehaviorChanged(
          { name: 'm', meta: {} },
          { session_id: 's' },
          { reason: 'self-report', evidence: 'x' }
        );
      });
    } finally {
      fs.appendFileSync = orig;
    }
  });
});

// Task 2 (GH-559) R3 — extracted scanForSignalList works for cite + behavior getters
test('scanForSignalList returns [{memory, signal}] for cite_signals (regression)', () => {
  withTempHome(() => {
    const telemetry = require('../telemetry');
    const memories = [
      { name: 'alpha', meta: { cite_signals: ['alpha'] }, citeSignals: ['alpha'] },
      { name: 'beta', meta: { cite_signals: ['beta'] }, citeSignals: ['beta'] },
      { name: 'gamma', meta: { cite_signals: ['gamma'] }, citeSignals: ['gamma'] },
    ];
    const text = 'alpha and beta are here, no g.';
    const hits = telemetry.scanForSignalList(memories, text, (m) => m.citeSignals);
    assert.equal(hits.length, 2);
    const names = hits.map((h) => h.memory.name).sort();
    assert.deepEqual(names, ['alpha', 'beta']);
    for (const h of hits) {
      assert.equal(typeof h.signal, 'string');
    }
  });
});

test('scanForSignalList works with behavior_signals getter', () => {
  withTempHome(() => {
    const telemetry = require('../telemetry');
    const memories = [
      { name: 'mem-x', behaviorSignals: ['skipped-review'] },
      { name: 'mem-y', behaviorSignals: ['not-mentioned'] },
    ];
    const text = 'I skipped-review on this one.';
    const hits = telemetry.scanForSignalList(memories, text, (m) => m.behaviorSignals);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].memory.name, 'mem-x');
    assert.equal(hits[0].signal, 'skipped-review');
  });
});

test('scanForSignalList skips disabled memories', () => {
  withTempHome(() => {
    const telemetry = require('../telemetry');
    const memories = [
      { name: 'on', meta: {}, behaviorSignals: ['hit'] },
      { name: 'off', meta: { telemetry: false }, behaviorSignals: ['hit'] },
    ];
    const hits = telemetry.scanForSignalList(memories, 'we hit it', (m) => m.behaviorSignals);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].memory.name, 'on');
  });
});

// PR #524 cursor[bot] Medium — session_id sanitization (path traversal defense).
// After GH-583 followup: telemetry and inject-ledger share resolveFromPayload, so
// unsafe values are sha256-hashed (path-traversal still impossible — hex hash
// contains no path separators) rather than bucketed into _unknown-session. Empty/
// missing payload still falls through to _unknown-session.
test('resolveSessionId: safe ids pass, unsafe ids are sha256-hashed (no _unknown-session for non-empty)', () => {
  withTempHome(() => {
    const telemetry = require('../telemetry');
    const { hashId } = require('../session-id');
    // Allowed verbatim
    assert.equal(telemetry.resolveSessionId({ session_id: 'abc123' }), 'abc123');
    // Dot is no longer in SAFE_ID_RE — hashed instead.
    assert.equal(telemetry.resolveSessionId({ session_id: 'a-b_c.1' }), hashId('a-b_c.1'));
    // Path-traversal characters → hashed (hex output contains no '/', '\\', '..').
    assert.equal(telemetry.resolveSessionId({ session_id: '../evil' }), hashId('../evil'));
    assert.equal(telemetry.resolveSessionId({ session_id: '/etc/passwd' }), hashId('/etc/passwd'));
    assert.equal(telemetry.resolveSessionId({ session_id: 'a/b' }), hashId('a/b'));
    assert.equal(telemetry.resolveSessionId({ session_id: 'a\\b' }), hashId('a\\b'));
    assert.equal(telemetry.resolveSessionId({ session_id: '..' }), hashId('..'));
    assert.equal(telemetry.resolveSessionId({ session_id: '.hidden' }), hashId('.hidden'));
    assert.equal(
      telemetry.resolveSessionId({ session_id: 'x'.repeat(200) }),
      hashId('x'.repeat(200))
    );
    // Hashed output is filesystem-safe (32 hex chars).
    const hashed = telemetry.resolveSessionId({ session_id: '../evil' });
    assert.match(hashed, /^[0-9a-f]{32}$/);
  });
});
