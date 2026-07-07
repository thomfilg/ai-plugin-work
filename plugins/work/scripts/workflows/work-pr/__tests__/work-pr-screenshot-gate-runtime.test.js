/**
 * Dual-runtime test for the work-pr screenshot gate's question command label
 * (WP-08, C3): 'AskUserQuestion' on claude (byte-identical to HEAD),
 * plain-chat numbered options on codex. The static steps[] registry is display
 * metadata and stays untouched (asserted below).
 *
 * Run: node --test scripts/workflows/work-pr/__tests__/work-pr-screenshot-gate-runtime.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { resetRuntimeCache } = require('../../lib/runtime');
const wf = require(path.join(__dirname, '..', 'work-pr.workflow.js'));

const GATE_INSPECT = { hasTsxChanges: true, screenshotsExist: false, screenshotCount: 0 };
const savedRuntime = {};

beforeEach(() => {
  savedRuntime.AGENT_RUNTIME = process.env.AGENT_RUNTIME;
  delete process.env.AGENT_RUNTIME;
  resetRuntimeCache();
});

afterEach(() => {
  if (savedRuntime.AGENT_RUNTIME === undefined) delete process.env.AGENT_RUNTIME;
  else process.env.AGENT_RUNTIME = savedRuntime.AGENT_RUNTIME;
  resetRuntimeCache();
});

function decideGate(runtime) {
  process.env.AGENT_RUNTIME = runtime;
  resetRuntimeCache();
  return wf.detectStepState('4_screenshot_gate', 'TEST-1', null, GATE_INSPECT);
}

describe('4_screenshot_gate question command label', () => {
  it('claude: byte-identical to HEAD', () => {
    const r = decideGate('claude');
    assert.deepEqual(r, {
      action: 'RUN',
      reason: 'TSX/JSX changed but no screenshots — gate required',
      command: 'AskUserQuestion',
    });
  });

  it('codex: renders the plain-chat numbered-options question', () => {
    const r = decideGate('codex');
    assert.equal(r.action, 'RUN');
    assert.equal(r.command, 'a plain-chat question with numbered options');
  });

  it('static steps[] registry is untouched (display metadata, no churn)', () => {
    const gate = wf.steps.find((s) => s.id === '4_screenshot_gate');
    assert.equal(gate.command, 'internal + AskUserQuestion');
  });
});
