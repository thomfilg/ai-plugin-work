'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODULE_ROOT = path.resolve(__dirname, '..');
const LOGGER_PATH = require.resolve('../logHookError');
const { parsePayload, runHook } = require('../hookEntrypoint');

// ---------------------------------------------------------------------------
// Smoke tests: the full pipe-stdin → exit-code → log-entry flow, exercised by
// spawning real hook scripts that require this factory by absolute path.
// ---------------------------------------------------------------------------

function writeHookScript(dir, name, body) {
  const file = path.join(dir, name);
  const source = [
    "'use strict';",
    `const { runHook } = require(${JSON.stringify(MODULE_ROOT)});`,
    body,
    '',
  ].join('\n');
  fs.writeFileSync(file, source);
  return file;
}

function spawnHook(script, input, extraEnv) {
  const env = { ...process.env, ...extraEnv };
  // A user-level debug flag would reroute log lines to stderr and break the
  // "empty stderr" assertions — the smoke tests always run without it.
  delete env.ENFORCE_HOOK_DEBUG;
  // The timeout turns a hanging hook into res.error=ETIMEDOUT instead of
  // wedging the whole suite; hang-sensitive tests assert res.error is unset.
  return spawnSync(process.execPath, [script], { input, env, encoding: 'utf8', timeout: 15000 });
}

