/**
 * Tests for follow-up enrichment Gate F closed-PR detection.
 *
 * Run: node --test scripts/workflows/work-orchestrator/lib/step-enrichments/__tests__/follow-up.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const registerFollowUp = require('../follow-up');

function makeRegistry() {
  const byStep = {};
  return {
    register: (step, fn) => {
      if (!byStep[step]) byStep[step] = [];
      byStep[step].push(fn);
    },
    run: (step, entry, ctx) => (byStep[step] || []).forEach((fn) => fn(entry, ctx)),
  };
}

let tmp;
const WORK_STATE = '.work' + '-state.json';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-gate-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeState(obj) {
  fs.writeFileSync(path.join(tmp, WORK_STATE), JSON.stringify(obj));
}
const ctx = () => ({ tasksDir: tmp, ticket: 'GH-1', workDir: tmp, path, fs });

describe('follow-up Gate F closed-PR detection', () => {
  it('blocks when PR.state is CLOSED (not merged)', () => {
    writeState({ pr: { state: 'CLOSED' } });
    const reg = makeRegistry();
    registerFollowUp(reg.register);
    const entry = { step: 'follow_up' };
    reg.run('follow_up', entry, ctx());
    assert.ok(entry._overrideInstruction);
    assert.equal(entry._overrideInstruction.action, 'blocked');
    assert.match(entry._overrideInstruction.reason, /closed without merge/i);
    assert.match(entry._overrideInstruction.hint, /re-?enter at `brief`|brief/);
  });

  it('proceeds when PR.state is MERGED', () => {
    writeState({ pr: { state: 'MERGED' } });
    const reg = makeRegistry();
    registerFollowUp(reg.register);
    const entry = { step: 'follow_up' };
    reg.run('follow_up', entry, ctx());
    assert.equal(entry._overrideInstruction, undefined);
    assert.match(entry.agentPrompt || '', /follow-up-next/);
  });

  it('proceeds when PR.state is OPEN', () => {
    writeState({ pr: { state: 'OPEN' } });
    const reg = makeRegistry();
    registerFollowUp(reg.register);
    const entry = { step: 'follow_up' };
    reg.run('follow_up', entry, ctx());
    assert.equal(entry._overrideInstruction, undefined);
  });

  it('proceeds when there is no PR state at all', () => {
    writeState({});
    const reg = makeRegistry();
    registerFollowUp(reg.register);
    const entry = { step: 'follow_up' };
    reg.run('follow_up', entry, ctx());
    assert.equal(entry._overrideInstruction, undefined);
  });

  it('proceeds when work state is missing', () => {
    const reg = makeRegistry();
    registerFollowUp(reg.register);
    const entry = { step: 'follow_up' };
    reg.run('follow_up', entry, ctx());
    assert.equal(entry._overrideInstruction, undefined);
  });
});
