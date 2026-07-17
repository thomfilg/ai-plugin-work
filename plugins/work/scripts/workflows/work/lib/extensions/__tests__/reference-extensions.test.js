/**
 * Unit tests for the three Phase-1 reference extensions:
 *   - cortex-auto-recall.js     (OnTicketResolved)
 *   - flaky-test-runbook.js     (OnAgentResponseMatched, match /flak(e|y)/i)
 *   - rulesync-redirect.js      (Phase-3 event — registers-but-inert)
 *
 * Each file is required directly to assert its export shape; then the loader is
 * exercised over a temp `.claude/work-extensions/` containing copies of the
 * real reference files to confirm they pass validation and register exactly
 * the events they declare.
 *
 * Covers Task 10 acceptance criteria.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REFERENCES_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'references',
  'work-extensions'
);
const LOADER_PATH = path.resolve(__dirname, '..', 'loader.js');
const EVENT_BUS_PATH = path.resolve(__dirname, '..', 'event-bus.js');
const CTX_PATH = path.resolve(__dirname, '..', 'ctx.js');

const CORTEX = path.join(REFERENCES_DIR, 'cortex-auto-recall.js');
const FLAKY = path.join(REFERENCES_DIR, 'flaky-test-runbook.js');
const RULESYNC = path.join(REFERENCES_DIR, 'rulesync-redirect.js');

function freshRequire(p) {
  delete require.cache[require.resolve(p)];
  return require(p);
}

function loadLoader() {
  return freshRequire(LOADER_PATH);
}
function loadBus() {
  return freshRequire(EVENT_BUS_PATH);
}
function loadCtx() {
  return freshRequire(CTX_PATH);
}

function makeTempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refext-test-'));
  const tasksDir = path.join(root, 'tasks', 'GH-522');
  fs.mkdirSync(tasksDir, { recursive: true });
  const extDir = path.join(root, '.claude', 'work-extensions');
  fs.mkdirSync(extDir, { recursive: true });
  return { root, tasksDir, extDir };
}

function copyRef(srcAbs, extDir) {
  const dest = path.join(extDir, path.basename(srcAbs));
  fs.copyFileSync(srcAbs, dest);
  return dest;
}

function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = (chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    const result = fn();
    return { result, stderr: chunks.join('') };
  } finally {
    process.stderr.write = original;
  }
}

describe('reference extensions — exports', () => {
  it('cortex-auto-recall declares OnTicketResolved and a function handler', () => {
    const mod = freshRequire(CORTEX);
    assert.ok(mod && typeof mod === 'object');
    assert.deepEqual(mod.events, ['OnTicketResolved']);
    assert.equal(typeof mod.handler, 'function');
  });

  it('cortex-auto-recall handler calls ctx.injectContext with cortex-recall content', async () => {
    const mod = freshRequire(CORTEX);
    const injected = [];
    const ctx = {
      event: 'OnTicketResolved',
      payload: {},
      injectContext: (text) => injected.push(String(text)),
      passthrough: () => {},
    };
    await mod.handler({ ticketId: 'GH-1', ticket: { title: 't' } }, ctx);
    assert.ok(injected.length >= 1, 'expected at least one injectContext call');
    assert.match(injected.join('\n'), /cortex/i);
  });

  it('flaky-test-runbook declares OnAgentResponseMatched with /flak(e|y)/i match', () => {
    const mod = freshRequire(FLAKY);
    assert.deepEqual(mod.events, ['OnAgentResponseMatched']);
    assert.ok(mod.match instanceof RegExp, 'match must be a RegExp');
    assert.equal(mod.match.source, 'flak(e|y)');
    assert.match(mod.match.flags, /i/);
    assert.equal(typeof mod.handler, 'function');
  });

  it('flaky-test-runbook handler calls ctx.injectContext with runbook content', async () => {
    const mod = freshRequire(FLAKY);
    const injected = [];
    const ctx = {
      event: 'OnAgentResponseMatched',
      payload: {},
      injectContext: (text) => injected.push(String(text)),
      passthrough: () => {},
    };
    await mod.handler({ text: 'this test is flaky' }, ctx);
    assert.ok(injected.length >= 1, 'expected at least one injectContext call');
    assert.match(injected.join('\n'), /flak|runbook/i);
  });

  it('rulesync-redirect declares a Phase-3 event (OnReadDenied)', () => {
    const mod = freshRequire(RULESYNC);
    assert.ok(Array.isArray(mod.events) && mod.events.length > 0);
    assert.ok(
      mod.events.includes('OnReadDenied'),
      `expected OnReadDenied among events, got ${JSON.stringify(mod.events)}`
    );
    assert.equal(typeof mod.handler, 'function');
  });
});

describe('reference extensions — loader integration', () => {
  let tmpDirs = [];

  beforeEach(() => {
    tmpDirs = [];
  });

  afterEach(() => {
    for (const d of tmpDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('all three reference files load via the real loader without error', () => {
    const { root, tasksDir, extDir } = makeTempRepo();
    tmpDirs.push(root);
    copyRef(CORTEX, extDir);
    copyRef(FLAKY, extDir);
    copyRef(RULESYNC, extDir);

    const { loadExtensions } = loadLoader();
    const bus = loadBus();

    const { result: status, stderr } = captureStderr(() =>
      loadExtensions({ repoRoot: root, tasksDir, bus })
    );

    assert.equal(status.length, 3, `expected 3 status entries, got ${status.length}`);
    for (const entry of status) {
      assert.equal(entry.loaded, true, `${entry.file} failed: ${entry.error || ''}`);
    }

    // rulesync-redirect should log a Phase 3 not-enabled notice but still register.
    assert.match(stderr, /Phase 3 not yet enabled/i);
  });

  it('registers exactly the declared events on the bus', () => {
    const { root, tasksDir, extDir } = makeTempRepo();
    tmpDirs.push(root);
    copyRef(CORTEX, extDir);
    copyRef(FLAKY, extDir);
    copyRef(RULESYNC, extDir);

    const { loadExtensions } = loadLoader();
    const bus = loadBus();

    captureStderr(() => loadExtensions({ repoRoot: root, tasksDir, bus }));

    assert.equal(bus.listHandlers('OnTicketResolved').length, 1);
    assert.equal(bus.listHandlers('OnAgentResponseMatched').length, 1);
    assert.equal(bus.listHandlers('OnReadDenied').length, 1);
    // No stray registrations on a Phase-1 event the references don't declare.
    assert.equal(bus.listHandlers('OnSessionStart').length, 0);
  });

  it('cortex extension dispatches end-to-end via event-bus and injects context', async () => {
    const { root, tasksDir, extDir } = makeTempRepo();
    tmpDirs.push(root);
    copyRef(CORTEX, extDir);

    const { loadExtensions } = loadLoader();
    const bus = loadBus();
    const { createCtx } = loadCtx();

    captureStderr(() => loadExtensions({ repoRoot: root, tasksDir, bus }));

    const ctx = createCtx({
      event: 'OnTicketResolved',
      payload: { ticketId: 'GH-99' },
    });
    await bus.dispatch('OnTicketResolved', { ticketId: 'GH-99' }, ctx);

    const injected = ctx.getInjectedContext();
    assert.ok(injected.length > 0, 'expected injected context after dispatch');
    assert.match(injected, /cortex/i);
  });
});
