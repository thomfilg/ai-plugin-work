'use strict';

// triage-wait-interrupt.test.js — the wait loop must (a) never spawn a
// subprocess to sleep (the execSync pattern crashed uncaught with
// `spawnSync /bin/sh ETIMEDOUT` under load, echo-6209), and (b) wake early
// and surface fresh operator inbox messages instead of sleeping through them.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TRIAGE_SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'triage.js'), 'utf8');

function loadTriageHandler() {
  const handlers = {};
  delete require.cache[require.resolve('../triage')];
  require('../triage')((name, fn) => {
    handlers[name] = fn;
  });
  return handlers.triage;
}

describe('triage wait loop', () => {
  it('no subprocess-based sleep remains (ETIMEDOUT crash class removed)', () => {
    assert.ok(!TRIAGE_SOURCE.includes('execSync'), 'triage must not sleep via execSync');
    assert.ok(TRIAGE_SOURCE.includes('sleepSyncInterruptible'), 'uses the Atomics-based sleep');
  });

  it('routes back to monitor after a quiet wait (FOLLOW_UP2_NO_DELAY)', () => {
    process.env.FOLLOW_UP2_NO_DELAY = '1';
    try {
      const triage = loadTriageHandler();
      const state = {
        ticketId: 'GH-8',
        attempt: 1,
        maxAttempts: 40,
        _ciRunningCount: 1,
        lastMonitorResult: { exitCode: 1, output: 'CI: PENDING' },
      };
      const result = triage(state, {});
      assert.equal(result, null);
      assert.equal(state.currentStep, 'monitor');
    } finally {
      delete process.env.FOLLOW_UP2_NO_DELAY;
    }
  });

  it('wakes early and surfaces operator messages that arrive mid-wait', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-inbox-'));
    process.env.CLAUDE_AGENT_INBOX_DIR = tmpDir;
    try {
      const inboxFile = path.join(tmpDir, 'GH-8.log');
      fs.writeFileSync(inboxFile, '');
      const triage = loadTriageHandler();
      const state = {
        ticketId: 'GH-8',
        prNumber: 12,
        attempt: 1,
        maxAttempts: 40,
        _ciRunningCount: 1, // → 15s pending interval
        _inboxOffset: 0, // anchored before the message below
        lastMonitorResult: { exitCode: 1, output: 'CI: PENDING' },
      };
      fs.appendFileSync(inboxFile, 'operator says: hold the push\n');
      const result = triage(state, {});
      assert.ok(result, 'expected an instruction, not a silent advance');
      assert.equal(result.action, 'blocked');
      assert.equal(result.payload.reason, 'operator-message');
      assert.ok(result.reason.includes('hold the push'));
      assert.equal(state.currentStep, 'monitor', 'resume continues at monitor');
    } finally {
      delete process.env.CLAUDE_AGENT_INBOX_DIR;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
