/**
 * Tests for policies/step-gate.js
 *
 * Run: node --test workflows/lib/hooks/policies/__tests__/step-gate.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { evaluateStepGate, formatStepBlockMessage, getCurrentStep } = require('../step-gate');

describe('step-gate: getCurrentStep', () => {
  it('returns null when state has no stepStatus', () => {
    assert.equal(getCurrentStep(null, ['a', 'b']), null);
  });

  it('returns the in_progress step', () => {
    const state = { stepStatus: { a: 'pending', b: 'in_progress', c: 'pending' } };
    assert.equal(getCurrentStep(state, ['a', 'b', 'c']), 'b');
  });

  it('returns first when multiple are in_progress', () => {
    const state = { stepStatus: { a: 'in_progress', b: 'in_progress' } };
    assert.equal(getCurrentStep(state, ['a', 'b']), 'a');
  });

  it('returns null when none in_progress', () => {
    assert.equal(getCurrentStep({ stepStatus: { a: 'pending' } }, ['a']), null);
  });
});

describe('step-gate: evaluateStepGate', () => {
  it('returns blocked=false when matchedStep equals currentStep', () => {
    const r = evaluateStepGate({
      workflowName: 'work',
      matchedStep: 'check',
      currentStep: 'check',
      toolInput: { command: 'pnpm test' },
      checkAgents: new Set(),
      checkStateActive: false,
    });
    assert.equal(r.blocked, false);
  });

  it('returns blocked=true when matchedStep != currentStep', () => {
    const r = evaluateStepGate({
      workflowName: 'work',
      matchedStep: 'pr',
      currentStep: 'check',
      toolInput: { command: 'pnpm pr-cmd' },
      checkAgents: new Set(),
      checkStateActive: false,
    });
    assert.equal(r.blocked, true);
    assert.equal(r.matchedStep, 'pr');
    assert.equal(r.currentStep, 'check');
  });

  it('allows /check agent bypass for /work workflow when /check is active', () => {
    const r = evaluateStepGate({
      workflowName: 'work',
      matchedStep: 'pr',
      currentStep: 'check',
      toolInput: { subagent_type: 'quality-checker' },
      checkAgents: new Set(['quality-checker']),
      checkStateActive: true,
    });
    assert.equal(r.blocked, false);
  });

  it('does NOT bypass when /check is not active', () => {
    const r = evaluateStepGate({
      workflowName: 'work',
      matchedStep: 'pr',
      currentStep: 'check',
      toolInput: { subagent_type: 'quality-checker' },
      checkAgents: new Set(['quality-checker']),
      checkStateActive: false,
    });
    assert.equal(r.blocked, true);
  });

  it('does NOT bypass for non-/work workflows', () => {
    const r = evaluateStepGate({
      workflowName: 'work-pr',
      matchedStep: 'review',
      currentStep: 'create',
      toolInput: { subagent_type: 'quality-checker' },
      checkAgents: new Set(['quality-checker']),
      checkStateActive: true,
    });
    assert.equal(r.blocked, true);
  });
});

describe('step-gate: formatStepBlockMessage', () => {
  it('returns a message with workflow, command desc, and transition hint', () => {
    const msg = formatStepBlockMessage({
      workflowName: 'work',
      matchedStep: 'pr',
      currentStep: 'check',
      cmdDesc: 'pnpm pr-cmd',
      transitionHint: 'node work-orchestrator.js transition',
      ticketId: 'GH-1',
    });
    assert.match(msg, /BLOCKED \[work\]/);
    assert.match(msg, /pnpm pr-cmd/);
    assert.match(msg, /pr/);
    assert.match(msg, /check/);
    assert.match(msg, /GH-1/);
  });
});
