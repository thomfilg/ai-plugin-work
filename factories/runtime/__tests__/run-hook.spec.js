'use strict';

/**
 * Tests for factories/runtime/run-hook.js — the runtime-aware hook wrapper
 * (GH-774). Pure event resolution + defensive parse are unit-tested; the
 * fail-open / fail-closed / event-from-payload contracts are exercised by
 * spawning real hook scripts that require the factory by absolute path, since
 * those behaviors terminate the process.
 *
 * Run: node --test factories/runtime/__tests__/run-hook.spec.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RUN_HOOK_PATH = require.resolve('../run-hook');
const { resolveEvent, parsePayload } = require('../run-hook');

// --------------------------------------------------------------------------
// Unit: resolveEvent precedence + parsePayload defensiveness.
// --------------------------------------------------------------------------

describe('resolveEvent — payload-first precedence (codex omits CLAUDE_HOOK_TYPE)', () => {
  it('opts.event wins over every other source', () => {
    const raw = { hook_event_name: 'PostToolUse' };
    assert.equal(resolveEvent(raw, { event: 'Stop' }, { CLAUDE_HOOK_TYPE: 'PreToolUse' }), 'Stop');
  });

  it('CLAUDE_HOOK_TYPE env is used when opts.event is absent', () => {
    const raw = { hook_event_name: 'PostToolUse' };
    assert.equal(resolveEvent(raw, {}, { CLAUDE_HOOK_TYPE: 'PreToolUse' }), 'PreToolUse');
  });

  it('payload.hook_event_name resolves the event when the env is unset (codex)', () => {
    assert.equal(resolveEvent({ hook_event_name: 'Stop' }, {}, {}), 'Stop');
  });

  it('falls back to opts.defaultEvent when nothing else resolves', () => {
    assert.equal(resolveEvent({}, { defaultEvent: 'PostToolUse' }, {}), 'PostToolUse');
  });

  it('returns null when no source provides an event', () => {
    assert.equal(resolveEvent({}, {}, {}), null);
  });

  it('ignores a non-string hook_event_name', () => {
    assert.equal(resolveEvent({ hook_event_name: 42 }, { defaultEvent: 'Stop' }, {}), 'Stop');
  });
});

describe('parsePayload — never throws', () => {
  it('parses well-formed JSON', () => {
    assert.deepEqual(parsePayload('{"a":1}'), { a: 1 });
  });

  it('returns {} for empty and malformed input', () => {
    assert.deepEqual(parsePayload(''), {});
    assert.deepEqual(parsePayload('{nope'), {});
  });

  it('honors a caller fallback', () => {
    const fb = { d: true };
    assert.equal(parsePayload('', fb), fb);
  });
});

// --------------------------------------------------------------------------
// End-to-end: spawned hook scripts (behaviors that exit the process).
// --------------------------------------------------------------------------

function writeHookScript(dir, name, body) {
  const file = path.join(dir, name);
  const src = [
    "'use strict';",
    `const { runHook } = require(${JSON.stringify(RUN_HOOK_PATH)});`,
    body,
    '',
  ].join('\n');
  fs.writeFileSync(file, src);
  return file;
}

function spawnHook(script, input, extraEnv) {
  const env = { ...process.env, ...extraEnv };
  delete env.ENFORCE_HOOK_DEBUG;
  for (const key of ['CLAUDE_HOOK_TYPE', 'AGENT_RUNTIME', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID']) {
    if (!(extraEnv && key in extraEnv)) delete env[key];
  }
  return spawnSync(process.execPath, [script], { input, env, encoding: 'utf8', timeout: 15000 });
}

describe('runHook end-to-end (spawned hook scripts)', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-hook-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves the event from the codex payload (no CLAUDE_HOOK_TYPE env)', () => {
    const side = path.join(dir, 'ctx.json');
    const script = writeHookScript(
      dir,
      'echo.js',
      [
        "const fs = require('fs');",
        'runHook(({ event, evt, rt }) => {',
        `  fs.writeFileSync(${JSON.stringify(side)}, JSON.stringify({ event, evtEvent: evt.event, runtime: rt.name }));`,
        '});',
      ].join('\n')
    );
    const payload = { hook_event_name: 'Stop', turn_id: 't-1', session_id: 's' };
    const res = spawnHook(script, JSON.stringify(payload), {});
    assert.equal(res.status, 0);
    assert.equal(res.stderr, '');
    const ctx = JSON.parse(fs.readFileSync(side, 'utf8'));
    assert.equal(ctx.event, 'Stop');
    assert.equal(ctx.evtEvent, 'Stop');
    assert.equal(ctx.runtime, 'codex', 'turn_id must sniff codex');
  });

  it('malformed stdin → handler receives raw {} and exits 0', () => {
    const side = path.join(dir, 'ctx.json');
    const script = writeHookScript(
      dir,
      'echo.js',
      [
        "const fs = require('fs');",
        'runHook(({ raw }) => {',
        `  fs.writeFileSync(${JSON.stringify(side)}, JSON.stringify(raw));`,
        '}, { defaultEvent: "PostToolUse" });',
      ].join('\n')
    );
    const res = spawnHook(script, '{bad', {});
    assert.equal(res.status, 0);
    assert.equal(res.stderr, '');
    assert.deepEqual(JSON.parse(fs.readFileSync(side, 'utf8')), {});
  });

  it("throwing handler, onError 'open' → exit 0 with EMPTY stdout+stderr", () => {
    const log = path.join(dir, 'err.log');
    const script = writeHookScript(
      dir,
      'boom.js',
      [
        `const { logHookError } = require(${JSON.stringify(require.resolve('../../hookEntrypoint/logHookError'))});`,
        'runHook(() => { console.log("SHOULD NOT APPEAR"); throw new Error("kaboom-open"); },',
        '  { defaultEvent: "Stop", logError: logHookError, file: "boom.js" });',
      ].join('\n')
    );
    const res = spawnHook(script, JSON.stringify({ hook_event_name: 'Stop' }), {
      HOOK_ERROR_LOG: log,
    });
    assert.equal(res.status, 0, 'fail-open must exit 0');
    assert.equal(res.stderr, '', 'fail-open writes nothing to stderr');
    assert.ok(fs.existsSync(log), 'error is logged to file');
    assert.ok(fs.readFileSync(log, 'utf8').includes('kaboom-open'));
  });

  it("throwing handler, onError 'closed' → exit 2 with NON-EMPTY stderr (block preserved)", () => {
    const script = writeHookScript(
      dir,
      'block.js',
      [
        'runHook(() => { throw new Error("intentional-block"); },',
        '  { defaultEvent: "PreToolUse", onError: "closed" });',
      ].join('\n')
    );
    const res = spawnHook(script, JSON.stringify({ hook_event_name: 'PreToolUse' }), {});
    assert.equal(res.status, 2);
    assert.ok(res.stderr.includes('intentional-block'));
  });

  it("onError 'closed' pads a message-less throw so stderr is never empty", () => {
    const script = writeHookScript(
      dir,
      'block-empty.js',
      ['runHook(() => { throw new Error(""); }, { onError: "closed" });'].join('\n')
    );
    const res = spawnHook(script, JSON.stringify({ hook_event_name: 'PreToolUse' }), {});
    assert.equal(res.status, 2);
    assert.ok(res.stderr.trim().length > 0);
  });

  it("a handler's own process.exit wins over runHook's fallthrough", () => {
    const script = writeHookScript(
      dir,
      'self-exit.js',
      ['runHook(({ rt }) => { rt.emit.block("blocked-by-emit"); });'].join('\n')
    );
    const res = spawnHook(script, JSON.stringify({ hook_event_name: 'Stop' }), {});
    assert.equal(res.status, 2);
    assert.ok(res.stderr.includes('blocked-by-emit'));
  });

  it('missing handler throws TypeError synchronously', () => {
    const script = writeHookScript(dir, 'bad-config.js', [
      'try { runHook(null); } catch (e) { process.stderr.write("CFG:" + e.constructor.name); process.exit(9); }',
    ]);
    const res = spawnHook(script, '{}', {});
    assert.equal(res.status, 9);
    assert.ok(res.stderr.includes('CFG:TypeError'));
  });
});
