/**
 * Unit tests for the brief step module (GH-253, Task 1).
 *
 * Verifies that:
 * - The brief step never DEFERs with a "disabled" reason (toggle removed)
 * - Setting WORK_BRIEF_ENABLED=0 has no effect (step still behaves normally)
 * - Step DEFERs when brief.md already exists
 * - Step RUNs when brief.md is missing
 *
 * Run: node --test workflows/work/steps/__tests__/brief.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { STEPS } = require('../../step-registry');
const briefStep = require('../brief.js');

// ─── Test doubles ────────────────────────────────────────────────────────────

function makeCtx(overrides = {}) {
  return {
    STEPS,
    ticket: 'TEST-100',
    description: null,
    rework: false,
    safeName: 'TEST-100',
    worktreeDir: '/tmp/worktrees/my-project-TEST-100',
    tasksDir: '/tmp/tasks/TEST-100',
    t: 'TEST-100',
    path,
    fileExists: () => false,
    getDocsPrompt: () => '',
    ...overrides,
  };
}

function makeState(overrides = {}) {
  return {
    worktreeExists: true,
    hasBrief: false,
    pr: null,
    ...overrides,
  };
}

function makeAdd() {
  const entries = [];
  const add = (step, action, command, reason, extra) => {
    entries.push({ step, action, command, reason, ...(extra || {}) });
  };
  return { add, entries };
}

// ─── Suite ──────────────────────────────────────────────────────────────────

describe('brief step (GH-253)', () => {
  const originalEnv = process.env.WORK_BRIEF_ENABLED;

  beforeEach(() => {
    delete process.env.WORK_BRIEF_ENABLED;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.WORK_BRIEF_ENABLED;
    else process.env.WORK_BRIEF_ENABLED = originalEnv;
  });

  it('never DEFERs with a "disabled" reason even when WORK_BRIEF_ENABLED=0', () => {
    process.env.WORK_BRIEF_ENABLED = '0';

    const { add, entries } = makeAdd();
    briefStep(add, makeState(), makeCtx());
    assert.equal(entries.length, 1);
    const entry = entries[0];
    if (entry.action === 'DEFER') {
      assert.ok(
        !entry.reason.toLowerCase().includes('disabled'),
        `brief step must not DEFER with "disabled" reason, got: "${entry.reason}"`
      );
    }
  });

  it('does not reference WORK_BRIEF_ENABLED in source code', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'brief.js'), 'utf8');
    assert.ok(
      !source.includes('WORK_BRIEF_ENABLED'),
      'brief.js must not contain WORK_BRIEF_ENABLED'
    );
  });

  it('RUNs when brief.md is missing (hasBrief=false)', () => {

    const { add, entries } = makeAdd();
    briefStep(add, makeState({ hasBrief: false }), makeCtx());
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.brief);
    assert.equal(entries[0].action, 'RUN');
  });

  it('DEFERs when brief.md already exists (hasBrief=true)', () => {

    const { add, entries } = makeAdd();
    briefStep(add, makeState({ hasBrief: true }), makeCtx());
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.brief);
    assert.equal(entries[0].action, 'DEFER');
    assert.match(entries[0].reason.toLowerCase(), /already exists/);
  });

  it('RUNs with correct agent type and prompt when brief is missing', () => {

    const { add, entries } = makeAdd();
    briefStep(add, makeState({ hasBrief: false }), makeCtx());
    const entry = entries[0];
    assert.equal(entry.agentType, 'brief-writer');
    assert.match(entry.agentPrompt, /TEST-100/);
    assert.match(entry.agentPrompt, /brief\.md/);
  });

  it('still RUNs when WORK_BRIEF_ENABLED=0 and brief is missing', () => {
    process.env.WORK_BRIEF_ENABLED = '0';

    const { add, entries } = makeAdd();
    briefStep(add, makeState({ hasBrief: false }), makeCtx());
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, 'RUN');
  });
});
