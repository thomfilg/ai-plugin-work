/**
 * Unit tests for the spec step module (GH-253, Task 1).
 *
 * Verifies that:
 * - The spec step never DEFERs with a "disabled" reason (toggle removed)
 * - Setting WORK_SPEC_ENABLED=0 has no effect
 * - The briefRef logic no longer depends on WORK_BRIEF_ENABLED
 * - Step DEFERs when spec.md already exists
 * - Step RUNs when spec.md is missing
 *
 * Run: node --test workflows/work/steps/__tests__/spec.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { STEPS } = require('../../step-registry');
const specStep = require('../spec.js');

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
    hasSpec: false,
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

describe('spec step (GH-253)', () => {
  const originalSpecEnv = process.env.WORK_SPEC_ENABLED;
  const originalBriefEnv = process.env.WORK_BRIEF_ENABLED;

  beforeEach(() => {
    delete process.env.WORK_SPEC_ENABLED;
    delete process.env.WORK_BRIEF_ENABLED;
  });

  afterEach(() => {
    if (originalSpecEnv === undefined) delete process.env.WORK_SPEC_ENABLED;
    else process.env.WORK_SPEC_ENABLED = originalSpecEnv;
    if (originalBriefEnv === undefined) delete process.env.WORK_BRIEF_ENABLED;
    else process.env.WORK_BRIEF_ENABLED = originalBriefEnv;
  });

  it('never DEFERs with a "disabled" reason even when WORK_SPEC_ENABLED=0', () => {
    process.env.WORK_SPEC_ENABLED = '0';

    const { add, entries } = makeAdd();
    specStep(add, makeState(), makeCtx());
    assert.equal(entries.length, 1);
    const entry = entries[0];
    if (entry.action === 'DEFER') {
      assert.ok(
        !entry.reason.toLowerCase().includes('disabled'),
        `spec step must not DEFER with "disabled" reason, got: "${entry.reason}"`
      );
    }
  });

  it('does not reference WORK_SPEC_ENABLED in source code', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'spec.js'), 'utf8');
    assert.ok(
      !source.includes('WORK_SPEC_ENABLED'),
      'spec.js must not contain WORK_SPEC_ENABLED'
    );
  });

  it('does not reference WORK_BRIEF_ENABLED in source code', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'spec.js'), 'utf8');
    assert.ok(
      !source.includes('WORK_BRIEF_ENABLED'),
      'spec.js must not contain WORK_BRIEF_ENABLED'
    );
  });

  it('RUNs when spec.md is missing (hasSpec=false)', () => {

    const { add, entries } = makeAdd();
    specStep(add, makeState({ hasSpec: false }), makeCtx());
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.spec);
    assert.equal(entries[0].action, 'RUN');
  });

  it('DEFERs when spec.md already exists (hasSpec=true)', () => {

    const { add, entries } = makeAdd();
    specStep(add, makeState({ hasSpec: true }), makeCtx());
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.spec);
    assert.equal(entries[0].action, 'DEFER');
    assert.match(entries[0].reason.toLowerCase(), /already exists/);
  });

  it('includes briefRef when brief.md file exists on disk', () => {

    const { add, entries } = makeAdd();
    const ctx = makeCtx({ fileExists: () => true });
    specStep(add, makeState({ hasSpec: false }), ctx);
    assert.match(entries[0].agentPrompt, /Read the product brief/);
  });

  it('includes briefRef when brief.md does not exist but hasBrief is false (will be generated)', () => {

    const { add, entries } = makeAdd();
    const ctx = makeCtx({ fileExists: () => false });
    specStep(add, makeState({ hasSpec: false, hasBrief: false }), ctx);
    assert.match(entries[0].agentPrompt, /brief\.md/);
  });

  it('omits briefRef when hasBrief=true and brief.md does not exist on disk', () => {
    const { add, entries } = makeAdd();
    const ctx = makeCtx({ fileExists: () => false });
    specStep(add, makeState({ hasSpec: false, hasBrief: true }), ctx);
    assert.doesNotMatch(entries[0].agentPrompt, /Read the product brief/);
  });

  it('still RUNs when WORK_SPEC_ENABLED=0 and spec is missing', () => {
    process.env.WORK_SPEC_ENABLED = '0';

    const { add, entries } = makeAdd();
    specStep(add, makeState({ hasSpec: false }), makeCtx());
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, 'RUN');
  });

  it('RUNs with correct agent type', () => {

    const { add, entries } = makeAdd();
    specStep(add, makeState({ hasSpec: false }), makeCtx());
    assert.equal(entries[0].agentType, 'spec-writer');
  });
});
