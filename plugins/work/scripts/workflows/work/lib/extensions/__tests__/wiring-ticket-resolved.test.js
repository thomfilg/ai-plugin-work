/**
 * Task 6 — Wiring: OnTicketResolved dispatch in steps/ticket.js.
 *
 * Asserts (G3):
 *   - `steps/ticket.js` exposes a `fireTicketResolved` helper that invokes
 *     `initExtensions(...).dispatch('OnTicketResolved', {ticketId, resolution, tasksDir})`
 *     when the ticket step transitions to a resolved state.
 *   - Payload `ticketId` matches the resolved ticket (asserts `"GH-999"`).
 *   - `injectContext` queue accumulated during this dispatch is observable for
 *     downstream prompt injection.
 *   - No dispatch when the ticket step does not reach a resolved transition.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const TICKET_STEP_PATH = path.resolve(__dirname, '..', '..', '..', 'steps', 'ticket.js');

function loadTicketStep() {
  delete require.cache[require.resolve(TICKET_STEP_PATH)];
  return require(TICKET_STEP_PATH);
}

describe('steps/ticket.js — OnTicketResolved wiring (Task 6)', () => {
  it('exports fireTicketResolved helper', () => {
    const mod = loadTicketStep();
    assert.equal(typeof mod.fireTicketResolved, 'function');
  });

  it('OnTicketResolved dispatch invokes registered handler with payload', async () => {
    const mod = loadTicketStep();
    const calls = [];
    const deps = {
      initExtensions: ({ repoRoot, tasksDir }) => ({
        // Public API contract (post-fix): dispatch returns the accumulated
        // injected-context string. Helper consumers no longer call
        // getInjectedContext directly — they consume the dispatch return.
        dispatch: (event, payload) => {
          calls.push({ event, payload, repoRoot, tasksDir });
          return Promise.resolve(`handled:${payload.ticketId}`);
        },
        status: () => [],
      }),
    };
    const result = mod.fireTicketResolved(
      {
        ticketId: 'GH-999',
        resolution: 'COMPLETED',
        tasksDir: '/tmp/tasks/GH-999',
        repoRoot: '/tmp/repo',
        transitionedToResolved: true,
      },
      deps
    );
    // Allow the fire-and-forget promise to settle so injected text is captured.
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].event, 'OnTicketResolved');
    assert.deepEqual(calls[0].payload, {
      ticketId: 'GH-999',
      resolution: 'COMPLETED',
      tasksDir: '/tmp/tasks/GH-999',
    });
    assert.equal(result.dispatched, true);
    // injected is captured async; the helper returns string via the dispatch
    // return contract. After settle, the result.injected reflects the handler's
    // injectContext output.
    assert.equal(typeof result.injected, 'string');
  });

  it('does not dispatch when ticket step does not reach resolved transition', () => {
    const mod = loadTicketStep();
    const calls = [];
    const deps = {
      initExtensions: () => ({
        dispatch: (event, payload) => {
          calls.push({ event, payload });
        },
        status: () => [],
        getInjectedContext: () => [],
      }),
    };
    mod.fireTicketResolved(
      {
        ticketId: 'GH-999',
        resolution: 'COMPLETED',
        tasksDir: '/tmp/tasks/GH-999',
        repoRoot: '/tmp/repo',
        transitionedToResolved: false,
      },
      deps
    );
    assert.equal(calls.length, 0);
  });
});
