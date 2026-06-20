'use strict';

// GH-519 review ("Demoted memories still run recall"): the Phase 2 inline
// cortex recall (and its once-per-session fire-marker side effect) must run
// ONLY for memories actually rendered in full — never for a memory the budget
// pass demotes to a reminder, whose full body (with recall) the user never
// sees. renderMatchedMemories now appends the cortex block lazily in
// emitEntries, after demoteToFit has decided each entry's finalKind.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { renderMatchedMemories } = require('../render-budget');

function makeMemory(name, body) {
  return {
    store: { kind: 'project' },
    name,
    description: `desc ${name}`,
    inject: 'full',
    body,
    file: `/tmp/${name}.md`,
    fireMode: 'once',
    meta: { cortex_query: `query-${name}` },
  };
}

test('renderMatchedMemories: a budget-demoted memory does NOT run its inline cortex recall', () => {
  const prevHome = process.env.HOME;
  const prevBudget = process.env.SYNAPSYS_INJECT_BUDGET;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-demote-recall-'));

  // Two demotable memories (> SKIP_DEMOTION_BELOW = 2000 chars). A tight budget
  // keeps the first full and demotes the second to a reminder.
  const big = 'x'.repeat(2500);
  const matched = [makeMemory('mem-full', big), makeMemory('mem-demoted', big)];

  const recallCalls = [];
  const cortexCtx = {
    recall: (query, projectId) => {
      recallCalls.push({ query, projectId });
      return [];
    },
    projectId: 'proj-demote',
    config: {},
    home,
    sessionId: 'sess-demote-recall',
    enabled: true,
  };

  try {
    process.env.HOME = home;
    process.env.SYNAPSYS_INJECT_BUDGET = '3000';

    const body = renderMatchedMemories(matched, 'sess-demote-recall', cortexCtx);

    assert.equal(recallCalls.length, 1, 'inline recall ran for exactly one memory (the full one)');
    assert.equal(
      recallCalls[0].query,
      'query-mem-full',
      'recall ran for the memory rendered in full'
    );
    assert.ok(
      !recallCalls.some((c) => c.query === 'query-mem-demoted'),
      'the demoted memory never ran its inline recall'
    );

    // And its once-per-session fire marker was never written (no burned fire).
    const cacheDir = path.join(home, '.claude', 'synapsys', '.cache');
    const markers = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [];
    assert.ok(
      !markers.some((f) => f.includes('mem-demoted')),
      'no fire marker was burned for the demoted memory'
    );
    assert.ok(typeof body === 'string' && body.length > 0, 'still produced injection output');
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevBudget === undefined) delete process.env.SYNAPSYS_INJECT_BUDGET;
    else process.env.SYNAPSYS_INJECT_BUDGET = prevBudget;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
