'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createGateStep } = require('../createGateStep');

function setupCtx() {
  const tasksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-step-'));
  const plan = [];
  const add = (id, action, command, reason, extra) =>
    plan.push({ id, action, command, reason, ...extra });
  return { tasksDir, plan, add, ctx: { tasksDir, path } };
}

describe('createGateStep', () => {
  let env;
  beforeEach(() => (env = setupCtx()));

  it('rejects bad config', () => {
    assert.throws(() => createGateStep(null), /config object/);
    assert.throws(() => createGateStep({}), /missing "id"/);
    assert.throws(
      () =>
        createGateStep({
          id: 'g',
          artifact: 'a',
          precondition: 'nope',
          parse: () => 0,
          validate: () => 0,
          runCommand: '/x',
        }),
      /precondition/
    );
  });

  it('DEFER when precondition false', () => {
    const step = createGateStep({
      id: 'g',
      artifact: 'a.md',
      precondition: () => false,
      parse: () => null,
      validate: () => ({ valid: true }),
      runCommand: '/x',
    });
    step(env.add, {}, env.ctx);
    assert.equal(env.plan[0].action, 'DEFER');
    assert.match(env.plan[0].reason, /No a\.md present/);
  });

  it('RUN fail-closed when artifact unreadable', () => {
    const step = createGateStep({
      id: 'g',
      artifact: 'missing.md',
      precondition: () => true,
      parse: () => null,
      validate: () => ({ valid: true }),
      runCommand: '/x',
      failClosedCommand: '/regen',
    });
    step(env.add, {}, env.ctx);
    assert.equal(env.plan[0].action, 'RUN');
    assert.equal(env.plan[0].command, '/regen');
  });

  it('RUN when parser throws', () => {
    fs.writeFileSync(path.join(env.tasksDir, 'a.md'), 'x');
    const step = createGateStep({
      id: 'g',
      artifact: 'a.md',
      precondition: () => true,
      parse: () => {
        throw new Error('boom');
      },
      validate: () => ({ valid: true }),
      runCommand: '/x',
    });
    step(env.add, {}, env.ctx);
    assert.equal(env.plan[0].action, 'RUN');
    assert.match(env.plan[0].reason, /parser threw: boom/);
  });

  it('DEFER when validation passes', () => {
    fs.writeFileSync(path.join(env.tasksDir, 'a.md'), 'x');
    const step = createGateStep({
      id: 'g',
      artifact: 'a.md',
      precondition: () => true,
      parse: (t) => ({ text: t }),
      validate: (p) => ({ valid: true, deferReason: `parsed ${p.text}` }),
      runCommand: '/x',
    });
    step(env.add, {}, env.ctx);
    assert.equal(env.plan[0].action, 'DEFER');
    assert.equal(env.plan[0].reason, 'parsed x');
  });

  it('RUN with runExtra() when validation fails', () => {
    fs.writeFileSync(path.join(env.tasksDir, 'a.md'), 'x');
    const step = createGateStep({
      id: 'g',
      artifact: 'a.md',
      precondition: () => true,
      parse: (t) => ({ count: t.length }),
      validate: (p) => ({
        valid: false,
        runReason: () => `bad count ${p.count}`,
      }),
      runCommand: '/x',
    });
    step(env.add, {}, env.ctx);
    assert.equal(env.plan[0].action, 'RUN');
    assert.match(env.plan[0].reason, /bad count 1/);
    assert.equal(env.plan[0].agentType, 'skill');
  });

  it('runExtra receives (parsed, validation, ctx) — brief-gate.js pattern', () => {
    fs.writeFileSync(path.join(env.tasksDir, 'a.md'), 'x');
    const step = createGateStep({
      id: 'g',
      artifact: 'a.md',
      precondition: () => true,
      parse: (t) => ({ blocking: ['q1', 'q2'], text: t }),
      validate: (p) => ({
        valid: false,
        runReason: () => `Resolve ${p.blocking.length} question(s)`,
        runExtra: (parsed, _validation, ctx) => ({
          agentType: 'general-purpose',
          agentPrompt: `Resolve in ${ctx.tasksDir}`,
          postResolveCommand: `node -e "..." "${ctx.path.join(ctx.tasksDir, 'a.md')}"`,
          questions: parsed.blocking,
        }),
      }),
      runCommand: 'AskUserQuestion',
    });
    step(env.add, {}, env.ctx);
    assert.equal(env.plan[0].agentType, 'general-purpose');
    assert.match(env.plan[0].agentPrompt, /Resolve in .+/);
    assert.match(env.plan[0].postResolveCommand, /a\.md/);
    assert.deepEqual(env.plan[0].questions, ['q1', 'q2']);
  });

  it('runExtra returning null falls back to default agent metadata', () => {
    // Regression for PR #574 review comment: if a caller's runExtra returns
    // null/undefined (e.g. it short-circuits because there's nothing to add),
    // the plan entry MUST still get { agentType, agentPrompt } — otherwise
    // the orchestrator has no agent to dispatch.
    fs.writeFileSync(path.join(env.tasksDir, 'a.md'), 'x');
    const step = createGateStep({
      id: 'g',
      artifact: 'a.md',
      precondition: () => true,
      parse: (t) => ({ text: t }),
      validate: () => ({
        valid: false,
        runReason: () => 'bad',
        runExtra: () => null, // returns nullish on purpose
      }),
      runCommand: '/fixit',
    });
    step(env.add, {}, env.ctx);
    assert.equal(env.plan[0].action, 'RUN');
    assert.equal(env.plan[0].agentType, 'skill');
    assert.equal(env.plan[0].agentPrompt, '/fixit');
  });

  it('records factory metadata on the returned handler', () => {
    const step = createGateStep({
      id: 'g',
      artifact: 'a.md',
      precondition: () => true,
      parse: () => null,
      validate: () => ({ valid: true }),
      runCommand: '/x',
      retryTo: 'spec',
    });
    assert.deepEqual(step.__factoryMeta, {
      kind: 'gate',
      id: 'g',
      artifact: 'a.md',
      retryTo: 'spec',
    });
  });
});
