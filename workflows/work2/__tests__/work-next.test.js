/**
 * Tests for work-next.js — script-driven orchestrator for /work2.
 *
 * Tests the core logic: buildStateContext, buildInstruction, and the
 * CLI output via child_process.spawn.
 *
 * Uses node:test + node:assert/strict.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildInstruction } = require('../lib/instruction-builder');
const { buildStateContext } = require('../lib/state-context');

describe('buildStateContext', () => {
  const ALL_STEPS = [
    'ticket',
    'bootstrap',
    'brief',
    'spec',
    'implement',
    'commit',
    'check',
    'pr',
    'complete',
  ];
  const mockDeps = {
    loadWorkState: () => null,
    getCurrentStep: () => null,
    ALL_STEPS,
  };

  it('returns ticket as current when no work state exists', () => {
    const plan = [
      { step: 'ticket', action: 'RUN' },
      { step: 'bootstrap', action: 'PENDING' },
    ];
    const ctx = buildStateContext('PROJ-123', plan, 'NONEXISTENT-TICKET-999', mockDeps);
    assert.equal(ctx.ticket, 'PROJ-123');
    assert.equal(ctx.currentStep, 'ticket');
    assert.ok(ctx.progress.includes('/'));
    assert.ok(Array.isArray(ctx.completedSteps));
    assert.ok(Array.isArray(ctx.remainingSteps));
  });

  it('includes ticket in output', () => {
    const plan = [{ step: 'ticket', action: 'RUN' }];
    const ctx = buildStateContext('PROJ-456', plan, 'NONEXISTENT-TICKET-999', mockDeps);
    assert.equal(ctx.ticket, 'PROJ-456');
  });
});

describe('buildInstruction', () => {
  const stubState = {
    ticket: 'PROJ-123',
    currentStep: 'brief',
    progress: '3/14',
    completedSteps: ['ticket', 'bootstrap'],
    remainingSteps: ['spec'],
  };

  it('builds skill delegation', () => {
    const entry = {
      step: 'check',
      action: 'RUN',
      agentType: 'skill',
      agentPrompt: '/check',
    };
    const instr = buildInstruction(entry, stubState);
    assert.equal(instr.type, 'work_instruction');
    assert.equal(instr.action, 'execute');
    assert.equal(instr.continue, true);
    assert.equal(instr.delegate.type, 'skill');
    assert.equal(instr.delegate.name, 'check');
  });

  it('builds task delegation', () => {
    const entry = {
      step: 'brief',
      action: 'RUN',
      agentType: 'brief-writer',
      agentPrompt: 'Generate a product brief for ticket PROJ-123',
      reason: 'Generate product brief',
    };
    const instr = buildInstruction(entry, stubState);
    assert.equal(instr.delegate.type, 'task');
    assert.equal(instr.delegate.agentType, 'brief-writer');
    assert.ok(instr.delegate.prompt.includes('PROJ-123'));
    assert.ok(instr.delegate.description.startsWith('brief'));
  });

  it('builds bash delegation', () => {
    const entry = {
      step: 'cleanup',
      action: 'RUN',
      agentType: 'Bash',
      agentPrompt: 'tmux kill-session -t PROJ-123-dev',
      reason: 'Kill dev session',
    };
    const instr = buildInstruction(entry, stubState);
    assert.equal(instr.delegate.type, 'bash');
    assert.ok(instr.delegate.command.includes('tmux'));
    assert.ok(instr.delegate.description.startsWith('cleanup'));
  });

  it('includes preCommands when present', () => {
    const entry = {
      step: 'check',
      action: 'RUN',
      agentType: 'skill',
      agentPrompt: '/check',
      preCommands: ['rm -f *.check.md', 'rm -f *.qa.md'],
    };
    const instr = buildInstruction(entry, stubState);
    assert.ok(Array.isArray(instr.preCommands));
    assert.equal(instr.preCommands.length, 2);
  });

  it('omits preCommands when empty', () => {
    const entry = {
      step: 'check',
      action: 'RUN',
      agentType: 'skill',
      agentPrompt: '/check',
      preCommands: [],
    };
    const instr = buildInstruction(entry, stubState);
    assert.equal(instr.preCommands, undefined);
  });

  it('extracts skill name from agentPrompt with arguments', () => {
    const entry = {
      step: 'implement',
      action: 'RUN',
      agentType: 'skill',
      agentPrompt: '/work-implement Task 1/3: Add validation\n\nTDD protocol...',
    };
    const instr = buildInstruction(entry, stubState);
    assert.equal(instr.delegate.name, 'work-implement');
  });

  it('always includes state block', () => {
    const entry = {
      step: 'brief',
      action: 'RUN',
      agentType: 'brief-writer',
      agentPrompt: 'Generate brief',
    };
    const instr = buildInstruction(entry, stubState);
    assert.deepEqual(instr.state, stubState);
  });
});

describe('work-next.js CLI', () => {
  it('outputs blocked instruction when no ticket provided', () => {
    const { execFileSync } = require('child_process');
    const env = { ...process.env };
    delete env.CLAUDE_PLUGIN_ROOT; // Use __dirname fallback for tests
    const result = execFileSync(
      process.execPath,
      [require('path').join(__dirname, '..', 'work-next.js')],
      { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'], env }
    );
    const parsed = JSON.parse(result);
    assert.equal(parsed.type, 'work_instruction');
    assert.equal(parsed.action, 'blocked');
    assert.ok(parsed.reason.includes('No ticket'));
  });
});
