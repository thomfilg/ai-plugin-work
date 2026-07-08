/**
 * Tests for tasks-scope-gate.js (Gate C enrichment).
 *
 * Run: node --test scripts/workflows/work/lib/step-enrichments/__tests__/tasks-scope-gate.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const registerEnrichment = require('../tasks-scope-gate');

function makeRegistry() {
  const byStep = {};
  return {
    register: (step, fn) => {
      if (!byStep[step]) byStep[step] = [];
      byStep[step].push(fn);
    },
    run: (step, entry, ctx) => (byStep[step] || []).forEach((fn) => fn(entry, ctx)),
  };
}

const validTaskBody = (num, includeInScope = true, includeOutScope = true) => {
  const lines = [
    `## Task ${num} — Sample task`,
    '',
    '### Type',
    'tdd-code',
    '',
    '### Description',
    'A task.',
    '',
    '### Deliverables',
    '- [ ] 1.1 Do the thing',
    '',
    '### Acceptance Criteria',
    '- Works',
    '',
    '### Dependencies',
    'None',
    '',
  ];
  if (includeInScope) {
    lines.push('### Files in scope', `- lib/task${num}.ts`, '');
  }
  if (includeOutScope) {
    lines.push('### Files explicitly out of scope', `- lib/sibling.ts — owned by GH-100`, '');
  }
  return lines.join('\n');
};

// Parser-shaped trailing table required by the coverage-table deadlock guard
// (ECHO-5139 family). Appended to fixtures that must PASS the gate.
const coverageTail = [
  '## Requirement Coverage',
  '',
  '| ID | Description | Status | Evidence |',
  '|---|---|---|---|',
  '| R1 | sample requirement | Covered | tasks.md:Task 1 |',
  '',
].join('\n');

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsg-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeTasks(body) {
  fs.writeFileSync(path.join(tmp, 'tasks.md'), body);
}

const ctx = () => ({ tasksDir: tmp, ticket: 'GH-1', workDir: tmp, path, fs });

describe('tasks-scope-gate', () => {
  it('passes when every task has both scope sections', () => {
    writeTasks([validTaskBody(1), validTaskBody(2), coverageTail].join('\n'));
    const reg = makeRegistry();
    registerEnrichment(reg.register);
    const entry = { step: 'tasks_gate' };
    reg.run('tasks_gate', entry, ctx());
    assert.equal(entry._overrideInstruction, undefined);
  });

  it('blocks when a task is missing Files in scope', () => {
    writeTasks([validTaskBody(1, false, true), validTaskBody(2)].join('\n'));
    const reg = makeRegistry();
    registerEnrichment(reg.register);
    const entry = { step: 'tasks_gate' };
    reg.run('tasks_gate', entry, ctx());
    assert.ok(entry._overrideInstruction);
    assert.equal(entry._overrideInstruction.action, 'blocked');
    assert.match(entry._overrideInstruction.details, /Task 1/);
    assert.match(entry._overrideInstruction.details, /Files in scope/);
  });

  it('does not block when Files explicitly out of scope is empty but section exists', () => {
    // Out-of-scope section header with no items → parser returns [] → validator accepts.
    const body = [
      '## Task 1 — Sample',
      '',
      '### Type',
      'tdd-code',
      '',
      '### Files in scope',
      '- a.ts',
      '',
      '### Files explicitly out of scope',
      '',
      coverageTail,
    ].join('\n');
    writeTasks(body);
    const reg = makeRegistry();
    registerEnrichment(reg.register);
    const entry = { step: 'tasks_gate' };
    reg.run('tasks_gate', entry, ctx());
    assert.equal(entry._overrideInstruction, undefined);
  });

  it('skips silently when tasks.md does not exist', () => {
    const reg = makeRegistry();
    registerEnrichment(reg.register);
    const entry = { step: 'tasks_gate' };
    reg.run('tasks_gate', entry, ctx());
    assert.equal(entry._overrideInstruction, undefined);
  });

  it('does not stomp an existing _overrideInstruction', () => {
    writeTasks(validTaskBody(1, false, true));
    const reg = makeRegistry();
    registerEnrichment(reg.register);
    const existing = { type: 'work_instruction', action: 'blocked', reason: 'other' };
    const entry = { step: 'tasks_gate', _overrideInstruction: existing };
    reg.run('tasks_gate', entry, ctx());
    assert.equal(entry._overrideInstruction, existing);
  });

  it('aggregates errors across multiple invalid tasks', () => {
    writeTasks([validTaskBody(1, false, false), validTaskBody(2, false, true)].join('\n'));
    const reg = makeRegistry();
    registerEnrichment(reg.register);
    const entry = { step: 'tasks_gate' };
    reg.run('tasks_gate', entry, ctx());
    assert.ok(entry._overrideInstruction);
    assert.match(entry._overrideInstruction.details, /Task 1/);
    assert.match(entry._overrideInstruction.details, /Task 2/);
  });

  // ── `## Requirement Coverage` deadlock guard (ECHO-5139 family) ──

  it('blocks when tasks.md has no `## Requirement Coverage` table', () => {
    writeTasks([validTaskBody(1), validTaskBody(2)].join('\n'));
    const reg = makeRegistry();
    registerEnrichment(reg.register);
    const entry = { step: 'tasks_gate' };
    reg.run('tasks_gate', entry, ctx());
    assert.ok(entry._overrideInstruction, 'missing coverage table must block the gate');
    assert.equal(entry._overrideInstruction.action, 'blocked');
    assert.match(entry._overrideInstruction.reason, /Requirement Coverage/);
    assert.match(entry._overrideInstruction.details, /ID \| Description \| Status \| Evidence/);
  });

  it('blocks when the coverage table has the wrong column shape (ECHO-5821)', () => {
    writeTasks(
      [
        validTaskBody(1),
        '## Requirement Coverage',
        '',
        '| Requirement | Source | Covered by Task(s) |',
        '|---|---|---|',
        '| R1 | brief | Task 1 |',
        '',
      ].join('\n')
    );
    const reg = makeRegistry();
    registerEnrichment(reg.register);
    const entry = { step: 'tasks_gate' };
    reg.run('tasks_gate', entry, ctx());
    assert.ok(entry._overrideInstruction, 'wrong table shape must block the gate');
    assert.match(entry._overrideInstruction.details, /positionally/i);
  });

  it('scope-envelope blocker wins over the coverage-table blocker', () => {
    // Task missing scope sections AND no coverage table → Gate C message first
    writeTasks(validTaskBody(1, false, true));
    const reg = makeRegistry();
    registerEnrichment(reg.register);
    const entry = { step: 'tasks_gate' };
    reg.run('tasks_gate', entry, ctx());
    assert.ok(entry._overrideInstruction);
    assert.match(entry._overrideInstruction.reason, /scope envelope/);
  });
});
