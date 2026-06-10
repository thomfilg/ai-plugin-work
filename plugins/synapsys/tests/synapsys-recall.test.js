'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderStatus } = require('../scripts/synapsys-recall.js');

test('renderStatus lists each query string and its result count', () => {
  const cache = {
    queries: [
      { query: 'GH-519', projectId: 'claude-plugin-work', results: [{ id: 'm1' }, { id: 'm2' }], ranAt: '2026-06-10T00:00:00.000Z' },
      { query: 'cortex recall keywords', projectId: 'claude-plugin-work', results: [{ id: 'm3' }], ranAt: '2026-06-10T00:00:01.000Z' },
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
