/**
 * Tests for policies/transition-gate.js
 *
 * Run: node --test workflows/lib/hooks/policies/__tests__/transition-gate.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { evaluateTransitionGate, formatTransitionBlockMessage } = require('../transition-gate');

const baseWorkflow = {
  name: 'work',
  steps: ['plan', 'implement', 'check', 'pr'],
  softSteps: new Set(['plan']),
  commandMap: [{ tool: 'Bash', field: 'command', pattern: /^pnpm test$/, step: 'check' }],
  transitionPattern: /work\.workflow\.js\s+transition\s+(\S+)\s+(\S+)/,
  transitionHint: 'node work.workflow.js transition',
};

describe('transition-gate: evaluateTransitionGate', () => {
  it('returns allowed=true when not a transition command', () => {
    const result = evaluateTransitionGate({
      workflow: baseWorkflow,
      ticketId: 'GH-1',
      currentStep: 'check',
      transition: { isTransition: false },
      evidence: {},
    });
    assert.equal(result.blocked, false);
    assert.equal(result.skipped, true);
  });

  it('skips when targetStep is unknown to workflow', () => {
    const result = evaluateTransitionGate({
      workflow: baseWorkflow,
      ticketId: 'GH-1',
      currentStep: 'check',
      transition: { isTransition: true, ticket: 'GH-1', targetStep: 'unknown' },
      evidence: {},
    });
    assert.equal(result.blocked, false);
    assert.equal(result.skipped, true);
  });

  it('skips when transition targets a different ticket', () => {
    const result = evaluateTransitionGate({
      workflow: baseWorkflow,
      ticketId: 'GH-1',
      currentStep: 'check',
      transition: { isTransition: true, ticket: 'GH-2', targetStep: 'pr' },
      evidence: {},
    });
    assert.equal(result.blocked, false);
    assert.equal(result.skipped, true);
  });

  it('skips when current step is a soft step', () => {
    const result = evaluateTransitionGate({
      workflow: baseWorkflow,
      ticketId: 'GH-1',
      currentStep: 'plan',
      transition: { isTransition: true, ticket: 'GH-1', targetStep: 'implement' },
      evidence: {},
    });
    assert.equal(result.blocked, false);
    assert.equal(result.skipped, true);
  });

  it('allows when evidence exists for current step', () => {
    const result = evaluateTransitionGate({
      workflow: baseWorkflow,
      ticketId: 'GH-1',
      currentStep: 'check',
      transition: { isTransition: true, ticket: 'GH-1', targetStep: 'pr' },
      evidence: { check: { executed: true } },
    });
    assert.equal(result.blocked, false);
  });

  it('allows when verify() returns true', () => {
    const wf = {
      ...baseWorkflow,
      commandMap: [{ step: 'check', verify: () => true }],
    };
    const result = evaluateTransitionGate({
      workflow: wf,
      ticketId: 'GH-1',
      currentStep: 'check',
      transition: { isTransition: true, ticket: 'GH-1', targetStep: 'pr' },
      evidence: {},
    });
    assert.equal(result.blocked, false);
  });

  it('blocks when no evidence and no verifier passes', () => {
    const result = evaluateTransitionGate({
      workflow: baseWorkflow,
      ticketId: 'GH-1',
      currentStep: 'check',
      transition: {
        isTransition: true,
        ticket: 'GH-1',
        targetStep: 'pr',
        raw: 'node work.workflow.js transition GH-1 pr',
      },
      evidence: {},
    });
    assert.equal(result.blocked, true);
    assert.equal(result.currentStep, 'check');
    assert.ok(Array.isArray(result.expectedLines));
    assert.ok(result.expectedLines.length > 0);
  });
});

describe('transition-gate: formatTransitionBlockMessage', () => {
  it('includes workflow name, current step, and expected commands', () => {
    const msg = formatTransitionBlockMessage({
      workflowName: 'work',
      currentStep: 'check',
      attemptedCmd: 'foo',
      expectedLines: ['Bash.command matches /^pnpm test$/'],
    });
    assert.match(msg, /BLOCKED \[work\]/);
    assert.match(msg, /check/);
    assert.match(msg, /foo/);
    assert.match(msg, /pnpm test/);
  });
});
