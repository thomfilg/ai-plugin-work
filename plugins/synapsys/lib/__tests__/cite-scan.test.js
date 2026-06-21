'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function withTempHome(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-cite-scan-unit-'));
  const prevHome = process.env.HOME;
  const prevDisable = process.env.SYNAPSYS_TELEMETRY;
  const prevSessionEnv = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.HOME = tmp;
  delete process.env.SYNAPSYS_TELEMETRY;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete require.cache[require.resolve('../telemetry')];
  delete require.cache[require.resolve('../cite-scan')];
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
    delete require.cache[require.resolve('../cite-scan')];
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

// 3.1.1 — parseSignalsList recovers entries from YAML-block-list frontmatter
// for behavior_signals (new generalized helper).
test('parseSignalsList recovers behavior_signals YAML-block-list', () => {
  const { parseSignalsList } = require('../cite-scan');
  const fm = [
    'name: demo',
    'behavior_signals:',
    '  - switching-branch',
    '  - rebasing',
    'other_key: x',
  ].join('\n');
  const got = parseSignalsList(fm, 'behavior_signals');
  assert.deepEqual(got, ['switching-branch', 'rebasing']);
});

// 3.1.1 — parseSignalsList still works for cite_signals (regression).
test('parseSignalsList recovers cite_signals YAML-block-list (regression)', () => {
  const { parseSignalsList } = require('../cite-scan');
  const fm = ['name: demo', 'cite_signals:', '  - alpha', '  - beta'].join('\n');
  const got = parseSignalsList(fm, 'cite_signals');
  assert.deepEqual(got, ['alpha', 'beta']);
});

// 3.1.1 — recoverSignals(memory, {key, field}) idempotently populates the
// targeted field array on the memory.
test('recoverSignals populates targeted field array idempotently', () => {
  withTempHome((home) => {
    const dir = fs.mkdtempSync(path.join(home, 'mems-'));
    const memFile = path.join(dir, 'm.md');
    fs.writeFileSync(
      memFile,
      ['---', 'name: m', 'behavior_signals:', '  - foo', '  - bar', '---', 'body'].join('\n')
    );
    const { recoverSignals } = require('../cite-scan');
    const mem = { name: 'm', file: memFile, meta: {}, behaviorSignals: [] };
    const got = recoverSignals(mem, { key: 'behavior_signals', field: 'behaviorSignals' });
    assert.deepEqual(got.behaviorSignals, ['foo', 'bar']);
    // Idempotent — when already populated, return memory unchanged.
    const got2 = recoverSignals(got, { key: 'behavior_signals', field: 'behaviorSignals' });
    assert.deepEqual(got2.behaviorSignals, ['foo', 'bar']);
  });
});

// 3.1.1 — runBehaviorScan emits exactly one event per matching memory.
test('runBehaviorScan emits recordBehaviorChanged once per matched memory', () => {
  withTempHome((home) => {
    const cs = require('../cite-scan');
    const telemetry = require('../telemetry');
    const memories = [
      { name: 'mem-a', meta: {}, behaviorSignals: ['switching-branch'] },
      { name: 'mem-b', meta: {}, behaviorSignals: ['unrelated'] },
    ];
    const payload = {
      session_id: 'sess-x',
      response: 'I am switching-branch right now',
    };
    cs.runBehaviorScan(payload, memories);
    const file = path.join(telemetry.telemetryDir(), 'sess-x.jsonl');
    const events = readJsonl(file).filter((e) => e.event === 'behavior_changed');
    assert.equal(events.length, 1);
    assert.equal(events[0].memory, 'mem-a');
    assert.equal(events[0].reason, 'self-report');
    assert.equal(events[0].evidence, 'switching-branch');
  });
});

// 3.1.1 / AC6 — empty/absent behaviorSignals → zero events; no auto-extract.
test('runBehaviorScan does not auto-extract when behaviorSignals is absent', () => {
  withTempHome((home) => {
    const cs = require('../cite-scan');
    const telemetry = require('../telemetry');
    const memories = [
      { name: 'mem-noauto', meta: {}, behaviorSignals: [] },
    ];
    const payload = {
      session_id: 'sess-y',
      response: 'mem-noauto appears literally in this response text',
    };
    cs.runBehaviorScan(payload, memories);
    const file = path.join(telemetry.telemetryDir(), 'sess-y.jsonl');
    const events = readJsonl(file).filter((e) => e.event === 'behavior_changed');
    assert.equal(events.length, 0);
  });
});

// 3.1.1 / AC8 — telemetry:false memory → zero behavior_changed events.
test('runBehaviorScan honors per-memory telemetry:false (AC8)', () => {
  withTempHome((home) => {
    const cs = require('../cite-scan');
    const telemetry = require('../telemetry');
    const memories = [
      {
        name: 'mem-off',
        meta: { telemetry: false },
        behaviorSignals: ['matchme'],
      },
    ];
    const payload = { session_id: 'sess-z', response: 'matchme is here' };
    cs.runBehaviorScan(payload, memories);
    const file = path.join(telemetry.telemetryDir(), 'sess-z.jsonl');
    const events = readJsonl(file).filter((e) => e.event === 'behavior_changed');
    assert.equal(events.length, 0);
  });
});

// 3.1.1 — Multiple signals from same memory still produce only one event.
test('runBehaviorScan dedupes multiple matched signals per memory to one event', () => {
  withTempHome((home) => {
    const cs = require('../cite-scan');
    const telemetry = require('../telemetry');
    const memories = [
      {
        name: 'mem-multi',
        meta: {},
        behaviorSignals: ['sig-one', 'sig-two', 'sig-three'],
      },
    ];
    const payload = {
      session_id: 'sess-m',
      response: 'sig-one and sig-two and sig-three all show up',
    };
    cs.runBehaviorScan(payload, memories);
    const file = path.join(telemetry.telemetryDir(), 'sess-m.jsonl');
    const events = readJsonl(file).filter((e) => e.event === 'behavior_changed');
    assert.equal(events.length, 1);
    assert.equal(events[0].memory, 'mem-multi');
  });
});
