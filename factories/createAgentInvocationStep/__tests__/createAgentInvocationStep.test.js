'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAgentInvocationStep } = require('../createAgentInvocationStep');

function fixture() {
  const plan = [];
  const add = (id, action, command, reason, extra) =>
    plan.push({ id, action, command, reason, ...extra });
  return { plan, add };
}

describe('createAgentInvocationStep', () => {
  it('rejects bad config', () => {
    assert.throws(() => createAgentInvocationStep({}), /missing "id"/);
    assert.throws(
      () => createAgentInvocationStep({ id: 'i', command: '/x', agentType: 'skill' }),
      /sections/
    );
    assert.throws(
      () =>
        createAgentInvocationStep({
          id: 'i',
          command: '/x',
          agentType: 'skill',
          sections: [{ id: 'a' }],
        }),
      /each section needs build/
    );
  });

  it('DEFER when precondition false', () => {
    const { plan, add } = fixture();
    const step = createAgentInvocationStep({
      id: 'i',
      command: '/x',
      agentType: 'skill',
      sections: [],
      precondition: () => false,
      skipReason: 'not ready',
    });
    step(add, {}, {});
    assert.equal(plan[0].action, 'DEFER');
    assert.equal(plan[0].reason, 'not ready');
  });

  it('RUN with assembled prompt from non-empty sections', () => {
    const { plan, add } = fixture();
    const step = createAgentInvocationStep({
      id: 'i',
      command: '/implement',
      agentType: 'general-purpose',
      sections: [
        { id: 'task', build: (s) => `Task: ${s.task}` },
        { id: 'empty', build: () => null },
        { id: 'deps', build: () => '' },
        { id: 'docs', build: () => 'Docs: foo.md' },
      ],
    });
    step(add, { task: 'GH-1' }, {});
    assert.equal(plan[0].action, 'RUN');
    assert.equal(plan[0].agentPrompt, 'Task: GH-1\n\nDocs: foo.md');
    assert.equal(plan[0].agentType, 'general-purpose');
  });

  it('build throws → section omitted, onSectionError receives id + err', () => {
    const { plan, add } = fixture();
    const calls = [];
    const step = createAgentInvocationStep({
      id: 'i',
      command: '/x',
      agentType: 'skill',
      sections: [
        { id: 'a', build: () => 'A' },
        {
          id: 'b',
          build: () => {
            throw new Error('boom');
          },
        },
        { id: 'c', build: () => 'C' },
      ],
      onSectionError: (sectionId, err) => calls.push({ sectionId, msg: err.message }),
    });
    step(add, {}, {});
    assert.equal(plan[0].agentPrompt, 'A\n\nC');
    assert.deepEqual(calls, [{ sectionId: 'b', msg: 'boom' }]);
  });

  it('onSectionError type-check rejects non-functions', () => {
    assert.throws(
      () =>
        createAgentInvocationStep({
          id: 'i',
          command: '/x',
          agentType: 'skill',
          sections: [{ id: 'a', build: () => '' }],
          onSectionError: 'not a fn',
        }),
      /onSectionError/
    );
  });

  it('extras() are merged into the entry', () => {
    const { plan, add } = fixture();
    const step = createAgentInvocationStep({
      id: 'i',
      command: '/x',
      agentType: 'skill',
      sections: [{ id: 'a', build: () => 'A' }],
      extras: (s) => ({ taskInfo: { current: s.idx, total: 3 } }),
    });
    step(add, { idx: 2 }, {});
    assert.deepEqual(plan[0].taskInfo, { current: 2, total: 3 });
  });

  it('metadata exposes section ids', () => {
    const step = createAgentInvocationStep({
      id: 'i',
      command: '/x',
      agentType: 'skill',
      sections: [
        { id: 'task', build: () => '' },
        { id: 'deps', build: () => '' },
      ],
    });
    assert.deepEqual(step.__factoryMeta.sectionIds, ['task', 'deps']);
  });
});
