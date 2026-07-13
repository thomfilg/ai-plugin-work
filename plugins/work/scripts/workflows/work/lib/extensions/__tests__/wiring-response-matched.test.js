/**
 * Task 8 — Wiring: OnAgentResponseMatched (work-auto-advance.js) via safeRegex.
 *
 * Asserts:
 *   - `event-bus.register` compiles `match` once at registration time via
 *     `safeRegex` from `plugins/synapsys/lib/matcher.js`, stored as `match.compiled`.
 *   - Invalid regex patterns are rejected at registration (throws), so the
 *     dispatcher path stays compile-free.
 *   - `hooks/work-auto-advance.js` exposes a `fireAgentResponseMatched(args, deps)`
 *     helper that iterates `OnAgentResponseMatched` handlers and dispatches
 *     only when `responseText` matches the handler's compiled `match`, with
 *     payload `{ responseText, match: { pattern, substring } }` (G9).
 *   - Helper gated on `findActiveMarker` truthy; no dispatch when null.
 *   - Errors thrown inside dispatch never crash the hook.
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EVENT_BUS_PATH = path.resolve(__dirname, '..', 'event-bus.js');
const POST_HOOK_PATH = path.resolve(__dirname, '..', '..', '..', 'hooks', 'work-auto-advance.js');

function loadBus() {
  delete require.cache[require.resolve(EVENT_BUS_PATH)];
  return require(EVENT_BUS_PATH);
}

describe('event-bus — compile-on-register via safeRegex (Task 8)', () => {
  let bus;
  beforeEach(() => {
    bus = loadBus();
  });

  it('compiles a RegExp `match` at registration and stores it on the record', () => {
    const re = /flak(e|y)/i;
    bus.register({
      eventName: 'OnAgentResponseMatched',
      handler: () => {},
      sourceFile: 'x.js',
      match: re,
    });
    const handlers = bus.listHandlers('OnAgentResponseMatched');
    assert.equal(handlers.length, 1);
    const record = handlers[0];
    assert.ok(record.match, 'expected match record');
    assert.ok(record.match.compiled instanceof RegExp, 'expected compiled RegExp on match');
    assert.equal(record.match.pattern, 'flak(e|y)');
    assert.equal(record.match.compiled.test('the test is flaky'), true);
  });

  it('compiles a string `match` at registration via safeRegex', () => {
    bus.register({
      eventName: 'OnAgentResponseMatched',
      handler: () => {},
      sourceFile: 'x.js',
      match: 'flak(e|y)',
    });
    const handlers = bus.listHandlers('OnAgentResponseMatched');
    assert.ok(handlers[0].match.compiled instanceof RegExp);
    assert.equal(handlers[0].match.pattern, 'flak(e|y)');
    assert.equal(handlers[0].match.compiled.test('flaky'), true);
  });

  it('rejects invalid regex at registration (does not register)', () => {
    assert.throws(
      () =>
        bus.register({
          eventName: 'OnAgentResponseMatched',
          handler: () => {},
          sourceFile: 'x.js',
          match: '(unclosed',
        }),
      /invalid|regex|match/i
    );
    assert.equal(bus.listHandlers('OnAgentResponseMatched').length, 0);
  });
});

function runHelperInChild(args, dispatchOpts, handlers) {
  const script = `
    'use strict';
    const mod = require(${JSON.stringify(POST_HOOK_PATH)});
    if (typeof mod.fireAgentResponseMatched !== 'function') {
      console.error('MISSING_EXPORT');
      process.exit(7);
    }
    const calls = [];
    const handlerSpecs = ${JSON.stringify(handlers || [])};
    const compiledHandlers = handlerSpecs.map((h) => ({
      eventName: 'OnAgentResponseMatched',
      handler: () => {},
      sourceFile: h.sourceFile,
      priority: 50,
      match: {
        pattern: h.pattern,
        compiled: new RegExp(h.pattern, h.flags || 'i'),
      },
    }));
    const deps = {
      findActiveMarker: () => (${JSON.stringify(dispatchOpts.markerReturns)} === 'truthy'
        ? { ticket: 'GH-522' }
        : null),
      initExtensions: ({ repoRoot, tasksDir }) => ({
        dispatch: (event, payload) => {
          if (${JSON.stringify(!!dispatchOpts.dispatchThrows)}) throw new Error('boom');
          calls.push({ event, payload, repoRoot, tasksDir });
        },
        listHandlers: (eventName) =>
          eventName === 'OnAgentResponseMatched' ? compiledHandlers : [],
        status: () => [],
      }),
    };
    let threw = false;
    try {
      mod.fireAgentResponseMatched(${JSON.stringify(args)}, deps);
    } catch (e) {
      threw = true;
    }
    process.stdout.write(JSON.stringify({ calls, threw }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, WORK_HOOK_NO_MAIN: '1' },
    encoding: 'utf8',
  });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  return { exitCode: result.status, stdoutJson: parsed, stderr: result.stderr };
}

describe('work-auto-advance.js — OnAgentResponseMatched wiring (Task 8)', () => {
  it('exports fireAgentResponseMatched helper', () => {
    const out = runHelperInChild(
      {
        responseText: 'the test is flaky',
        tasksDir: '/tmp/tasks/GH-522',
        repoRoot: '/tmp/repo',
      },
      { markerReturns: 'truthy' },
      [{ sourceFile: 'a.js', pattern: 'flak(e|y)' }]
    );
    assert.notEqual(out.exitCode, 7, 'fireAgentResponseMatched must be exported');
    assert.equal(out.exitCode, 0, `child failed: ${out.stderr}`);
    assert.ok(out.stdoutJson);
  });

  it('OnAgentResponseMatched fires when response contains the declared match pattern', () => {
    const out = runHelperInChild(
      {
        responseText: 'the test is flaky',
        tasksDir: '/tmp/tasks/GH-522',
        repoRoot: '/tmp/repo',
      },
      { markerReturns: 'truthy' },
      [{ sourceFile: 'a.js', pattern: 'flak(e|y)' }]
    );
    assert.equal(out.exitCode, 0, `child failed: ${out.stderr}`);
    assert.ok(out.stdoutJson);
    assert.equal(out.stdoutJson.calls.length, 1, 'expected one dispatch');
    const call = out.stdoutJson.calls[0];
    assert.equal(call.event, 'OnAgentResponseMatched');
    assert.equal(call.payload.responseText, 'the test is flaky');
    assert.equal(call.payload.match.pattern, 'flak(e|y)');
    assert.equal(call.payload.match.substring, 'flaky');
  });

  it('does not dispatch when responseText does not match', () => {
    const out = runHelperInChild(
      {
        responseText: 'all green, no issues',
        tasksDir: '/tmp/tasks/GH-522',
        repoRoot: '/tmp/repo',
      },
      { markerReturns: 'truthy' },
      [{ sourceFile: 'a.js', pattern: 'flak(e|y)' }]
    );
    assert.equal(out.exitCode, 0, `child failed: ${out.stderr}`);
    assert.ok(out.stdoutJson);
    assert.equal(out.stdoutJson.calls.length, 0);
  });

  it('does not dispatch when findActiveMarker returns null', () => {
    const out = runHelperInChild(
      {
        responseText: 'the test is flaky',
        tasksDir: '/tmp/tasks/GH-522',
        repoRoot: '/tmp/repo',
      },
      { markerReturns: 'null' },
      [{ sourceFile: 'a.js', pattern: 'flak(e|y)' }]
    );
    assert.equal(out.exitCode, 0, `child failed: ${out.stderr}`);
    assert.ok(out.stdoutJson);
    assert.equal(out.stdoutJson.calls.length, 0);
  });

  it('never crashes when dispatch throws', () => {
    const out = runHelperInChild(
      {
        responseText: 'the test is flaky',
        tasksDir: '/tmp/tasks/GH-522',
        repoRoot: '/tmp/repo',
      },
      { markerReturns: 'truthy', dispatchThrows: true },
      [{ sourceFile: 'a.js', pattern: 'flak(e|y)' }]
    );
    assert.equal(out.exitCode, 0, `child failed: ${out.stderr}`);
    assert.ok(out.stdoutJson);
    assert.equal(out.stdoutJson.threw, false);
  });
});
