/**
 * Unit tests for the ci step module.
 *
 * Run: node --test scripts/workflows/work/steps/__tests__/ci.test.js
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
    worktreeDir: '/tmp/wt/GH-395',
    ...overrides,
  };
}

describe('ci step', () => {
  let ciStep;
  before(() => {
    ciStep = require(path.join(__dirname, '..', 'ci.js'));
  });

  it('exports a function', () => {
    assert.equal(typeof ciStep, 'function');
  });

  it('ci step emits runnable command', () => {
    const { add, entries } = makeAdd();
    ciStep(add, {}, makeCtx());
    const prompt = entries[0].agentPrompt;
    assert.ok(
      prompt.includes('cd "/tmp/wt/GH-395" && gh pr checks --watch --interval 60'),
      `expected runnable cd && gh pr checks form, got: ${prompt}`
    );
    assert.ok(
      !prompt.includes('Run in /tmp/wt/GH-395:'),
      `prompt should not contain prose preamble "Run in /tmp/wt/GH-395:", got: ${prompt}`
    );
  });

  it('ci step uses resolved worktreeDir', () => {
    const { add, entries } = makeAdd();
    ciStep(add, {}, makeCtx());
    const prompt = entries[0].agentPrompt;
    assert.ok(prompt.includes('/tmp/wt/GH-395'), 'should reference resolved worktreeDir');
    assert.ok(prompt.includes('ci-next.js'), 'should reference ci-next.js for phase advancement');
    assert.ok(
      !prompt.includes('my-project-ECHO-XXX'),
      'should not contain placeholder my-project-ECHO-XXX'
    );
  });

  it('operator runs the ci step prompt verbatim and CI is watched', () => {
    const { add, entries } = makeAdd();
    ciStep(add, {}, makeCtx());
    const prompt = entries[0].agentPrompt;
    // The prompt must be directly runnable: cd && gh pr checks --watch
    assert.match(prompt, /cd "\/tmp\/wt\/GH-395" && gh pr checks --watch --interval 60/);
    // ci-next.js call should have the ticket interpolated
    assert.ok(
      prompt.includes('GH-395'),
      'ci-next.js invocation should include the ticket id'
    );
    assert.equal(entries[0].step, STEPS.ci);
    assert.equal(entries[0].action, 'RUN');
  });
});
