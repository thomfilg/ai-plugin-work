'use strict';

// Verify that follow-up-next's "Already complete" fast-path now re-verifies
// against GitHub before honoring the saved status. Regression: PR #1929 had
// 9 IN_PROGRESS checks + 2 unpushed commits but the cached state declared
// the workflow complete and the session guard self-cleared.

process.env.FOLLOW_UP2_NO_DELAY = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ─── Stub pr-mergeable BEFORE follow-up-next loads ──────────────────────────

const prMergeablePath = require.resolve('../../work/lib/pr-mergeable.js');
let stubMergeableResult = null;
require.cache[prMergeablePath] = {
  id: prMergeablePath,
  filename: prMergeablePath,
  loaded: true,
  exports: {
    assessMergeable() {
      return stubMergeableResult;
    },
    classify: () => stubMergeableResult,
  },
};

// Isolate state directory per test.
let tmpRoot;
test.beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'follow-up-reverify-'));
  process.env.TASKS_BASE = tmpRoot;
  process.env.WORKTREES_BASE = tmpRoot;
});
test.afterEach(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function loadFresh() {
  // Re-resolve follow-up-next each test so it picks up the env vars.
  const p = require.resolve('../follow-up-next.js');
  delete require.cache[p];
  return require(p);
}

function writeState(ticketId, state) {
  const dir = path.join(tmpRoot, ticketId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.follow-up-state.json'), JSON.stringify(state));
}

function readState(ticketId) {
  const p = path.join(tmpRoot, ticketId, '.follow-up-state.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('saved state complete + PR mergeable → fast path honored', () => {
  stubMergeableResult = { mergeable: true, blockers: [], signals: { prState: 'MERGED' } };
  writeState('TEST-1', {
    ticketId: 'TEST-1',
    prNumber: 999,
    currentStep: 'report',
    status: 'complete',
  });
  const mod = loadFresh();
  const r = mod.getNextInstruction('TEST-1', 999);
  assert.equal(r.action, 'complete');
  assert.match(r.summary, /Already complete/i);
});

test('saved state complete + PR NOT mergeable → rewinds, does not return complete', () => {
  stubMergeableResult = {
    mergeable: false,
    blockers: [
      { kind: 'checks_running', detail: '9 still running' },
      { kind: 'merge_state_blocked', detail: 'blocked' },
    ],
    signals: { prState: 'OPEN' },
  };
  // Use a currentStep value that IS in STEPS so the loop will exit the
  // outer "complete" block immediately after rewind without recursing into
  // an invalid-step path.
  const mod = loadFresh();
  const { STEPS } = require('../lib/step-registry');
  writeState('TEST-2', {
    ticketId: 'TEST-2',
    prNumber: 1929,
    currentStep: STEPS[STEPS.length - 1],
    status: 'complete',
  });

  const origStderr = process.stderr.write;
  let stderrCaptured = '';
  process.stderr.write = (chunk) => {
    stderrCaptured += String(chunk);
    return true;
  };
  try {
    try {
      mod.getNextInstruction('TEST-2', 1929);
    } catch {
      /* expected — runStep dispatch isn't stubbed */
    }
  } finally {
    process.stderr.write = origStderr;
  }
  const after = readState('TEST-2');
  assert.notEqual(after.status, 'complete', 'status should have been rewound');
  assert.match(stderrCaptured, /rewinding/i);
});

test('saved state complete + PR number missing → fast path honored (no reverify possible)', () => {
  stubMergeableResult = null; // shouldn't be called
  writeState('TEST-3', {
    ticketId: 'TEST-3',
    prNumber: null,
    currentStep: 'report',
    status: 'complete',
  });
  const mod = loadFresh();
  const r = mod.getNextInstruction('TEST-3', null);
  assert.equal(r.action, 'complete');
});
