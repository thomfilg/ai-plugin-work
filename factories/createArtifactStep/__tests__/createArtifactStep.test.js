'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createArtifactStep } = require('../createArtifactStep');

function fixture() {
  const plan = [];
  const add = (id, action, command, reason, extra) =>
    plan.push({ id, action, command, reason, ...extra });
  return { plan, add };
}

describe('createArtifactStep', () => {
  it('rejects bad config', () => {
    assert.throws(() => createArtifactStep({}), /missing "id"/);
    assert.throws(
      () =>
        createArtifactStep({
          id: 'a',
          artifact: 'x.md',
          precondition: 'bad',
          artifactExists: () => false,
          command: '/x',
          agentType: 'skill',
        }),
      /precondition/
    );
    assert.throws(
      () =>
        createArtifactStep({
          id: 'a',
          artifact: 'x.md',
          precondition: () => true,
          artifactExists: 'bad',
          command: '/x',
          agentType: 'skill',
        }),
      /artifactExists/
    );
  });

  it('DEFER when precondition false', () => {
    const { plan, add } = fixture();
    const step = createArtifactStep({
      id: 'a',
      artifact: 'x.md',
      precondition: () => false,
      artifactExists: () => false,
      command: '/x',
      agentType: 'skill',
      skipReason: 'no ticket',
    });
    step(add, {}, { planningContext: '' });
    assert.equal(plan[0].action, 'DEFER');
    assert.equal(plan[0].reason, 'no ticket');
  });

  it('DEFER when artifact already exists', () => {
    const { plan, add } = fixture();
    const step = createArtifactStep({
      id: 'a',
      artifact: 'x.md',
      precondition: () => true,
      artifactExists: () => true,
      command: '/x',
      agentType: 'skill',
    });
    step(add, {}, {});
    assert.equal(plan[0].action, 'DEFER');
    assert.match(plan[0].reason, /already present/);
  });

  it('RUN with planning context appended', () => {
    const { plan, add } = fixture();
    const step = createArtifactStep({
      id: 'a',
      artifact: 'x.md',
      precondition: () => true,
      artifactExists: () => false,
      command: '/spec',
      agentType: 'skill',
      agentPrompt: '/spec',
      injectPlanningContext: true,
    });
    step(add, {}, { planningContext: '\n\nDocs: foo.md' });
    assert.equal(plan[0].action, 'RUN');
    assert.equal(plan[0].agentPrompt, '/spec\n\nDocs: foo.md');
  });

  it('agentPrompt as function gets (s, ctx) — brief.js / spec.js pattern', () => {
    const { plan, add } = fixture();
    const step = createArtifactStep({
      id: 'a',
      artifact: 'brief.md',
      precondition: () => true,
      artifactExists: () => false,
      command: 'Task(brief-writer)',
      agentType: 'brief-writer',
      agentPrompt: (_s, ctx) =>
        `Generate brief for ${ctx.t}${ctx.getDocsPrompt('READ_DOCS_ON_BRIEF')}`,
    });
    step(add, {}, { t: 'GH-1', getDocsPrompt: (k) => `\n\n[docs:${k}]` });
    assert.equal(plan[0].action, 'RUN');
    assert.equal(plan[0].agentPrompt, 'Generate brief for GH-1\n\n[docs:READ_DOCS_ON_BRIEF]');
  });

  it('records factory metadata', () => {
    const step = createArtifactStep({
      id: 'a',
      artifact: 'x.md',
      precondition: () => true,
      artifactExists: () => false,
      command: '/x',
      agentType: 'skill',
    });
    assert.equal(step.__factoryMeta.kind, 'artifact');
    assert.equal(step.__factoryMeta.artifact, 'x.md');
  });
});
