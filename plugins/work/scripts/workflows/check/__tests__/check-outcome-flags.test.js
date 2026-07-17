'use strict';

/**
 * GH-756: the check step must HARD-FAIL on unresolved outcome-verifier
 * flags. This design is WEAKER than the legacy gates if flags can be
 * ignored — this test makes that impossible: an unresolved flag entry
 * forces needs_work at the completion boundary; a waived or re-verified
 * entry releases it.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// TASKS_BASE must be pinned BEFORE check-next.js loads (module-load capture).
const TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'check-outcome-flags-'));
process.env.TASKS_BASE = TASKS_BASE;

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { advanceOrComplete } = require('../check-next');
const { unresolvedOutcomeFlags, describeUnresolvedFlags } = require('../lib/outcome-flags');

const TICKET = 'TEST-FLAGS-1';
const STEP_COUNT_LAST_INDEX = 999; // any index at/past the final step completes

function ticketDir() {
  return path.join(TASKS_BASE, TICKET);
}

function writeWorkState(state) {
  fs.mkdirSync(ticketDir(), { recursive: true });
  fs.writeFileSync(path.join(ticketDir(), '.work-state.json'), JSON.stringify(state));
}

function finalState() {
  return { status: 'in_progress', currentStep: '11_output', changesHash: 'x' };
}

describe('check step outcome-flag hard-fail (GH-756)', () => {
  beforeEach(() => {
    fs.rmSync(ticketDir(), { recursive: true, force: true });
    fs.mkdirSync(ticketDir(), { recursive: true });
  });
  after(() => {
    fs.rmSync(TASKS_BASE, { recursive: true, force: true });
  });

  it('an unresolved flag forces needs_work at the completion boundary', () => {
    writeWorkState({ outcomeFlags: [{ task: 2, flags: ['tautology'] }] });
    const result = advanceOrComplete(TICKET, finalState(), STEP_COUNT_LAST_INDEX, {});
    assert.equal(result.action, 'needs_work');
    assert.match(result.reason, /unresolved outcome-verifier flags/);
    assert.match(result.reason, /task 2: tautology/);

    const saved = JSON.parse(fs.readFileSync(path.join(ticketDir(), '.check-state.json'), 'utf8'));
    assert.equal(saved.status, 'needs_work');
  });

  it('a waived flag releases the gate; no flags completes', () => {
    writeWorkState({
      outcomeFlags: [{ task: 2, flags: ['tautology'], waived: { by: 'operator', reason: 'ok' } }],
    });
    const waived = advanceOrComplete(TICKET, finalState(), STEP_COUNT_LAST_INDEX, {});
    assert.equal(waived.action, 'complete');

    writeWorkState({ outcomeFlags: [] });
    const clean = advanceOrComplete(TICKET, finalState(), STEP_COUNT_LAST_INDEX, {});
    assert.equal(clean.action, 'complete');
  });

  it('missing or unreadable work state never blocks the check step', () => {
    const result = advanceOrComplete(TICKET, finalState(), STEP_COUNT_LAST_INDEX, {});
    assert.equal(result.action, 'complete');
    assert.deepEqual(unresolvedOutcomeFlags(path.join(TASKS_BASE, 'nope')), []);
  });

  it('flag summary names each task and flag', () => {
    const text = describeUnresolvedFlags([
      { task: 1, flags: ['tautology'] },
      { task: 3, flags: ['runner-unknown', 'no-structured-reporter'] },
    ]);
    assert.equal(text, 'task 1: tautology; task 3: runner-unknown, no-structured-reporter');
  });
});
