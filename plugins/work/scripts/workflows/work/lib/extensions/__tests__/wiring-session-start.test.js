/**
 * Task 5 — Wiring: OnSessionStart dispatch in work-next.js.
 *
 * Asserts:
 *   - `work-next.js` exposes a `fireSessionStart` helper that invokes
 *     `initExtensions(...).dispatch('OnSessionStart', {ticketId, tasksDir, repoRoot})`
 *     after `findActiveMarker` returns truthy.
 *   - No dispatch occurs when `findActiveMarker` returns null.
 *   - The dispatch fires exactly once per process invocation (idempotent).
 *
 * The test stubs `findActiveMarker` and `initExtensions` via injectable deps so
 * we avoid touching real provider config or filesystem state.
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const WORK_NEXT_PATH = path.resolve(__dirname, '..', '..', '..', 'work-next.js');

function loadWorkNext() {
  delete require.cache[require.resolve(WORK_NEXT_PATH)];
  return require(WORK_NEXT_PATH);
}

describe('work-next.js — OnSessionStart wiring (Task 5)', () => {
  let mod;
  beforeEach(() => {
    mod = loadWorkNext();
  });

  it('exports fireSessionStart helper', () => {
    assert.equal(typeof mod.fireSessionStart, 'function');
  });

  it('dispatches OnSessionStart with {ticketId, tasksDir, repoRoot} payload when marker is active', () => {
    const calls = [];
    const deps = {
      findActiveMarker: () => ({ ticket: 'GH-522', sessionId: 's1' }),
      initExtensions: ({ repoRoot, tasksDir }) => ({
        dispatch: (event, payload) => {
          calls.push({ event, payload, repoRoot, tasksDir });
        },
        status: () => [],
      }),
    };
    mod.fireSessionStart(
      { ticketId: 'GH-522', tasksDir: '/tmp/tasks/GH-522', repoRoot: '/tmp/repo' },
      deps
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].event, 'OnSessionStart');
    assert.deepEqual(calls[0].payload, {
      ticketId: 'GH-522',
      tasksDir: '/tmp/tasks/GH-522',
      repoRoot: '/tmp/repo',
    });
    assert.equal(calls[0].repoRoot, '/tmp/repo');
    assert.equal(calls[0].tasksDir, '/tmp/tasks/GH-522');
  });

  it('does not dispatch when findActiveMarker returns null', () => {
    const calls = [];
    const deps = {
      findActiveMarker: () => null,
      initExtensions: () => ({
        dispatch: (event, payload) => {
          calls.push({ event, payload });
        },
        status: () => [],
      }),
    };
    mod.fireSessionStart(
      { ticketId: 'GH-522', tasksDir: '/tmp/tasks/GH-522', repoRoot: '/tmp/repo' },
      deps
    );
    assert.equal(calls.length, 0);
  });

  it('is idempotent — dispatches exactly once even when invoked repeatedly in the same process', () => {
    const calls = [];
    const deps = {
      findActiveMarker: () => ({ ticket: 'GH-522', sessionId: 's1' }),
      initExtensions: () => ({
        dispatch: (event, payload) => {
          calls.push({ event, payload });
        },
        status: () => [],
      }),
    };
    const args = { ticketId: 'GH-522', tasksDir: '/tmp/tasks/GH-522', repoRoot: '/tmp/repo' };
    mod.fireSessionStart(args, deps);
    mod.fireSessionStart(args, deps);
    mod.fireSessionStart(args, deps);
    assert.equal(calls.length, 1, 'OnSessionStart must dispatch exactly once per process');
  });
});
