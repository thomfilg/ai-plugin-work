'use strict';

/**
 * Tests for lib/check-state-status.js — the shared "is a /check run still
 * going?" reader.
 *
 * The session guard suppresses its Stop block while /check runs. That
 * suppression must end exactly when the run ends: a finished check that still
 * reads as "active" leaves every later /work step (pr, ready, follow_up, ci,
 * cleanup, reports) unguarded, and the agent stops mid-workflow to ask whether
 * to carry on.
 *
 * Run with: node --test workflows/lib/__tests__/check-state-status.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  TERMINAL_CHECK_STATUSES,
  isCheckRunInProgress,
  isTerminalCheckStatus,
} = require('../check-state-status');

describe('isTerminalCheckStatus', () => {
  for (const status of ['complete', 'needs_work']) {
    it(`"${status}" is terminal`, () => {
      assert.equal(isTerminalCheckStatus(status), true);
    });
  }

  for (const status of ['in_progress', '', undefined, null, 'COMPLETE', 'completed']) {
    it(`${JSON.stringify(status)} is not terminal`, () => {
      assert.equal(isTerminalCheckStatus(status), false);
    });
  }

  it('exposes the terminal set frozen', () => {
    assert.deepEqual([...TERMINAL_CHECK_STATUSES], ['complete', 'needs_work']);
    assert.equal(Object.isFrozen(TERMINAL_CHECK_STATUSES), true);
  });
});

describe('drift guard — check-next.js states the same terminal set', () => {
  // check-next.js `handleTerminalState` cannot require this module (the file is
  // at the repo's 400-line cap), so it repeats the set inline. Two grammars for
  // one question is exactly how the bypass and the orchestrator got out of step
  // in the first place; this pins them together. Same idea as
  // lib/__tests__/no-path-guesses.test.js.
  it('the orchestrator branch matches TERMINAL_CHECK_STATUSES', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'check', 'check-next.js'), 'utf8');
    const lines = src.split('\n');
    const start = lines.findIndex((l) => l.includes('function handleTerminalState'));
    assert.notEqual(start, -1, 'handleTerminalState not found in check-next.js');
    // The guard clause is the first `state.status !== '…'` line inside it.
    const branch = lines.slice(start, start + 6).find((l) => /state\.status !== '/.test(l));
    assert.ok(branch, 'could not find the terminal-state guard clause in handleTerminalState');

    const statuses = [...branch.matchAll(/state\.status !== '([a-z_]+)'/g)].map((m) => m[1]);
    assert.ok(statuses.length > 0, `no statuses parsed from: ${branch.trim()}`);
    assert.deepEqual(
      statuses.sort(),
      [...TERMINAL_CHECK_STATUSES].sort(),
      'check-next.js and check-state-status.js disagree on which statuses are terminal — ' +
        'update both, or wire check-next.js to this module'
    );
  });
});

describe('isCheckRunInProgress', () => {
  it('a running check is in progress', () => {
    assert.equal(
      isCheckRunInProgress({ status: 'in_progress', currentStep: '5_phase1_agents' }),
      true
    );
  });

  it('a state with only a currentStep is in progress (mid-run, status unwritten)', () => {
    assert.equal(isCheckRunInProgress({ currentStep: '1_setup' }), true);
  });

  // The regression. check-next.js never clears `currentStep` when a run ends,
  // so every finished check on disk reads `{status, currentStep:'11_output'}`.
  // Answering this question with `status === 'in_progress' || currentStep` made
  // the answer "running" forever after the first /check.
  it('a COMPLETED check is not in progress, even with currentStep left behind', () => {
    assert.equal(isCheckRunInProgress({ status: 'complete', currentStep: '11_output' }), false);
  });

  it('a NEEDS_WORK check is not in progress — the run is over and work remains', () => {
    assert.equal(isCheckRunInProgress({ status: 'needs_work', currentStep: '11_output' }), false);
  });

  it('terminal status wins over every other field', () => {
    assert.equal(
      isCheckRunInProgress({
        status: 'complete',
        currentStep: '11_output',
        dispatched: '5_phase1_agents',
        consensusIteration: 3,
      }),
      false
    );
  });

  for (const state of [null, undefined, {}, 'complete', 42]) {
    it(`${JSON.stringify(state)} is not in progress`, () => {
      assert.equal(isCheckRunInProgress(state), false);
    });
  }
});
