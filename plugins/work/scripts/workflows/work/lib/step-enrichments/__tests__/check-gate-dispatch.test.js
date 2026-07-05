/**
 * Tests for step-enrichments/check-gate.js dispatchAdvanceGate —
 * SHA-fresh + severity-gated check→pr advance (echo-5213-3, echo-5804-004).
 *
 * The gate must:
 *   - REFUSE to advance while the latest report at the matching changes hash
 *     is NEEDS_WORK (blocked instruction, work state untouched)
 *   - re-dispatch /check2 when the hash/HEAD drifted since completion
 *   - advance to pr only when complete + reports pass at the current hash
 *
 * SHA probes injected via deps.probes — no git required.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { dispatchAdvanceGate } = require(path.join(__dirname, '..', 'check-gate'));
const { ALL_STEPS } = require(
  path.join(__dirname, '..', '..', '..', '..', 'work', 'step-registry')
);

const HASH_A = 'aaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbb';

let tasksDir;
let savedWs;

beforeEach(() => {
  tasksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-gate-test-'));
  savedWs = null;
});
afterEach(() => {
  fs.rmSync(tasksDir, { recursive: true, force: true });
});

function writeCheckState(overrides = {}) {
  fs.writeFileSync(
    path.join(tasksDir, '.check2-state.json'),
    JSON.stringify({ ticketId: 'GH-1', status: 'complete', changesHash: HASH_A, ...overrides })
  );
}

function writeReport(file, status, hash) {
  fs.writeFileSync(
    path.join(tasksDir, file),
    [`**Changes Hash:** ${hash}`, '', `Status: ${status}`].join('\n')
  );
}

function writeAllApproved(hash) {
  writeReport('tests.check.md', 'APPROVED', hash);
  writeReport('code-review.check.md', 'APPROVED', hash);
  writeReport('completion.check.md', 'COMPLETE', hash);
}

function makeWs() {
  return {
    ticketId: 'GH-1',
    stepStatus: { check: 'in_progress', pr: 'pending' },
    currentStep: ALL_STEPS.indexOf('check') + 1,
    _work2Dispatched: 'check',
    _work2DispatchedAction: 'RUN',
  };
}

function makeDeps(ws, probes) {
  return {
    loadWorkState: () => ws,
    saveWorkState: (_name, state) => {
      savedWs = state;
    },
    probes,
    log: null,
    recursionDepth: 0,
  };
}

describe('check dispatch-advance gate — SHA + severity refusal', () => {
  it('advances check→pr when complete and reports pass at the current hash', () => {
    writeCheckState();
    writeAllApproved(HASH_A);
    const ws = makeWs();
    const out = dispatchAdvanceGate(
      'GH-1',
      { tasksDir },
      makeDeps(ws, { currentHash: HASH_A, currentHead: null })
    );
    assert.deepEqual(out, { recurse: true });
    assert.equal(savedWs.stepStatus.check, 'completed');
    assert.equal(savedWs.stepStatus.pr, 'in_progress');
  });

  it('REFUSES to advance when a report at the matching hash is NEEDS_WORK', () => {
    writeCheckState();
    writeReport('tests.check.md', 'APPROVED', HASH_A);
    writeReport('code-review.check.md', 'NEEDS_WORK', HASH_A);
    writeReport('completion.check.md', 'COMPLETE', HASH_A);
    const ws = makeWs();
    const out = dispatchAdvanceGate(
      'GH-1',
      { tasksDir },
      makeDeps(ws, { currentHash: HASH_A, currentHead: null })
    );
    assert.equal(out.action, 'blocked');
    assert.match(out.reason, /code-review\.check\.md/);
    // Work state must NOT have been advanced to pr
    assert.equal(savedWs, null);
    assert.equal(ws.stepStatus.pr, 'pending');
  });

  it('refuses when check2 state itself is needs_work at the current hash', () => {
    writeCheckState({ status: 'needs_work' });
    writeReport('code-review.check.md', 'NEEDS_WORK', HASH_A);
    const out = dispatchAdvanceGate(
      'GH-1',
      { tasksDir },
      makeDeps(makeWs(), { currentHash: HASH_A, currentHead: null })
    );
    assert.equal(out.action, 'blocked');
  });

  it('re-dispatches /check2 (recurse, check stays in_progress) when the hash drifted', () => {
    writeCheckState({ changesHash: HASH_A });
    writeAllApproved(HASH_A);
    const ws = makeWs();
    const out = dispatchAdvanceGate(
      'GH-1',
      { tasksDir },
      makeDeps(ws, { currentHash: HASH_B, currentHead: null })
    );
    assert.deepEqual(out, { recurse: true });
    assert.equal(savedWs.stepStatus.check, 'in_progress');
    assert.equal(savedWs.stepStatus.pr, 'pending', 'must not advance to pr on drift');
    assert.equal(savedWs._work2Dispatched, undefined, 'dispatch marker cleared for re-dispatch');
  });

  it('still advances when SHAs cannot be computed (fail-safe) and reports pass', () => {
    writeCheckState();
    writeAllApproved(HASH_A);
    const out = dispatchAdvanceGate(
      'GH-1',
      { tasksDir },
      makeDeps(makeWs(), { currentHash: null, currentHead: null })
    );
    assert.deepEqual(out, { recurse: true });
    assert.equal(savedWs.stepStatus.check, 'completed');
  });

  it('returns null when no check2 state exists', () => {
    const out = dispatchAdvanceGate('GH-1', { tasksDir }, makeDeps(makeWs(), {}));
    assert.equal(out, null);
  });
});
