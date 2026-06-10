'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Load the module under test defensively. While the source does not yet
// exist (RED phase), every test fails on a plain assertion ("module not
// loadable") rather than letting a raw MODULE_NOT_FOUND stack escape — the
// latter reads as a structural/load failure, this reads as the genuine
// behavior gap the GREEN implementation must close.
function loadBg() {
  let mod;
  try {
    mod = require('../scripts/synapsys-cortex-recall-bg');
  } catch {
    mod = null;
  }
  assert.ok(mod, 'scripts/synapsys-cortex-recall-bg module must be loadable and export its API');
  return mod;
}

/**
 * Build a stub session-cache that records the last write so tests can assert
 * the persisted record shape without touching the filesystem.
 */
function stubCache() {
  const calls = [];
  return {
    calls,
    write(sessionId, data, opts) {
      calls.push({ sessionId, data, opts });
    },
  };
}

// ---------------------------------------------------------------------------
// 7.1 runBackground — two recall calls + single cache record
// ---------------------------------------------------------------------------

test('runBackground: invokes recallFn once per query (ticket + keyword)', async () => {
  const { runBackground } = loadBg();
  const cache = stubCache();
  const seen = [];
  const recallFn = async (query) => {
    seen.push(query);
    return [{ id: 'm1', savedAt: '2026-01-01T00:00:00.000Z', title: 't', body: 'b', ageDays: 1 }];
  };

  await runBackground({
    queries: ['GH-519', 'cortex recall background'],
    projectId: 'claude-plugin-work',
    sessionId: 'sess-1',
    recallFn,
    cache,
  });

  assert.deepEqual(seen, ['GH-519', 'cortex recall background']);
});

test('runBackground: writes exactly one cache record with both query entries', async () => {
  const { runBackground } = loadBg();
  const cache = stubCache();
  const results1 = [{ id: 'm1', savedAt: '2026-01-01T00:00:00.000Z', title: 't1', body: 'b1', ageDays: 1 }];
  const results2 = [{ id: 'm2', savedAt: '2026-01-02T00:00:00.000Z', title: 't2', body: 'b2', ageDays: 2 }];
  const byQuery = { 'GH-519': results1, keyword: results2 };
  const recallFn = async (query) => byQuery[query];

  await runBackground({
    queries: ['GH-519', 'keyword'],
    projectId: 'proj-x',
    sessionId: 'sess-2',
    recallFn,
    cache,
  });

  assert.equal(cache.calls.length, 1, 'writes exactly one cache record');
  const { sessionId, data } = cache.calls[0];
  assert.equal(sessionId, 'sess-2');
  assert.ok(Array.isArray(data.queries), 'record.queries is an array');
  assert.equal(data.queries.length, 2, 'one entry per query');

  const [q1, q2] = data.queries;
  assert.equal(q1.query, 'GH-519');
  assert.equal(q1.projectId, 'proj-x');
  assert.deepEqual(q1.results, results1);
  assert.equal(typeof q1.ranAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(q1.ranAt)), 'ranAt is an ISO timestamp');

  assert.equal(q2.query, 'keyword');
  assert.deepEqual(q2.results, results2);
});

test('runBackground: hard-caps recall calls at two queries (R15)', async () => {
  const { runBackground } = loadBg();
  const cache = stubCache();
  let calls = 0;
  const recallFn = async () => {
    calls += 1;
    return [];
  };

  await runBackground({
    queries: ['q1', 'q2', 'q3', 'q4'],
    projectId: 'p',
    sessionId: 'sess-3',
    recallFn,
    cache,
  });

  assert.equal(calls, 2, 'at most two recall calls regardless of query count');
  assert.equal(cache.calls[0].data.queries.length, 2, 'record holds at most two entries');
});

test('runBackground: a throwing recallFn still writes a record without crashing', async () => {
  const { runBackground } = loadBg();
  const cache = stubCache();
  const recallFn = async () => {
    throw new Error('cortex unavailable');
  };

  await assert.doesNotReject(() =>
    runBackground({
      queries: ['GH-519', 'keyword'],
      projectId: 'proj-y',
      sessionId: 'sess-4',
      recallFn,
      cache,
    }),
  );

  assert.equal(cache.calls.length, 1, 'a record is still written when recall throws');
  const { data } = cache.calls[0];
  assert.equal(data.queries.length, 2, 'one (empty/marker) entry per query');
  for (const entry of data.queries) {
    assert.equal(entry.projectId, 'proj-y');
    assert.deepEqual(entry.results, [], 'failed query degrades to empty results');
    assert.equal(typeof entry.ranAt, 'string');
  }
});

// ---------------------------------------------------------------------------
// CLI surface — module exposes a testable main()
// ---------------------------------------------------------------------------

test('synapsys-cortex-recall-bg exposes runBackground and main', () => {
  const mod = loadBg();
  assert.equal(typeof mod.runBackground, 'function', 'exports runBackground');
  assert.equal(typeof mod.main, 'function', 'exports a CLI main()');
});