describe('runHook end-to-end (spawned hook scripts)', () => {
  let dir;
  let tmpLog;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-entry-'));
    tmpLog = path.join(dir, 'errors.log');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('well-formed payload reaches the handler and the process exits 0', () => {
    const side = path.join(dir, 'payload.json');
    const script = writeHookScript(
      dir,
      'echo-hook.js',
      [
        "const fs = require('fs');",
        'runHook(async (payload) => {',
        `  fs.writeFileSync(${JSON.stringify(side)}, JSON.stringify(payload));`,
        '});',
      ].join('\n')
    );
    const payload = { tool_name: 'Edit', tool_input: { file_path: '/tmp/x.js' } };
    const res = spawnHook(script, JSON.stringify(payload), { HOOK_ERROR_LOG: tmpLog });
    assert.equal(res.status, 0);
    assert.equal(res.stderr, '');
    assert.deepEqual(JSON.parse(fs.readFileSync(side, 'utf8')), payload);
  });

  it('malformed stdin → handler receives {} and the process exits 0', () => {
    const side = path.join(dir, 'payload.json');
    const script = writeHookScript(
      dir,
      'echo-hook.js',
      [
        "const fs = require('fs');",
        'runHook((payload) => {',
        `  fs.writeFileSync(${JSON.stringify(side)}, JSON.stringify(payload));`,
        '});',
      ].join('\n')
    );
    const res = spawnHook(script, '{"tool_name": nope', { HOOK_ERROR_LOG: tmpLog });
    assert.equal(res.status, 0);
    assert.equal(res.stderr, '');
    assert.deepEqual(JSON.parse(fs.readFileSync(side, 'utf8')), {});
  });

  it('no stdin at all → handler receives {}', () => {
    const side = path.join(dir, 'payload.json');
    const script = writeHookScript(
      dir,
      'echo-hook.js',
      [
        "const fs = require('fs');",
        'runHook((payload) => {',
        `  fs.writeFileSync(${JSON.stringify(side)}, JSON.stringify(payload));`,
        '});',
      ].join('\n')
    );
    const res = spawnHook(script, '', { HOOK_ERROR_LOG: tmpLog });
    assert.equal(res.status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(side, 'utf8')), {});
  });

  it("throwing handler with onError 'open' → exit 0, EMPTY stderr, log entry written", () => {
    const script = writeHookScript(
      dir,
      'open-hook.js',
      [
        'runHook(',
        '  () => {',
        "    throw new Error('kaboom-open-mode');",
        '  },',
        "  { file: 'smoke-open.js' }",
        ');',
      ].join('\n')
    );
    const res = spawnHook(script, JSON.stringify({ ok: true }), { HOOK_ERROR_LOG: tmpLog });
    assert.equal(res.status, 0, 'fail-open must exit 0');
    assert.equal(res.stderr, '', 'fail-open must write NOTHING to stderr');
    assert.ok(fs.existsSync(tmpLog), 'a log entry must be written');
    const content = fs.readFileSync(tmpLog, 'utf8');
    assert.ok(content.includes('kaboom-open-mode'), 'log should contain the error message');
    assert.ok(content.includes('smoke-open.js'), 'log should contain the source label');
  });

  it("throwing handler with onError 'closed' → exit 2 with non-empty stderr", () => {
    const script = writeHookScript(
      dir,
      'closed-hook.js',
      [
        'runHook(',
        '  () => {',
        "    throw new Error('kaboom-closed-mode');",
        '  },',
        "  { onError: 'closed' }",
        ');',
      ].join('\n')
    );
    const res = spawnHook(script, JSON.stringify({ ok: true }), { HOOK_ERROR_LOG: tmpLog });
    assert.equal(res.status, 2);
    assert.ok(res.stderr.trim().length > 0, 'fail-closed stderr must be non-empty');
    assert.ok(res.stderr.includes('kaboom-closed-mode'));
  });

  it("onError 'closed' pads a message-less error so stderr is never empty", () => {
    const script = writeHookScript(
      dir,
      'closed-empty-hook.js',
      [
        'runHook(',
        '  () => {',
        "    throw new Error('');",
        '  },',
        "  { onError: 'closed' }",
        ');',
      ].join('\n')
    );
    const res = spawnHook(script, JSON.stringify({ ok: true }), { HOOK_ERROR_LOG: tmpLog });
    assert.equal(res.status, 2);
    assert.ok(res.stderr.trim().length > 0, 'padded default must keep stderr non-empty');
  });

  it('open mode: a thrown prototype-less object exits 0, EMPTY stderr, fallback logged', () => {
    // String(err) throws for Object.create(null) — an unguarded logger call
    // would reject the dispatch promise unhandled (stack on stderr, exit 1).
    const script = writeHookScript(
      dir,
      'null-proto-open.js',
      [
        'runHook(',
        '  () => {',
        '    throw Object.create(null);',
        '  },',
        "  { file: 'null-proto-open.js' }",
        ');',
      ].join('\n')
    );
    const res = spawnHook(script, JSON.stringify({ ok: true }), { HOOK_ERROR_LOG: tmpLog });
    assert.equal(res.error, undefined, 'the process must not hang');
    assert.equal(res.status, 0, 'fail-open must survive an unstringable error');
    assert.equal(res.stderr, '', 'fail-open must write NOTHING to stderr');
    const content = fs.readFileSync(tmpLog, 'utf8');
    assert.ok(content.includes('[unstringable error]'), 'log line uses the fallback marker');
  });

  it('closed mode: a thrown prototype-less object exits 2 with NON-EMPTY stderr', () => {
    const script = writeHookScript(
      dir,
      'null-proto-closed.js',
      [
        'runHook(',
        '  () => {',
        '    throw Object.create(null);',
        '  },',
        "  { onError: 'closed' }",
        ');',
      ].join('\n')
    );
    const res = spawnHook(script, JSON.stringify({ ok: true }), { HOOK_ERROR_LOG: tmpLog });
    assert.equal(res.error, undefined, 'the process must not hang');
    assert.equal(res.status, 2);
    assert.ok(res.stderr.trim().length > 0, 'fail-closed stderr must be non-empty');
  });

  it('closed mode: an unstringable err.message still exits 2 with NON-EMPTY stderr', () => {
    // String(err.message) throws here — the fixed fallback line must still be
    // written, or an empty stderr flips the exit-2 hook to fail-open on codex.
    const script = writeHookScript(
      dir,
      'unstringable-message-closed.js',
      [
        'runHook(',
        '  () => {',
        '    throw { message: Object.create(null) };',
        '  },',
        "  { onError: 'closed' }",
        ');',
      ].join('\n')
    );
    const res = spawnHook(script, JSON.stringify({ ok: true }), { HOOK_ERROR_LOG: tmpLog });
    assert.equal(res.error, undefined, 'the process must not hang');
    assert.equal(res.status, 2);
    assert.ok(res.stderr.trim().length > 0, 'fallback line must keep stderr non-empty');
  });

  it('deleted cwd: fail-open still exits 0 with EMPTY stderr and logs the error', () => {
    // Real scenario: a hook firing from a cleaned-up worktree. process.cwd()
    // throws ENOENT inside the logger's context builder — the fail-open
    // contract (exit 0, silent stderr) must hold anyway.
    const script = writeHookScript(
      dir,
      'deleted-cwd.js',
      [
        "const fs = require('fs');",
        "const os = require('os');",
        "const path = require('path');",
        "const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-gone-'));",
        'process.chdir(gone);',
        'fs.rmdirSync(gone);',
        'runHook(',
        '  () => {',
        "    throw new Error('boom-from-deleted-cwd');",
        '  },',
        "  { file: 'deleted-cwd.js' }",
        ');',
      ].join('\n')
    );
    const res = spawnHook(script, JSON.stringify({ ok: true }), { HOOK_ERROR_LOG: tmpLog });
    assert.equal(res.error, undefined, 'the process must not hang');
    assert.equal(res.status, 0, 'fail-open must survive a deleted cwd');
    assert.equal(res.stderr, '', 'fail-open must write NOTHING to stderr');
    const content = fs.readFileSync(tmpLog, 'utf8');
    assert.ok(content.includes('boom-from-deleted-cwd'), 'the original error is still logged');
  });

  it("a handler's own process.exit wins — runHook's exit is the fallthrough", () => {
    const script = writeHookScript(
      dir,
      'self-exit-hook.js',
      ['runHook(() => {', '  process.exit(7);', '});'].join('\n')
    );
    const res = spawnHook(script, JSON.stringify({ ok: true }), { HOOK_ERROR_LOG: tmpLog });
    assert.equal(res.status, 7);
    assert.equal(res.stderr, '');
  });
});

