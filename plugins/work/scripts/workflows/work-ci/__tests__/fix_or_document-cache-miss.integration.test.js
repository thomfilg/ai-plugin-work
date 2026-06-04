'use strict';

/**
 * Integration test wrapper for Task 3 — fix_or_document.js cache-miss branch.
 *
 * The canonical G8/G9 scenarios live in `phases.test.js`; this file declares
 * the integration scope explicitly (per task-decomposer kind_assign gate) and
 * adds focused integration-level assertions for the cache-miss branch.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fixOrDoc = require('../lib/phases/fix_or_document');

function mk(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixdoc-cm-'));
  const tasksDir = path.join(root, 'GH-395');
  fs.mkdirSync(tasksDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(tasksDir, name), content);
  }
  return { root, tasksDir };
}

test('[integration] fix_or_document rejects cache-miss with malformed (too short) rerunRunId', () => {
  const { root, tasksDir } = mk({
    'ci-status.json': JSON.stringify({ failures: [{ name: 'downstream', state: 'FAILURE' }] }),
    'ci-triage.json': JSON.stringify({
      classifications: [
        {
          name: 'downstream',
          category: 'cache-miss',
          evidence: 'downstream job failed because the cache was missing entirely',
          upstreamProducerPassed: true,
          rerunRunId: '12345',
        },
      ],
    }),
  });
  const r = fixOrDoc.validate({ tasksDir });
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /rerunRunId/.test(e)),
    `expected error mentioning rerunRunId, got: ${JSON.stringify(r.errors)}`
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('[integration] fix_or_document accepts cache-miss with 6-digit rerunRunId boundary', () => {
  const { root, tasksDir } = mk({
    'ci-status.json': JSON.stringify({ failures: [{ name: 'downstream', state: 'FAILURE' }] }),
    'ci-triage.json': JSON.stringify({
      classifications: [
        {
          name: 'downstream',
          category: 'cache-miss',
          evidence: 'cache was missing entirely; doing a full rerun',
          upstreamProducerPassed: true,
          rerunRunId: '123456',
        },
      ],
    }),
  });
  const r = fixOrDoc.validate({ tasksDir });
  assert.equal(r.ok, true, `expected ok, got errors: ${JSON.stringify(r.errors)}`);
  fs.rmSync(root, { recursive: true, force: true });
});
