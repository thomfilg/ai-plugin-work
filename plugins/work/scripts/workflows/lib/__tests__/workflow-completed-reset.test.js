/**
 * Tests for the GH-307 completed-state SHA gate:
 *   - workflow-engine resolveCompletedState() — archive-on-drift / refuse-on-match
 *   - WorkflowState.archive() — audit-trail archival, never silent deletion
 *     (per-workflow completedStaleCheck SHA conditions are covered by the
 *     script-driven check tests in workflows/check/__tests__/staleness.test.js)
 *
 * node:test + node:assert/strict; temp state dirs via fs.mkdtempSync.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveCompletedState } = require(path.join(__dirname, '..', 'workflow-engine'));
const { WorkflowState } = require(path.join(__dirname, '..', 'workflow-state'));

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-completed-reset-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('WorkflowState.archive', () => {
  it('archives the state file with reason + timestamp and removes the live file', () => {
    const st = new WorkflowState('check', dir);
    st.init('T-1', ['1_setup', '9_cleanup']);
    const archivedTo = st.archive('T-1', 'sha-drift: test');
    assert.ok(archivedTo && /\.archived-\d+$/.test(archivedTo));
    assert.equal(st.load('T-1'), null, 'live state must be gone');
    const archived = JSON.parse(fs.readFileSync(archivedTo, 'utf8'));
    assert.equal(archived.archivedReason, 'sha-drift: test');
    assert.ok(archived.archivedAt);
  });

  it('returns null when no state exists', () => {
    const st = new WorkflowState('check', dir);
    assert.equal(st.archive('T-none', 'x'), null);
  });
});

describe('resolveCompletedState', () => {
  function completedState(st, instanceId, extra = {}) {
    st.init(instanceId, ['1_setup', '9_cleanup']);
    const ws = st.load(instanceId);
    ws.status = 'completed';
    Object.assign(ws, extra);
    st.save(instanceId, ws);
  }

  it('returns null for workflows without completedStaleCheck or non-completed state', () => {
    const st = new WorkflowState('check', dir);
    assert.equal(resolveCompletedState({}, st, 'T-1'), null);
    completedState(st, 'T-1');
    assert.equal(resolveCompletedState({}, st, 'T-1'), null); // no hook
    const wf = { completedStaleCheck: () => ({ stale: true, reasons: ['x'] }) };
    assert.equal(resolveCompletedState(wf, st, 'T-none'), null); // no state
  });

  it('archives + resets when the workflow reports SHA drift', () => {
    const st = new WorkflowState('check', dir);
    completedState(st, 'T-1');
    const wf = {
      completedStaleCheck: () => ({ stale: true, reasons: ['sha-drift: changes hash a → b'] }),
    };
    const res = resolveCompletedState(wf, st, 'T-1');
    assert.equal(res.reset, true);
    assert.ok(res.archivedTo);
    assert.equal(st.load('T-1'), null, 'a fresh instance can now be planned');
  });

  it('refuses the reset (keeps state) when SHAs match', () => {
    const st = new WorkflowState('check', dir);
    completedState(st, 'T-1');
    const wf = { completedStaleCheck: () => ({ stale: false, reasons: [] }) };
    const res = resolveCompletedState(wf, st, 'T-1');
    assert.equal(res.reset, false);
    assert.match(res.message, /nothing to re-run/i);
    assert.ok(st.load('T-1'), 'completed state must be preserved');
  });

  it('fail-safe: keeps completed state when the stale check throws', () => {
    const st = new WorkflowState('check', dir);
    completedState(st, 'T-1');
    const wf = {
      completedStaleCheck: () => {
        throw new Error('git unavailable');
      },
    };
    const res = resolveCompletedState(wf, st, 'T-1');
    assert.equal(res.reset, false);
    assert.ok(st.load('T-1'));
  });
});
