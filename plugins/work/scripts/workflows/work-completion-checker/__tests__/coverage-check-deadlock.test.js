'use strict';

/**
 * Tests for the coverage_check ↔ protect-tasks-md deadlock fixes
 * (ECHO-5139/5145/5218/5320/5350/5530/5818/5821 family):
 *   - as-authored Status values count as delivered (ECHO-5818)
 *   - fallback coverage from completion-context.json / completion.check.md
 *     degrades to a warning instead of an unrecoverable block (ECHO-5145)
 *   - a one-shot tasks.md write token is minted whenever the phase blocks
 *     with a tasks.md repair demand (ECHO-5818 preferred fix)
 *
 * Run with: node --test workflows/work-completion-checker/__tests__/coverage-check-deadlock.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const coverageCheck = require('../lib/phases/coverage_check');
const { tokenPathFor } = require('../../lib/tasks-md-write-token');

function makeTasksDir(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-deadlock-'));
  const tasksDir = path.join(root, 'ECHO-5818');
  fs.mkdirSync(tasksDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(tasksDir, name), content);
  }
  return { root, tasksDir };
}

const BRIEF_WITH_P0 = ['# Brief', '', '## Requirements', '', '- P0: must do thing', ''].join('\n');

function coverageTable(rows) {
  return [
    '# Tasks',
    '',
    '## Requirement Coverage',
    '',
    '| ID | Description | Status | Evidence |',
    '|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

test.describe('isDeliveredStatus — as-authored status values (ECHO-5818)', () => {
  const accepted = [
    'DELIVERED',
    'done',
    'Complete',
    'ok',
    '✓',
    'Covered',
    'Verified',
    'Verified N/A',
    'Respected',
    'N/A',
    'NA',
  ];
  for (const s of accepted) {
    test(`accepts "${s}"`, () => {
      assert.equal(coverageCheck.isDeliveredStatus(s), true, `"${s}" must count as delivered`);
    });
  }
  const rejected = ['PENDING', 'BLOCKED', 'in progress', 'TODO', ''];
  for (const s of rejected) {
    test(`rejects "${s}"`, () => {
      assert.equal(coverageCheck.isDeliveredStatus(s), false, `"${s}" must NOT count as delivered`);
    });
  }
});

test.describe('isDeliveredStatus — negated/partial statuses must NOT match (PR #669 review)', () => {
  const negated = [
    'Not covered',
    'not delivered',
    'Uncovered',
    'UNVERIFIED',
    'NOT VERIFIED',
    'partially covered',
    'Partial',
    'partially done',
    'no evidence — pending verification',
    'incomplete',
    'undelivered',
    'missing — verified needed',
    'never delivered',
  ];
  for (const s of negated) {
    test(`rejects "${s}"`, () => {
      assert.equal(coverageCheck.isDeliveredStatus(s), false, `"${s}" must NOT count as delivered`);
    });
  }
  // Word-boundary positives that must survive the negation hardening.
  const stillAccepted = ['Covered', 'Verified N/A', 'Delivered (see tasks.md)', 'done ✓'];
  for (const s of stillAccepted) {
    test(`still accepts "${s}"`, () => {
      assert.equal(coverageCheck.isDeliveredStatus(s), true, `"${s}" must count as delivered`);
    });
  }
});

test('coverage_check passes a split-in-tasks-authored table (Status=Covered)', () => {
  const { root, tasksDir } = makeTasksDir({
    'brief.md': BRIEF_WITH_P0,
    'tasks.md': coverageTable([
      '| R1 | must do thing | Covered | tasks.md:Task 1 |',
      '| R2 | other thing | Verified N/A | out of scope per spec |',
      '| R3 | third thing | Respected | tasks.md:Task 2 |',
    ]),
  });
  try {
    const result = coverageCheck.validate({ tasksDir });
    assert.equal(result.ok, true, `expected ok, errors: ${JSON.stringify(result.errors)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('coverage_check still blocks genuinely undelivered rows (PENDING)', () => {
  const { root, tasksDir } = makeTasksDir({
    'brief.md': BRIEF_WITH_P0,
    'tasks.md': coverageTable(['| R1 | must do thing | PENDING | |']),
  });
  try {
    const result = coverageCheck.validate({ tasksDir });
    assert.equal(result.ok, false, 'PENDING rows must still block');
    assert.match(result.errors.join('\n'), /non-DELIVERED/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fallback: completion-context.json coverage degrades block to warning (ECHO-5145)', () => {
  const { root, tasksDir } = makeTasksDir({
    'brief.md': BRIEF_WITH_P0,
    'tasks.md': '# Tasks\n\n## Task 1 — Foo\n\nNo coverage sections here.\n',
    'completion-context.json': JSON.stringify({
      requirements: [{ priority: 'P0', text: 'must do thing' }],
      coverage: [
        { id: 'R1', description: 'must do thing', status: 'DELIVERED', evidence: 'src/x.js:10' },
      ],
    }),
  });
  try {
    const result = coverageCheck.validate({ tasksDir });
    assert.equal(
      result.ok,
      true,
      `expected graceful degrade, errors: ${JSON.stringify(result.errors)}`
    );
    assert.match(
      (result.warnings || []).join('\n'),
      /requirement_coverage_fallback/,
      'must warn about the fallback source'
    );
    assert.match((result.warnings || []).join('\n'), /completion-context\.json/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fallback: completion.check.md coverage table degrades block to warning', () => {
  const { root, tasksDir } = makeTasksDir({
    'brief.md': BRIEF_WITH_P0,
    'tasks.md': '# Tasks\n\n## Task 1 — Foo\n\nNo coverage sections here.\n',
    'completion.check.md': [
      '# Completion Report',
      '',
      '## Requirement Coverage',
      '',
      '| ID | Description | Status | Evidence |',
      '|---|---|---|---|',
      '| R1 | must do thing | DELIVERED | src/x.js:10 |',
      '',
    ].join('\n'),
  });
  try {
    const result = coverageCheck.validate({ tasksDir });
    assert.equal(
      result.ok,
      true,
      `expected graceful degrade, errors: ${JSON.stringify(result.errors)}`
    );
    assert.match((result.warnings || []).join('\n'), /completion\.check\.md/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('no coverage anywhere still blocks — but mints a one-shot write token', () => {
  const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-token-'));
  const prev = process.env.CLAUDE_WRITE_TOKEN_DIR;
  process.env.CLAUDE_WRITE_TOKEN_DIR = tokenDir;
  const { root, tasksDir } = makeTasksDir({
    'brief.md': BRIEF_WITH_P0,
    'tasks.md': '# Tasks\n\n## Task 1 — Foo\n\nNo coverage sections here.\n',
  });
  try {
    const result = coverageCheck.validate({ tasksDir, ticket: 'ECHO-5818' });
    assert.equal(result.ok, false, 'must still block when no coverage source exists');
    const tp = tokenPathFor('ECHO-5818');
    assert.ok(fs.existsSync(tp), `expected minted token at ${tp}`);
    const token = JSON.parse(fs.readFileSync(tp, 'utf8'));
    assert.equal(token.ticket, 'ECHO-5818');
    assert.equal(typeof token.timestamp, 'number');
    assert.match(
      result.errors.join('\n'),
      /one-shot tasks\.md write token/i,
      'block message must tell the agent about the token'
    );
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_WRITE_TOKEN_DIR;
    else process.env.CLAUDE_WRITE_TOKEN_DIR = prev;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tokenDir, { recursive: true, force: true });
  }
});

test('no token minted when ctx.ticket is absent (unit-test contexts)', () => {
  const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-token-'));
  const prev = process.env.CLAUDE_WRITE_TOKEN_DIR;
  process.env.CLAUDE_WRITE_TOKEN_DIR = tokenDir;
  const { root, tasksDir } = makeTasksDir({
    'brief.md': BRIEF_WITH_P0,
    'tasks.md': '# Tasks\n\n## Task 1 — Foo\n\nNo coverage sections here.\n',
  });
  try {
    const result = coverageCheck.validate({ tasksDir });
    assert.equal(result.ok, false);
    assert.equal(fs.readdirSync(tokenDir).length, 0, 'no token files expected without a ticket');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_WRITE_TOKEN_DIR;
    else process.env.CLAUDE_WRITE_TOKEN_DIR = prev;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tokenDir, { recursive: true, force: true });
  }
});
