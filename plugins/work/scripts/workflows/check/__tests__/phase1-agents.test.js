/**
 * Tests for check step 5_phase1_agents (GH-611, GH-343).
 *
 * - 0-byte reports are treated as MISSING (not present).
 * - Per-report completion is sticky: a report observed once stays done even
 *   if a later clobber truncates/deletes it (no simultaneous-existence
 *   requirement → no deadlock).
 * - Re-dispatch is targeted: only the missing report's agent is re-launched.
 * - Dispatch attempts are capped: after MAX_DISPATCH_ATTEMPTS the step blocks
 *   with an actionable error naming the missing artifact.
 * - Delegate prompts carry the report contract (Write tool + verify non-empty)
 *   and the instruction note forbids background dispatch.
 *
 * node:test + node:assert/strict; temp dirs via fs.mkdtempSync.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const registerPhase1 = require('../lib/steps/phase1-agents');
const { MAX_DISPATCH_ATTEMPTS } = registerPhase1;

let handler;
registerPhase1((name, fn) => {
  assert.equal(name, '5_phase1_agents');
  handler = fn;
});

let dir;
let state;
let ctx;

function freshState() {
  return {
    ticketId: 'GH-611',
    currentStep: '5_phase1_agents',
    status: 'in_progress',
    dispatched: null,
    changesHash: 'abc123def456',
    setupResult: { reportFolder: dir },
  };
}

function writeReport(name, content = 'Status: APPROVED\n\n## Overall Assessment: ✅') {
  fs.writeFileSync(path.join(dir, name), content);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-test-'));
  state = freshState();
  ctx = { tasksDir: dir, checkHooksDir: dir };
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('5_phase1_agents — dispatch & readiness', () => {
  it('first call dispatches both agents in parallel with the report contract', () => {
    const r = handler(state, ctx);
    assert.equal(r.action, 'execute');
    assert.equal(r.parallel, true);
    assert.equal(r.delegates.length, 2);
    assert.equal(state.dispatched, '5_phase1_agents');
    for (const d of r.delegates) {
      assert.match(d.prompt, /Write tool/);
      assert.match(d.prompt, /non-empty/);
    }
    assert.match(r.note, /FOREGROUND/);
    assert.match(r.note, /never run_in_background/);
    assert.equal(state.phase1Reports['code-review.check.md'].attempts, 1);
    assert.equal(state.phase1Reports['completion.check.md'].attempts, 1);
  });

  it('advances (returns null) when both reports are present and non-empty', () => {
    handler(state, ctx);
    writeReport('code-review.check.md');
    writeReport('completion.check.md');
    assert.equal(handler(state, ctx), null);
  });

  it('treats a 0-byte report as missing and re-dispatches only that agent', () => {
    handler(state, ctx);
    writeReport('code-review.check.md');
    writeReport('completion.check.md', ''); // clobbered to 0 bytes
    const r = handler(state, ctx);
    assert.equal(r.action, 'execute');
    assert.equal(r.delegates.length, 1);
    assert.equal(r.delegates[0].agentType, 'work-workflow:completion-checker');
    assert.match(r.note, /TARGETED RETRY/);
    assert.match(r.note, /0 bytes/);
    // code-review is sticky-done, only completion consumed a retry attempt
    assert.equal(state.phase1Reports['code-review.check.md'].done, true);
    assert.equal(state.phase1Reports['completion.check.md'].attempts, 2);
  });

  it('sticky completion: a report seen once stays done even if later clobbered', () => {
    handler(state, ctx);
    writeReport('code-review.check.md');
    const r = handler(state, ctx); // observes code-review, retries completion
    assert.equal(r.delegates.length, 1);

    // Simulate the purge race eating the already-observed report
    fs.unlinkSync(path.join(dir, 'code-review.check.md'));
    writeReport('completion.check.md');

    // Both tracked done → advance, no simultaneous existence required
    assert.equal(handler(state, ctx), null);
  });

  it('never-written report: distinct "never created" wording on retry', () => {
    handler(state, ctx);
    writeReport('completion.check.md');
    const r = handler(state, ctx);
    assert.equal(r.delegates.length, 1);
    assert.equal(r.delegates[0].agentType, 'work-workflow:code-checker');
    assert.match(r.note, /never created/);
  });

  it(`blocks with an actionable error naming the artifact after ${MAX_DISPATCH_ATTEMPTS} attempts`, () => {
    // Never write any report; each call is one dispatch attempt
    for (let i = 0; i < MAX_DISPATCH_ATTEMPTS; i++) {
      const r = handler(state, ctx);
      assert.equal(r.action, 'execute', `attempt ${i + 1} should still dispatch`);
    }
    const blocked = handler(state, ctx);
    assert.equal(blocked.action, 'blocked');
    assert.match(blocked.reason, /code-review\.check\.md/);
    assert.match(blocked.reason, /completion\.check\.md/);
    assert.match(blocked.reason, /Do NOT re-dispatch/);
    assert.match(blocked.reason, /Write tool/);
    // stays blocked (no silent re-dispatch) on subsequent calls
    assert.equal(handler(state, ctx).action, 'blocked');
  });

  it('recovers from blocked once the missing reports are written manually', () => {
    for (let i = 0; i <= MAX_DISPATCH_ATTEMPTS; i++) handler(state, ctx);
    assert.equal(handler(state, ctx).action, 'blocked');
    writeReport('code-review.check.md');
    writeReport('completion.check.md');
    assert.equal(handler(state, ctx), null); // artifact-gated recovery → advance
  });
});
