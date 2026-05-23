/**
 * Unit tests for the reports step module.
 *
 * Run: node --test scripts/workflows/work/steps/__tests__/reports.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { STEPS } = require('../../step-registry');

function makeAdd() {
  const entries = [];
  const add = (step, action, command, reason, extra) => {
    entries.push({ step, action, command, reason, ...(extra || {}) });
  };
  return { add, entries };
}

function makeCtx(overrides = {}) {
  return {
    STEPS,
    ticket: 'GH-395',
    t: 'GH-395',
    tasksDir: '/tmp/tasks/GH-395',
    ...overrides,
  };
}

describe('reports step', () => {
  let reportsStep;
  before(() => {
    reportsStep = require(path.join(__dirname, '..', 'reports.js'));
  });

  it('exports a function', () => {
    assert.equal(typeof reportsStep, 'function');
  });

  it('reports step emits runnable command', () => {
    const { add, entries } = makeAdd();
    reportsStep(add, {}, makeCtx());
    assert.equal(entries[0].step, STEPS.reports);
    assert.equal(entries[0].action, 'RUN');
    const prompt = entries[0].agentPrompt;
    assert.ok(
      prompt.includes('ls "/tmp/tasks/GH-395"') || prompt.includes('cd "/tmp/tasks/GH-395"'),
      `expected runnable shell command referencing tasksDir, got: ${prompt}`
    );
    assert.ok(
      prompt.includes('*.check.md'),
      `expected *.check.md glob in runnable command, got: ${prompt}`
    );
    assert.ok(
      !prompt.includes('Verify and consolidate reports in'),
      `prompt should not contain prose preamble, got: ${prompt}`
    );
  });
});
