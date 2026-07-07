/**
 * Dual-runtime tests for the check delegate emitters' notes (WP-08):
 * 5_phase1_agents and 6_phase2_consensus route their delegate notes through
 * the vocab token and the phase-1 launch note through the per-runtime
 * builder.
 *
 * Claude characterization: notes are byte-identical to the pre-vocabulary
 * HEAD literals. Codex: notes say "execute inline" and the launch note
 * carries the [work:codex-degraded] serialized-dispatch phrasing (C1).
 *
 * Run: node --test scripts/workflows/check/__tests__/phase-notes-runtime.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resetRuntimeCache } = require('../../lib/runtime');
const registerPhase1 = require('../lib/steps/phase1-agents');
const registerPhase2 = require('../lib/steps/phase2-consensus');

let phase1;
registerPhase1((name, fn) => {
  phase1 = fn;
});
let phase2;
registerPhase2((name, fn) => {
  phase2 = fn;
});

const CLAUDE_NOTE = 'Pass the prompt directly to the agent.';
const CODEX_NOTE = 'Execute the prompt inline in this session.';

let dir;
const savedRuntime = {};

beforeEach(() => {
  savedRuntime.AGENT_RUNTIME = process.env.AGENT_RUNTIME;
  delete process.env.AGENT_RUNTIME;
  resetRuntimeCache();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-notes-rt-'));
});

afterEach(() => {
  if (savedRuntime.AGENT_RUNTIME === undefined) delete process.env.AGENT_RUNTIME;
  else process.env.AGENT_RUNTIME = savedRuntime.AGENT_RUNTIME;
  resetRuntimeCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

function pin(runtime) {
  process.env.AGENT_RUNTIME = runtime;
  resetRuntimeCache();
}

function runPhase1() {
  const state = {
    ticketId: 'GH-1',
    currentStep: '5_phase1_agents',
    dispatched: null,
    changesHash: 'abc123',
    setupResult: { reportFolder: dir },
  };
  return phase1(state, { tasksDir: dir, checkHooksDir: dir });
}

function runPhase2() {
  fs.writeFileSync(
    path.join(dir, 'code-review.check.md'),
    '🟡 IMPORTANT: fix naming\nStatus: NEEDS_WORK\n'
  );
  const state = {
    ticketId: 'GH-1',
    dispatched: null,
    consensusIteration: 0,
    changesHash: 'abc123',
    setupResult: { reportFolder: dir, affectedFiles: {} },
  };
  return phase2(state, { tasksDir: dir, checkHooksDir: dir });
}

describe('5_phase1_agents notes', () => {
  it('claude: launch note + delegate notes byte-identical to HEAD', () => {
    pin('claude');
    const r = runPhase1();
    assert.equal(
      r.note,
      'Launch EXACTLY these 2 agent(s) IN PARALLEL (single message, one Task tool call each). ' +
        'Launch them in the FOREGROUND (never run_in_background — background agent writes have ' +
        'silently disappeared, GH-343). Do NOT add any other agents — tests are handled by a ' +
        'deterministic script.'
    );
    for (const d of r.delegates) assert.equal(d.note, CLAUDE_NOTE);
  });

  it('codex: serialized inline launch note + inline delegate notes', () => {
    pin('codex');
    const r = runPhase1();
    assert.match(r.note, /^\[work:codex-degraded\] parallel dispatch serialized/);
    assert.match(r.note, /execute EXACTLY these 2 task prompt\(s\) INLINE, one after another/);
    assert.match(r.note, /no Task tool on codex/);
    assert.match(r.note, /tests are handled by a deterministic script\.$/);
    for (const d of r.delegates) assert.equal(d.note, CODEX_NOTE);
  });

  it('codex retry note survives the codex launch note', () => {
    pin('codex');
    const state = {
      ticketId: 'GH-1',
      currentStep: '5_phase1_agents',
      dispatched: null,
      changesHash: 'abc123',
      setupResult: { reportFolder: dir },
    };
    const ctx = { tasksDir: dir, checkHooksDir: dir };
    phase1(state, ctx); // first dispatch
    const retry = phase1(state, ctx); // reports still missing → targeted retry
    assert.match(retry.note, /TARGETED RETRY/);
    assert.match(retry.note, /^\[work:codex-degraded\]/);
  });
});

describe('6_phase2_consensus notes', () => {
  it('claude: dev-fix delegate note byte-identical to HEAD', () => {
    pin('claude');
    const r = runPhase2();
    assert.equal(r.delegate.note, CLAUDE_NOTE);
  });

  it('codex: dev-fix delegate note says execute inline', () => {
    pin('codex');
    const r = runPhase2();
    assert.equal(r.delegate.note, CODEX_NOTE);
  });
});
