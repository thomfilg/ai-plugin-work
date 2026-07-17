/**
 * Unit tests for event-bus: register + dispatch.
 * Covers Task 1 acceptance criteria (R9, G6).
 *
 * Run with:
 *   node --test plugins/work/scripts/workflows/work/lib/extensions/__tests__/event-bus.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const EVENT_BUS_PATH = path.resolve(__dirname, '..', 'event-bus.js');

function loadBus() {
  delete require.cache[require.resolve(EVENT_BUS_PATH)];
  return require(EVENT_BUS_PATH);
}

describe('event-bus', () => {
  let bus;

  beforeEach(() => {
    bus = loadBus();
  });

  describe('register', () => {
    it('registers a handler with explicit priority and sourceFile', () => {
      const handler = () => {};
      bus.register({
        eventName: 'OnTicketResolved',
        handler,
        priority: 100,
        sourceFile: 'a.js',
      });
      const handlers = bus.listHandlers('OnTicketResolved');
      assert.equal(handlers.length, 1);
      assert.equal(handlers[0].handler, handler);
      assert.equal(handlers[0].priority, 100);
      assert.equal(handlers[0].sourceFile, 'a.js');
    });

    it('applies default priority of 50 when not provided', () => {
      bus.register({
        eventName: 'OnTicketResolved',
        handler: () => {},
        sourceFile: 'a.js',
      });
      const handlers = bus.listHandlers('OnTicketResolved');
      assert.equal(handlers[0].priority, 50);
    });
  });

  describe('dispatch — Handlers run in priority order with lexical filename tiebreaker (G6)', () => {
    it('runs c.js (prio 100) before a.js and b.js (default 50); a.js before b.js', async () => {
      const callOrder = [];
      bus.register({
        eventName: 'OnTicketResolved',
        handler: async () => {
          callOrder.push('b');
        },
        sourceFile: 'b.js',
      });
      bus.register({
        eventName: 'OnTicketResolved',
        handler: async () => {
          callOrder.push('c');
        },
        priority: 100,
        sourceFile: 'c.js',
      });
      bus.register({
        eventName: 'OnTicketResolved',
        handler: async () => {
          callOrder.push('a');
        },
        sourceFile: 'a.js',
      });

      await bus.dispatch(
        'OnTicketResolved',
        { ticketId: 'GH-1' },
        {
          passthrough: () => {},
        }
      );

      assert.deepEqual(callOrder, ['c', 'a', 'b']);
    });

    it('orders by descending priority across mixed values', async () => {
      const order = [];
      bus.register({
        eventName: 'E',
        handler: () => {
          order.push('low');
        },
        priority: 10,
        sourceFile: 'low.js',
      });
      bus.register({
        eventName: 'E',
        handler: () => {
          order.push('high');
        },
        priority: 200,
        sourceFile: 'high.js',
      });
      bus.register({
        eventName: 'E',
        handler: () => {
          order.push('mid');
        },
        priority: 75,
        sourceFile: 'mid.js',
      });

      await bus.dispatch('E', {}, { passthrough: () => {} });
      assert.deepEqual(order, ['high', 'mid', 'low']);
    });

    it('awaits each handler and continues on passthrough', async () => {
      const order = [];
      bus.register({
        eventName: 'E',
        handler: async () => {
          await new Promise((r) => setImmediate(r));
          order.push('first');
        },
        priority: 100,
        sourceFile: 'a.js',
      });
      bus.register({
        eventName: 'E',
        handler: async () => {
          order.push('second');
        },
        priority: 50,
        sourceFile: 'b.js',
      });
      await bus.dispatch('E', {}, { passthrough: () => {} });
      assert.deepEqual(order, ['first', 'second']);
    });

    it('dispatch with no handlers is a no-op', async () => {
      await bus.dispatch('Nothing', {}, { passthrough: () => {} });
    });
  });

  describe('listHandlers', () => {
    it('returns empty array for unknown event', () => {
      assert.deepEqual(bus.listHandlers('Unknown'), []);
    });
  });
});