// ---------------------------------------------------------------------------
// Unit tests: parsePayload + runHook config validation.
// ---------------------------------------------------------------------------

describe('parsePayload', () => {
  it('parses well-formed JSON', () => {
    assert.deepEqual(parsePayload('{"a":1}'), { a: 1 });
  });

  it('returns {} for empty / missing input', () => {
    assert.deepEqual(parsePayload(''), {});
    assert.deepEqual(parsePayload(undefined), {});
    assert.deepEqual(parsePayload(null), {});
  });

  it('returns {} for malformed input and never throws', () => {
    assert.deepEqual(parsePayload('{nope'), {});
    assert.deepEqual(parsePayload('[1,'), {});
  });

  it('returns the caller-provided fallback for empty and malformed input', () => {
    const fallback = { defaulted: true };
    assert.equal(parsePayload('', fallback), fallback);
    assert.equal(parsePayload('{nope', fallback), fallback);
  });

  it('passes non-object JSON through untouched', () => {
    assert.equal(parsePayload('42'), 42);
  });
});

describe('runHook config validation', () => {
  it('throws TypeError when the handler is missing', () => {
    assert.throws(
      () => runHook(null),
      (err) => {
        assert.ok(err instanceof TypeError);
        assert.match(err.message, /missing "handler"/);
        return true;
      }
    );
  });

  it('throws TypeError for an unknown onError policy', () => {
    assert.throws(
      () => runHook(() => {}, { onError: 'bogus' }),
      (err) => {
        assert.ok(err instanceof TypeError);
        assert.match(err.message, /"onError"/);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Unit tests: logHookError rotation / sanitize / context paths. Each test
// re-requires the module so the cached fd and LOG_FILE pick up the tmp path.
// ---------------------------------------------------------------------------

describe('logHookError', () => {
  let dir;
  let tmpLog;
  let savedLog;
  let savedDebug;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-log-'));
    tmpLog = path.join(dir, 'errors.log');
    savedLog = process.env.HOOK_ERROR_LOG;
    savedDebug = process.env.ENFORCE_HOOK_DEBUG;
    process.env.HOOK_ERROR_LOG = tmpLog;
    delete process.env.ENFORCE_HOOK_DEBUG;
    delete require.cache[LOGGER_PATH];
  });

  afterEach(() => {
    if (savedLog === undefined) delete process.env.HOOK_ERROR_LOG;
    else process.env.HOOK_ERROR_LOG = savedLog;
    if (savedDebug === undefined) delete process.env.ENFORCE_HOOK_DEBUG;
    else process.env.ENFORCE_HOOK_DEBUG = savedDebug;
    delete require.cache[LOGGER_PATH];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exports LOG_FILE reflecting the HOOK_ERROR_LOG override', () => {
    const { LOG_FILE } = require(LOGGER_PATH);
    assert.equal(LOG_FILE, tmpLog);
  });

  it('writes one line with timestamp, source basename, pid, cwd, and message', () => {
    const { logHookError } = require(LOGGER_PATH);
    logHookError(__filename, new Error('format check'));
    const line = fs.readFileSync(tmpLog, 'utf8').trim();
    assert.match(line, /^\[\d{4}-\d{2}-\d{2}T/);
    assert.ok(line.includes(path.basename(__filename)));
    assert.ok(line.includes(`pid=${process.pid}`));
    assert.ok(line.includes(`cwd=${process.cwd()}`));
    assert.ok(line.includes('format check'));
  });

  it('creates the log file with 0o600 permissions', () => {
    const { logHookError } = require(LOGGER_PATH);
    logHookError(__filename, new Error('perm check'));
    assert.equal(fs.statSync(tmpLog).mode & 0o777, 0o600);
  });

  it('strips embedded newlines — one error, one line', () => {
    const { logHookError } = require(LOGGER_PATH);
    logHookError(__filename, new Error('line1\nline2\r\nline3'));
    const lines = fs.readFileSync(tmpLog, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('line1 line2 line3'));
  });

  it('caps a line at 3800 bytes with a ... suffix', () => {
    const { logHookError } = require(LOGGER_PATH);
    logHookError(__filename, new Error('y'.repeat(5000)));
    const line = fs.readFileSync(tmpLog, 'utf8').trim();
    assert.ok(Buffer.byteLength(line + '\n', 'utf8') <= 3800);
    assert.ok(line.endsWith('...'));
  });

  it('rotates when the file exceeds 1MB', () => {
    fs.writeFileSync(tmpLog, 'x'.repeat(1024 * 1024 + 1), { mode: 0o600 });
    const { logHookError } = require(LOGGER_PATH);
    logHookError(__filename, new Error('post-rotation entry'));
    const content = fs.readFileSync(tmpLog, 'utf8');
    assert.ok(content.includes('--- log rotated ---'), 'rotation marker expected');
    assert.ok(content.includes('post-rotation entry'), 'new entry expected after rotation');
    assert.ok(content.length < 1024 * 1024, 'file should have been truncated');
  });

  it('includes tool/input context with the 200-char command truncation', () => {
    const { logHookError } = require(LOGGER_PATH);
    logHookError(__filename, new Error('ctx check'), {
      tool: 'Bash',
      input: {
        command: 'c'.repeat(250),
        file_path: '/some/file.js',
        skill: 'demo',
        subagent_type: 'helper',
      },
    });
    const line = fs.readFileSync(tmpLog, 'utf8').trim();
    assert.ok(line.includes('tool=Bash'));
    assert.ok(line.includes('file=/some/file.js'));
    assert.ok(line.includes(`cmd=${'c'.repeat(200)}...`));
    assert.ok(line.includes('skill=demo'));
    assert.ok(line.includes('agent=helper'));
  });

  it('never throws for an unstringable error and logs the fallback marker', () => {
    const { logHookError } = require(LOGGER_PATH);
    assert.doesNotThrow(() => logHookError(__filename, Object.create(null)));
    const line = fs.readFileSync(tmpLog, 'utf8').trim();
    assert.ok(line.includes('[unstringable error]'), 'fallback marker expected in the log line');
    assert.ok(line.includes(path.basename(__filename)), 'source label still present');
  });

  it('never throws when err.message is a throwing getter', () => {
    const { logHookError } = require(LOGGER_PATH);
    const evil = {};
    Object.defineProperty(evil, 'message', {
      get() {
        throw new Error('getter bomb');
      },
    });
    assert.doesNotThrow(() => logHookError(__filename, evil));
    assert.ok(fs.readFileSync(tmpLog, 'utf8').includes('[unstringable error]'));
  });

  it('unlinks a symlink at the log path before opening (target untouched)', () => {
    const target = path.join(dir, 'target.log');
    fs.writeFileSync(target, 'target content', { mode: 0o600 });
    fs.symlinkSync(target, tmpLog);
    assert.ok(fs.lstatSync(tmpLog).isSymbolicLink(), 'precondition: symlink in place');

    const { logHookError } = require(LOGGER_PATH);
    logHookError(__filename, new Error('symlink test'));

    assert.ok(!fs.lstatSync(tmpLog).isSymbolicLink(), 'symlink must be replaced by a real file');
    assert.equal(fs.readFileSync(target, 'utf8'), 'target content');
  });

  it('ENFORCE_HOOK_DEBUG=1 writes to stderr instead of the file', () => {
    process.env.ENFORCE_HOOK_DEBUG = '1';
    const { logHookError } = require(LOGGER_PATH);

    let stderrOutput = '';
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderrOutput += chunk;
      return true;
    };
    try {
      logHookError(__filename, new Error('debug error'));
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.ok(stderrOutput.includes('debug error'));
    assert.ok(!fs.existsSync(tmpLog), 'the file is never opened in debug mode');
  });
});

// ---------------------------------------------------------------------------
// Aggregator surface.
// ---------------------------------------------------------------------------

describe('index aggregator', () => {
  it('exposes the entry protocol and the logger from one require', () => {
    const api = require(MODULE_ROOT);
    assert.equal(typeof api.readStdin, 'function');
    assert.equal(typeof api.parsePayload, 'function');
    assert.equal(typeof api.runHook, 'function');
    assert.equal(typeof api.logHookError, 'function');
    assert.equal(typeof api.LOG_FILE, 'string');
  });
});
