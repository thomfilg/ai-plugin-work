/**
 * standalone-artifact-writes.test.js
 *
 * Rule 4's step gate asks "is this write happening in the right PART of a
 * run?". `/brief`, `/spec` and `/split-in-tasks` are documented standalone
 * commands, and a ticket with no `/work` run has no part to be in: the gate
 * answered "(none)" and refused the write AFTER the agent had done the whole
 * job (the standalone brief-writer produced a complete brief, wrote every side
 * artifact, and then could not save brief.md — with no route to satisfy the
 * gate from inside the session).
 *
 * So the step gate abstains when no run owns the ticket, and the agent gate —
 * which asks WHO is writing — decides instead. While a run IS active, every
 * step boundary holds exactly as before.
 *
 * Run: node --test workflows/lib/__tests__/standalone-artifact-writes.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createArtifactProtector } = require('../protect-artifact-files');

const TICKET = 'CHAR-8178';
const BRIEF = `/home/dev/tasks/${TICKET}/brief.md`;

function protector({ workflowActive, currentStep = null, inAgent = true }) {
  return createArtifactProtector({
    artifacts: [
      {
        basename: 'brief.md',
        step: 'brief',
        allowedSteps: ['brief_gate'],
        agents: ['brief-writer'],
      },
    ],
    getStepInProgress: () => currentStep,
    isWorkflowActive: () => workflowActive,
    isRunningInAgent: () => inAgent,
    getTicketId: () => TICKET,
  });
}

const write = (p) => p.check('Write', { file_path: BRIEF, content: '# Brief\n' }, {});

describe('artifact step gate — standalone (no /work run owns the ticket)', () => {
  it('allows the authorized agent to save its own output', () => {
    const result = write(protector({ workflowActive: false }));
    assert.equal(result.blocked, false);
  });

  it('still refuses a writer that is not the authorized agent', () => {
    const result = write(protector({ workflowActive: false, inAgent: false }));
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'agent');
  });
});

describe('artifact step gate — inside an active /work run', () => {
  it('blocks a write from the wrong step', () => {
    const result = write(protector({ workflowActive: true, currentStep: 'spec' }));
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'step');
    assert.match(result.message, /none of the allowed step\(s\) 'brief, brief_gate'/);
  });

  it('blocks a write when the run has no step in progress', () => {
    const result = write(protector({ workflowActive: true, currentStep: null }));
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'step');
  });

  it('allows the owning step', () => {
    const result = write(protector({ workflowActive: true, currentStep: 'brief' }));
    assert.equal(result.blocked, false);
  });

  it('allows an allowedSteps entry', () => {
    const result = write(protector({ workflowActive: true, currentStep: 'brief_gate' }));
    assert.equal(result.blocked, false);
  });
});

describe('artifact protector: isWorkflowActive default', () => {
  it('gates by step when the caller does not supply the predicate', () => {
    const p = createArtifactProtector({
      artifacts: [{ basename: 'brief.md', step: 'brief' }],
      getStepInProgress: () => 'spec',
      getTicketId: () => TICKET,
    });
    assert.equal(write(p).blocked, true);
  });
});
