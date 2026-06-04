/**
 * Unit tests for the extensions public entry point — `initExtensions`.
 * Covers Task 4 acceptance criteria (R3, R6, R8).
 *
 * Run with:
 *   node --test plugins/work/scripts/workflows/work/lib/extensions/__tests__/index.test.js
 */

'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const INDEX_PATH = path.resolve(__dirname, '..', 'index.js');
const EVENT_BUS_PATH = path.resolve(__dirname, '..', 'event-bus.js');

function loadIndex() {
  // Force fresh module + fresh event-bus (event-bus has module-level state).
  delete require.cache[require.resolve(INDEX_PATH)];
  delete require.cache[require.resolve(EVENT_BUS_PATH)];
  return require(INDEX_PATH);
}

function makeTempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'index-test-'));
  const tasksDir = path.join(root, 'tasks', 'GH-522');
  fs.mkdirSync(tasksDir, { recursive: true });
  return { root, tasksDir };
}

function makeExtensionsDir(repoRoot) {
  const extDir = path.join(repoRoot, '.claude', 'work-extensions');
  fs.mkdirSync(extDir, { recursive: true });
  return extDir;
}

function writeExt(extDir, name, body) {
  const full = path.join(extDir, name);
  fs.writeFileSync(full, body);
  return full;
}

const created = [];
afterEach(() => {
  while (created.length) {
    const dir = created.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function freshRepo() {
  const r = makeTempRepo();
  created.push(r.root);
  return r;
}

describe('initExtensions — public entry point', () => {
  it('exports initExtensions as a function', () => {
    const mod = loadIndex();
    assert.equal(typeof mod.initExtensions, 'function');
  });

  it('returns an object with dispatch and status functions', () => {
    const { initExtensions } = loadIndex();
    const { root, tasksDir } = freshRepo();
    const api = initExtensions({ repoRoot: root, tasksDir });
    assert.equal(typeof api.dispatch, 'function');
    assert.equal(typeof api.status, 'function');
  });

  it('returns empty status and dispatch is a safe no-op when no extensions dir exists (R8)', async () => {
    const { initExtensions } = loadIndex();
    const { root, tasksDir } = freshRepo();
    const api = initExtensions({ repoRoot: root, tasksDir });
    assert.deepEqual(api.status(), []);
    // dispatch must not throw even with no handlers registered
    await api.dispatch('OnSessionStart', { ticketId: 'GH-522' });
  });

  it('status() returns loader entries with file/events/loaded for a valid extension', () => {
    const { initExtensions } = loadIndex();
    const { root, tasksDir } = freshRepo();
    const extDir = makeExtensionsDir(root);
    writeExt(
      extDir,
      'valid-ext.js',
      `module.exports = { events: ['OnTicketResolved'], handler: () => {} };`
    );
    const api = initExtensions({ repoRoot: root, tasksDir });
    const status = api.status();
    assert.equal(status.length, 1);
    assert.equal(status[0].loaded, true);
    assert.deepEqual(status[0].events, ['OnTicketResolved']);
    assert.match(status[0].file, /valid-ext\.js$/);
  });

  it('dispatch invokes a registered handler with a ctx built from createCtx', async () => {
    const { initExtensions } = loadIndex();
    const { root, tasksDir } = freshRepo();
    const extDir = makeExtensionsDir(root);
    // The handler writes into a sentinel file so we can verify it was invoked
    // with the right payload and a real ctx (passthrough + injectContext present).
    const sentinel = path.join(root, 'sentinel.json');
    writeExt(
      extDir,
      'capture.js',
      `const fs = require('node:fs');
module.exports = {
  events: ['OnTicketResolved'],
  handler: (payload, ctx) => {
    ctx.injectContext('hello from ext');
    fs.writeFileSync(${JSON.stringify(sentinel)}, JSON.stringify({
      event: ctx.event,
      payload,
      hasPassthrough: typeof ctx.passthrough === 'function',
      injected: ctx.getInjectedContext(),
    }));
  },
};`
    );
    const api = initExtensions({ repoRoot: root, tasksDir });
    await api.dispatch('OnTicketResolved', { ticketId: 'GH-522' });
    const captured = JSON.parse(fs.readFileSync(sentinel, 'utf8'));
    assert.equal(captured.event, 'OnTicketResolved');
    assert.deepEqual(captured.payload, { ticketId: 'GH-522' });
    assert.equal(captured.hasPassthrough, true);
    assert.equal(captured.injected, 'hello from ext');
  });

  it('memoizes the result per (repoRoot, tasksDir) — does not re-load on repeat calls', () => {
    const { initExtensions } = loadIndex();
    const { root, tasksDir } = freshRepo();
    const extDir = makeExtensionsDir(root);
    writeExt(extDir, 'a.js', `module.exports = { events: ['OnSessionStart'], handler: () => {} };`);
    const a = initExtensions({ repoRoot: root, tasksDir });
    const firstStatus = a.status();
    // Add a second extension AFTER init — memoization means it must not appear.
    writeExt(extDir, 'b.js', `module.exports = { events: ['OnSessionStart'], handler: () => {} };`);
    const b = initExtensions({ repoRoot: root, tasksDir });
    assert.equal(a, b, 'same keypair must return the identical API object');
    assert.deepEqual(
      b.status(),
      firstStatus,
      'status must be the original loader result, not re-loaded'
    );
    assert.equal(b.status().length, 1);
  });

  it('returns a different instance for a different (repoRoot, tasksDir) keypair', () => {
    const { initExtensions } = loadIndex();
    const r1 = freshRepo();
    const r2 = freshRepo();
    const a = initExtensions({ repoRoot: r1.root, tasksDir: r1.tasksDir });
    const b = initExtensions({ repoRoot: r2.root, tasksDir: r2.tasksDir });
    assert.notEqual(a, b);
  });

  it('dispatch is a safe no-op for an event name with no registered handlers', async () => {
    const { initExtensions } = loadIndex();
    const { root, tasksDir } = freshRepo();
    const extDir = makeExtensionsDir(root);
    writeExt(
      extDir,
      'only-session.js',
      `module.exports = { events: ['OnSessionStart'], handler: () => {} };`
    );
    const api = initExtensions({ repoRoot: root, tasksDir });
    // Dispatching an event nobody subscribed to must not throw (R6/R8).
    await api.dispatch('OnTicketResolved', { ticketId: 'GH-522' });
  });

  it('isolates a throwing handler from the dispatch caller (R6)', async () => {
    const { initExtensions } = loadIndex();
    const { root, tasksDir } = freshRepo();
    const extDir = makeExtensionsDir(root);
    writeExt(
      extDir,
      'boom.js',
      `module.exports = {
        events: ['OnTicketResolved'],
        handler: () => { throw new Error('boom'); },
      };`
    );
    const api = initExtensions({ repoRoot: root, tasksDir });
    // event-bus catches handler errors and logs — dispatch must resolve.
    await api.dispatch('OnTicketResolved', { ticketId: 'GH-522' });
  });
});
