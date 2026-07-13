'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createTransitionStep } = require('../createTransitionStep');

function fixture() {
  const plan = [];
  const add = (id, action, command, reason, extra) =>
    plan.push({ id, action, command, reason, ...extra });
  return { plan, add };
}

describe('createTransitionStep', () => {
  it('rejects missing id/command', () => {
    assert.throws(() => createTransitionStep({}), /missing "id"/);
    assert.throws(() => createTransitionStep({ id: 't' }), /missing "command"/);
  });

  it('DEFER on precondition false', () => {
    const { plan, add } = fixture();
    const step = createTransitionStep({
      id: 't',
      command: '/commit',
      precondition: () => false,
      skipReason: 'no changes',
    });
    step(add, {}, {});
    assert.equal(plan[0].action, 'DEFER');
    assert.equal(plan[0].reason, 'no changes');
  });

  it('RUN with defaults when no precondition', () => {
    const { plan, add } = fixture();
    const step = createTransitionStep({ id: 't', command: '/ready' });
    step(add, {}, {});
    assert.equal(plan[0].action, 'RUN');
    assert.equal(plan[0].command, '/ready');
    assert.equal(plan[0].agentType, 'skill');
  });

  it('runReason function receives (s, ctx)', () => {
    const { plan, add } = fixture();
    const step = createTransitionStep({
      id: 't',
      command: '/cleanup',
      runReason: (s, ctx) => `cleaning ${s.ticket} in ${ctx.worktreeDir}`,
    });
    step(add, { ticket: 'GH-1' }, { worktreeDir: '/wt' });
    assert.equal(plan[0].reason, 'cleaning GH-1 in /wt');
  });

  it('agentPrompt as function interpolates ctx (ready.js / cleanup.js pattern)', () => {
    const { plan, add } = fixture();
    const step = createTransitionStep({
      id: 't',
      command: 'Task(Bash)',
      agentType: 'Bash',
      agentPrompt: (_s, ctx) => `cd "${ctx.worktreeDir}" && gh pr ready`,
    });
    step(add, {}, { worktreeDir: '/wt/GH-1' });
    assert.equal(plan[0].agentType, 'Bash');
    assert.equal(plan[0].agentPrompt, 'cd "/wt/GH-1" && gh pr ready');
  });

  it('deferExtras carries agent metadata onto DEFER (cleanup.js pattern)', () => {
    const { plan, add } = fixture();
    const step = createTransitionStep({
      id: 't',
      command: 'Task(Bash)',
      precondition: (s) => Boolean(s.hasDevSession),
      skipReason: 'No dev session yet — re-check at step time',
      deferExtras: (_s, ctx) => ({
        command: 'Task(Bash)',
        agentType: 'Bash',
        agentPrompt: `tmux kill-session -t "${ctx.ticket}-dev" || true`,
      }),
    });
    step(add, { hasDevSession: false }, { ticket: 'GH-1' });
    assert.equal(plan[0].action, 'DEFER');
    assert.equal(plan[0].command, 'Task(Bash)');
    assert.equal(plan[0].agentType, 'Bash');
    assert.match(plan[0].agentPrompt, /tmux kill-session -t "GH-1-dev"/);
  });

  it('metadata says kind=transition', () => {
    const step = createTransitionStep({ id: 't', command: '/x', retryTo: 'check' });
    assert.equal(step.__factoryMeta.kind, 'transition');
    assert.equal(step.__factoryMeta.retryTo, 'check');
  });
});
