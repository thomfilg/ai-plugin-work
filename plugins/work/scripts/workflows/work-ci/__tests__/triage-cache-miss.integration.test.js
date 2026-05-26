'use strict';

/**
 * Integration test wrapper for Task 1 — triage.js cache-miss category.
 *
 * The canonical G5/G6 scenarios live in `phases.test.js`; this file declares
 * the integration scope explicitly (per task-decomposer kind_assign gate) and
 * adds focused integration-level assertions for the cache-miss branch.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const triage = require('../lib/phases/triage');

function mk(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-cm-'));
  const tasksDir = path.join(root, 'GH-395');
  fs.mkdirSync(tasksDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(tasksDir, name), content);
  }
  return { root, tasksDir };
}

test('[integration] triage cache-miss with upstreamProducerPassed=false still validates structurally', () => {
  const { root, tasksDir } = mk({
    'ci-status.json': JSON.stringify({ failures: [{ name: 'downstream', state: 'FAILURE' }] }),
    'ci-triage.json': JSON.stringify({
      classifications: [
        {
          name: 'downstream',
          category: 'cache-miss',
          evidence: 'upstream producer also failed; cache never written',
          upstreamProducerPassed: false,
        },
      ],
    }),
  });
  const r = triage.validate({ tasksDir });
  // Field is present (boolean false), so triage layer must accept it.
  // Routing happens later in classifyCacheMiss (Task 2).
  assert.equal(r.ok, true, `expected ok, got errors: ${JSON.stringify(r.errors)}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('[integration] triage rejects cache-miss when upstreamProducerPassed is a non-boolean', () => {
  const { root, tasksDir } = mk({
    'ci-status.json': JSON.stringify({ failures: [{ name: 'downstream', state: 'FAILURE' }] }),
    'ci-triage.json': JSON.stringify({
      classifications: [
        {
          name: 'downstream',
          category: 'cache-miss',
          evidence: 'downstream failed because cache missing entirely',
          upstreamProducerPassed: 'yes',
        },
      ],
    }),
  });
  const r = triage.validate({ tasksDir });
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /upstreamProducerPassed/.test(e)),
    `expected error mentioning upstreamProducerPassed, got: ${JSON.stringify(r.errors)}`
  );
  fs.rmSync(root, { recursive: true, force: true });
});
