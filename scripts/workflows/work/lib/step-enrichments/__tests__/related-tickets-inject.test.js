/**
 * Tests for step-enrichments/related-tickets-inject.js
 *
 * Run: node --test scripts/workflows/work/lib/step-enrichments/__tests__/related-tickets-inject.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const registerEnrichment = require('../related-tickets-inject');
const relatedTickets = require('../../../../lib/related-tickets');

// Minimal registry so we can capture which fns get registered per step.
function makeRegistry() {
  const byStep = {};
  const register = (step, fn) => {
    if (!byStep[step]) byStep[step] = [];
    byStep[step].push(fn);
  };
  const run = (step, entry, ctx) => {
    const fns = byStep[step] || [];
    for (const fn of fns) fn(entry, ctx);
  };
  return { register, run, byStep };
}

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rti-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Stub ticket-provider via a fake `tp` object passed in ctx.
function fakeTp({ provider = 'github', returnPrompt = true } = {}) {
  return {
    getProviderConfig: () => (provider ? { provider } : null),
    getRelatedTicketsPrompt: (ticket, _cfg, manifest) =>
      returnPrompt ? `FETCH ${ticket} -> ${manifest}` : null,
  };
}

const baseCtx = (tasksDir, overrides = {}) => ({
  tasksDir,
  ticket: 'GH-279',
  workDir: tasksDir,
  path,
  fs,
  tp: fakeTp(),
  ...overrides,
});

describe('related-tickets-inject — brief step', () => {
  it('appends fetch prompt to entry.agentPrompt', () => {
    const reg = makeRegistry();
    registerEnrichment(reg.register);

    const entry = { step: 'brief', agentPrompt: 'BASE' };
    reg.run('brief', entry, baseCtx(tmp));

    assert.match(entry.agentPrompt, /BASE/);
    assert.match(entry.agentPrompt, /Related Tickets Manifest/);
    assert.match(entry.agentPrompt, /FETCH GH-279 ->/);
  });

  it('skips when provider is null', () => {
    const reg = makeRegistry();
    registerEnrichment(reg.register);

    const entry = { step: 'brief', agentPrompt: 'BASE' };
    const ctx = baseCtx(tmp, { tp: fakeTp({ provider: null }) });
    reg.run('brief', entry, ctx);

    assert.equal(entry.agentPrompt, 'BASE');
  });

  it('skips when prompt builder returns null', () => {
    const reg = makeRegistry();
    registerEnrichment(reg.register);

    const entry = { step: 'brief', agentPrompt: 'BASE' };
    const ctx = baseCtx(tmp, { tp: fakeTp({ returnPrompt: false }) });
    reg.run('brief', entry, ctx);

    assert.equal(entry.agentPrompt, 'BASE');
  });
});

describe('related-tickets-inject — read steps', () => {
  it('appends READ FIRST block for spec/tasks/implement when manifest exists', () => {
    fs.writeFileSync(
      path.join(tmp, 'related-tickets.json'),
      JSON.stringify({
        self: { id: 'GH-279' },
        parent: null,
        siblings: [],
        blockedBy: [],
        dependsOn: [],
        relatedTo: [],
        fetchedAt: new Date().toISOString(),
      })
    );

    const reg = makeRegistry();
    registerEnrichment(reg.register);

    for (const step of ['spec', 'tasks', 'implement']) {
      const entry = { step, agentPrompt: '' };
      reg.run(step, entry, baseCtx(tmp));
      assert.match(entry.agentPrompt, /READ FIRST/, `step ${step} should inject READ FIRST`);
    }
  });

  it('does NOT inject READ FIRST when manifest missing', () => {
    const reg = makeRegistry();
    registerEnrichment(reg.register);

    const entry = { step: 'spec', agentPrompt: '' };
    reg.run('spec', entry, baseCtx(tmp));
    assert.equal(entry.agentPrompt, '');
  });
});

describe('ticket-provider integration', () => {
  it('getRelatedTicketsPrompt returns provider-specific prompts', () => {
    const tp = require('../../../../lib/ticket-provider');
    assert.ok(tp.getRelatedTicketsPrompt('GH-1', { provider: 'github' }, '/x.json'));
    assert.ok(tp.getRelatedTicketsPrompt('ABC-1', { provider: 'jira' }, '/x.json'));
    assert.ok(tp.getRelatedTicketsPrompt('LIN-1', { provider: 'linear' }, '/x.json'));
    assert.equal(tp.getRelatedTicketsPrompt('x', { provider: 'none' }, '/x.json'), null);
    assert.equal(tp.getRelatedTicketsPrompt('x', null, '/x.json'), null);
  });

  it('prompt mentions the manifest path', () => {
    const tp = require('../../../../lib/ticket-provider');
    const out = tp.getRelatedTicketsPrompt('GH-279', { provider: 'github' }, '/tmp/m.json');
    assert.match(out, /\/tmp\/m\.json/);
  });
});
