'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { renderStatus, main, resolveSessionId } = require('../scripts/synapsys-recall.js');
const cortexHook = require('../lib/cortex-hook.js');
const cortexRecall = require('../lib/cortex-recall.js');
const sessionCache = require('../lib/session-cache.js');

test('renderStatus lists each query string and its result count', () => {
  const cache = {
    queries: [
      {
        query: 'GH-519',
        projectId: 'claude-plugin-work',
        results: [{ id: 'm1' }, { id: 'm2' }],
        ranAt: '2026-06-10T00:00:00.000Z',
      },
      {
        query: 'cortex recall keywords',
        projectId: 'claude-plugin-work',
        results: [{ id: 'm3' }],
        ranAt: '2026-06-10T00:00:01.000Z',
      },
    ],
  };

  const out = renderStatus(cache);
  const lines = out.split('\n').filter(Boolean);

  // One line per query record.
  assert.equal(lines.length, 2);

  // Each line shows the query string and its result count.
  assert.match(out, /GH-519/);
  assert.match(out, /\b2\b/);
  assert.match(out, /cortex recall keywords/);
  assert.match(out, /\b1\b/);
});

test('renderStatus prints a clear message when no cache exists', () => {
  assert.match(renderStatus(null), /no auto-recall this session/i);
  assert.match(renderStatus(undefined), /no auto-recall this session/i);
  assert.match(renderStatus({ queries: [] }), /no auto-recall this session/i);
});

test('renderStatus renders the READ-ONLY post-consume summary (query + count, tagged)', () => {
  const summary = {
    summary: true,
    consumedAt: '2026-06-21T00:00:00.000Z',
    queries: [
      { query: 'GH-519', count: 2 },
      { query: 'cortex recall', count: 0 },
    ],
  };
  const out = renderStatus(summary);
  assert.match(out, /GH-519 → 2 results/);
  assert.match(out, /cortex recall → 0 results/);
  assert.match(out, /already injected this session/i);
});

test('main falls back to the post-consume summary once the live cache is deleted (GH-519)', () => {
  withTmpHome((home) => {
    const prev = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-recall-fallback';
    try {
      const sessionId = resolveSessionId({});
      // SessionStart writes the live cache; the first UserPromptSubmit consumes
      // it (single-consume deletes the data cache but persists the summary).
      sessionCache.write(
        sessionId,
        {
          queries: [
            {
              query: 'GH-519',
              projectId: 'p',
              results: [
                {
                  id: 'm1',
                  savedAt: new Date().toISOString(),
                  ageDays: 1,
                  title: 'T',
                  body: 'B',
                },
              ],
              ranAt: 't',
            },
          ],
        },
        { home }
      );
      const block = cortexRecall.consumeCache(sessionId, { home, config: {} });
      assert.ok(block, 'first consume injects the recall block');
      assert.equal(sessionCache.read(sessionId, { home }), null, 'data cache is deleted');

      // `/synapsys recall` after consume must still report the recall.
      const lines = [];
      main({ home, payload: {}, log: (s) => lines.push(s) });
      const out = lines.join('\n');
      assert.match(out, /GH-519 → 1 result\b/);
      assert.match(out, /already injected this session/i);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = prev;
    }
  });
});

test('recall CLI and cortex hook resolve the SAME session id for an env-sourced id', () => {
  const prev = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'env-session-abc';
  try {
    const payload = { session_id: 'payload-should-be-overridden' };
    const cliId = resolveSessionId({ payload });
    const hookId = cortexHook.sessionIdOf(payload);
    assert.equal(cliId, 'env-session-abc');
    assert.equal(cliId, hookId);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prev;
  }
});

test('recall CLI and cortex hook resolve the SAME session id from payload.session_id', () => {
  const prev = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  try {
    const payload = { session_id: 'payload-xyz_123' };
    const cliId = resolveSessionId({ payload });
    const hookId = cortexHook.sessionIdOf(payload);
    assert.equal(cliId, 'payload-xyz_123');
    assert.equal(cliId, hookId);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prev;
  }
});

// suppressedByFireMode must resolve the effective mode from the PARSED
// `memory.fireMode` (whose default is `once`, per memory-store.parseFireMode)
// so Phase 2 cortex_query suppression matches the injection cadence in
// render-budget.decideInjection. Reading only the raw `meta.fire_mode` string
// (default '') let a memory WITHOUT explicit fire_mode re-run its inline
// cortex_query on every trigger — the two paths disagreed (cursor[bot] #...).
function withTmpHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-firemode-'));
  try {
    fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('suppressedByFireMode: memory with NO explicit fire_mode is suppressed after the first fire (parsed default once)', () => {
  withTmpHome((home) => {
    const sessionId = 'sess-default-once';
    // Mirrors a memory parsed by memory-store: fireMode defaults to 'once',
    // and the raw frontmatter (meta.fire_mode) is absent.
    const memory = { name: 'mem-a', fireMode: 'once', meta: { cortex_query: 'GH-519' } };

    // First fire: not suppressed (writes the marker).
    assert.equal(cortexHook.suppressedByFireMode(home, sessionId, memory), false);
    // Second fire in the same session: suppressed.
    assert.equal(cortexHook.suppressedByFireMode(home, sessionId, memory), true);
  });
});

test('suppressedByFireMode: memory with fire_mode: always is NOT suppressed and re-runs every time', () => {
  withTmpHome((home) => {
    const sessionId = 'sess-always';
    const memory = {
      name: 'mem-b',
      fireMode: 'always',
      meta: { fire_mode: 'always', cortex_query: 'GH-519' },
    };

    assert.equal(cortexHook.suppressedByFireMode(home, sessionId, memory), false);
    assert.equal(cortexHook.suppressedByFireMode(home, sessionId, memory), false);
    assert.equal(cortexHook.suppressedByFireMode(home, sessionId, memory), false);
  });
});

test('suppressedByFireMode: falls back to raw meta.fire_mode when parsed fireMode is absent', () => {
  withTmpHome((home) => {
    const sessionId = 'sess-raw-fallback';
    // No parsed fireMode field at all — fall back to the raw frontmatter string.
    const memory = { name: 'mem-c', meta: { fire_mode: 'once_per_session', cortex_query: 'q' } };

    assert.equal(cortexHook.suppressedByFireMode(home, sessionId, memory), false);
    assert.equal(cortexHook.suppressedByFireMode(home, sessionId, memory), true);
  });
});
