'use strict';

/**
 * Dispatcher telemetry integration tests (GH-512, Task 3).
 *
 * These tests spawn `plugins/synapsys/hooks/synapsys.js` against a temporary
 * memory store and a temporary HOME (so `~/.claude/synapsys/.telemetry/`
 * resolves into the test sandbox via os.homedir()).
 *
 * Scenarios (matches tasks.md Task 3 + gherkin):
 *   (a) UserPromptSubmit with matching memory writes one `fired` JSONL line
 *       and stdout still contains the injection (AC1).
 *   (e) SYNAPSYS_TELEMETRY=0 suppresses all writes; stdout still has injection (AC2).
 *   (f) Per-memory `telemetry: false` skips that memory only (AC3).
 *   (d) Telemetry write failure (mocked fs.appendFileSync EACCES) does not
 *       break injection — dispatcher exits 0 and stdout still has injection (AC4).
 *   (b) Cited event emitted on Stop when response mentions a fired memory name (AC6).
 *   AC7 — cite_signals frontmatter wins over auto-extraction.
 *   AC8 — Auto-extracted signals fire when cite_signals absent.
 *   (g) Missing session_id routes to _unknown-session.jsonl (AC9).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DISPATCHER = path.resolve(__dirname, '..', '..', 'hooks', 'synapsys.js');

function mktemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeMemory(storeDir, name, opts) {
  const lines = ['---', `name: ${name}`];
  if (opts.description) lines.push(`description: ${opts.description}`);
  if (opts.events) lines.push(`events: ${opts.events}`);
  if (opts.triggerPrompt) lines.push(`trigger_prompt: ${opts.triggerPrompt}`);
  if (opts.triggerSession !== undefined) lines.push(`trigger_session: ${opts.triggerSession}`);
  if (opts.inject) lines.push(`inject: ${opts.inject}`);
  if (opts.telemetry === false) lines.push('telemetry: false');
  if (opts.citeSignals) {
    lines.push('cite_signals:');
    for (const s of opts.citeSignals) lines.push(`  - ${s}`);
  }
  lines.push('---', '', opts.body || 'Body for ' + name, '');
  fs.writeFileSync(path.join(storeDir, `${name}.md`), lines.join('\n'));
}

function makeFixture({ home }) {
  const cwd = mktemp('synapsys-disp-tel-cwd-');
  const storeDir = path.join(cwd, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ projectName: 'dispatcher-telemetry-fixture' })
  );
  return {
    cwd,
    storeDir,
    cleanup: () => {
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
      if (home) try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    },
  };
}

function runDispatcher(event, payload, { home, extraEnv } = {}) {
  const env = { ...process.env, SYNAPSYS_NO_SETUP_HINT: '1', HOME: home };
  delete env.SYNAPSYS_TELEMETRY;
  if (extraEnv) Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [DISPATCHER, event], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
  });
}

function telemetryDirFor(home) {
  return path.join(home, '.claude', 'synapsys', '.telemetry');
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

// ---- Scenario (a) — fired event written on match ---------------------------

test('Dispatcher writes a fired event when a memory matches', (t) => {
  const home = mktemp('synapsys-disp-tel-home-');
  const fx = makeFixture({ home });
  t.after(fx.cleanup);

  writeMemory(fx.storeDir, 'mem-fired', {
    description: 'fires for prompt',
    events: 'UserPromptSubmit',
    triggerPrompt: 'hello-fired-trigger',
    triggerSession: false,
    inject: 'full',
    body: 'Body of mem-fired.',
  });

  const sessionId = 'session-aaa';
  const result = runDispatcher(
    'UserPromptSubmit',
    {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'hello-fired-trigger please',
      cwd: fx.cwd,
      session_id: sessionId,
    },
    { home }
  );

  assert.equal(result.status, 0, `stderr=${result.stderr}`);
  assert.ok(result.stdout.includes('mem-fired'), 'stdout missing injection');

  const jsonl = path.join(telemetryDirFor(home), `${sessionId}.jsonl`);
  const rows = readJsonl(jsonl);
  const firedRows = rows.filter((r) => r.event === 'fired' && r.memory === 'mem-fired');
  assert.equal(firedRows.length, 1, `expected exactly 1 fired row, got ${rows.length} total`);
});

// ---- Scenario (e) — SYNAPSYS_TELEMETRY=0 opt-out ---------------------------

test('Opt-out via SYNAPSYS_TELEMETRY=0 suppresses all writes', (t) => {
  const home = mktemp('synapsys-disp-tel-home-');
  const fx = makeFixture({ home });
  t.after(fx.cleanup);

  writeMemory(fx.storeDir, 'mem-optout-env', {
    description: 'env opt-out',
    events: 'UserPromptSubmit',
    triggerPrompt: 'opt-env-trigger',
    triggerSession: false,
    inject: 'full',
  });

  const sessionId = 'session-bbb';
  const result = runDispatcher(
    'UserPromptSubmit',
    {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'opt-env-trigger now',
      cwd: fx.cwd,
      session_id: sessionId,
    },
    { home, extraEnv: { SYNAPSYS_TELEMETRY: '0' } }
  );

  assert.equal(result.status, 0, `stderr=${result.stderr}`);
  assert.ok(result.stdout.includes('mem-optout-env'), 'stdout missing injection');

  const jsonl = path.join(telemetryDirFor(home), `${sessionId}.jsonl`);
  assert.equal(fs.existsSync(jsonl), false, 'telemetry file must not exist with SYNAPSYS_TELEMETRY=0');
});

// ---- Scenario (f) — per-memory opt-out -------------------------------------

test('Per-memory opt-out via telemetry false skips that memory only', (t) => {
  const home = mktemp('synapsys-disp-tel-home-');
  const fx = makeFixture({ home });
  t.after(fx.cleanup);

  writeMemory(fx.storeDir, 'mem-telemetered', {
    description: 'normal',
    events: 'UserPromptSubmit',
    triggerPrompt: 'multi-trigger',
    triggerSession: false,
    inject: 'full',
  });
  writeMemory(fx.storeDir, 'mem-silent', {
    description: 'opted out',
    events: 'UserPromptSubmit',
    triggerPrompt: 'multi-trigger',
    triggerSession: false,
    inject: 'full',
    telemetry: false,
  });

  const sessionId = 'session-ccc';
  const result = runDispatcher(
    'UserPromptSubmit',
    {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'multi-trigger fire both',
      cwd: fx.cwd,
      session_id: sessionId,
    },
    { home }
  );

  assert.equal(result.status, 0, `stderr=${result.stderr}`);

  const jsonl = path.join(telemetryDirFor(home), `${sessionId}.jsonl`);
  const rows = readJsonl(jsonl);
  const names = rows.filter((r) => r.event === 'fired').map((r) => r.memory);
  assert.ok(names.includes('mem-telemetered'), 'mem-telemetered must be recorded');
  assert.ok(!names.includes('mem-silent'), 'mem-silent must NOT be recorded');
});

// ---- Scenario (d) — fail-open under telemetry write failure ----------------

test('Telemetry write failure does not break injection (fail-open)', (t) => {
  const home = mktemp('synapsys-disp-tel-home-');
  const fx = makeFixture({ home });
  t.after(fx.cleanup);

  writeMemory(fx.storeDir, 'mem-failopen', {
    description: 'fail-open check',
    events: 'UserPromptSubmit',
    triggerPrompt: 'failopen-trigger',
    triggerSession: false,
    inject: 'full',
  });

  // Make the telemetry dir un-writable: create it as a regular FILE so
  // mkdirSync / appendFileSync inside telemetry.js will throw, exercising
  // the fail-open path inside the dispatcher.
  const telDir = telemetryDirFor(home);
  fs.mkdirSync(path.dirname(telDir), { recursive: true });
  fs.writeFileSync(telDir, 'not-a-dir');

  const result = runDispatcher(
    'UserPromptSubmit',
    {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'failopen-trigger now',
      cwd: fx.cwd,
      session_id: 'session-ddd',
    },
    { home }
  );

  assert.equal(result.status, 0, `stderr=${result.stderr}`);
  assert.ok(
    result.stdout.includes('mem-failopen'),
    'injection must still be written even if telemetry write fails'
  );
});

// ---- Scenario (b) — cited on Stop when response mentions memory name -------

test('Cited event is emitted on Stop when the response mentions a fired memory name', (t) => {
  const home = mktemp('synapsys-disp-tel-home-');
  const fx = makeFixture({ home });
  t.after(fx.cleanup);

  writeMemory(fx.storeDir, 'mem-cited', {
    description: 'fires then cited',
    events: 'UserPromptSubmit',
    triggerPrompt: 'cited-trigger',
    triggerSession: false,
    inject: 'full',
  });

  const sessionId = 'session-eee';

  // 1) Fire on UserPromptSubmit so the fired row exists in JSONL.
  const fired = runDispatcher(
    'UserPromptSubmit',
    {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'cited-trigger fire it',
      cwd: fx.cwd,
      session_id: sessionId,
    },
    { home }
  );
  assert.equal(fired.status, 0, `fired stderr=${fired.stderr}`);

  // 2) Stop with response text that mentions the memory name (auto-extracted signal).
  const stopRes = runDispatcher(
    'Stop',
    {
      hook_event_name: 'Stop',
      cwd: fx.cwd,
      session_id: sessionId,
      response: 'I followed mem-cited and finished the task.',
    },
    { home }
  );
  assert.equal(stopRes.status, 0, `stop stderr=${stopRes.stderr}`);

  const rows = readJsonl(path.join(telemetryDirFor(home), `${sessionId}.jsonl`));
  const citedRows = rows.filter((r) => r.event === 'cited' && r.memory === 'mem-cited');
  assert.equal(citedRows.length, 1, `expected exactly 1 cited row, got ${citedRows.length}`);
});

// ---- AC7 — cite_signals frontmatter wins over auto-extraction --------------

test('cite_signals frontmatter wins over auto-extraction', (t) => {
  const home = mktemp('synapsys-disp-tel-home-');
  const fx = makeFixture({ home });
  t.after(fx.cleanup);

  writeMemory(fx.storeDir, 'mem-signals', {
    description: 'explicit signals',
    events: 'UserPromptSubmit',
    triggerPrompt: 'signals-trigger',
    triggerSession: false,
    inject: 'full',
    citeSignals: ['MAGIC_SIGNAL_X'],
    body: 'Mentions `random-ident` and ## A Heading.',
  });

  const sessionId = 'session-fff';
  runDispatcher(
    'UserPromptSubmit',
    {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'signals-trigger go',
      cwd: fx.cwd,
      session_id: sessionId,
    },
    { home }
  );

  // Response text mentions the memory NAME but NOT the explicit signal.
  // Because cite_signals declared, auto-extraction is suppressed — no cited row.
  const stopRes = runDispatcher(
    'Stop',
    {
      hook_event_name: 'Stop',
      cwd: fx.cwd,
      session_id: sessionId,
      response: 'mentioned mem-signals only, not the magic token',
    },
    { home }
  );
  assert.equal(stopRes.status, 0);

  let rows = readJsonl(path.join(telemetryDirFor(home), `${sessionId}.jsonl`));
  let cited = rows.filter((r) => r.event === 'cited');
  assert.equal(cited.length, 0, 'must NOT cite based on auto-name when cite_signals declared');

  // Now run Stop again with response mentioning the declared signal.
  const stopRes2 = runDispatcher(
    'Stop',
    {
      hook_event_name: 'Stop',
      cwd: fx.cwd,
      session_id: sessionId,
      response: 'I observed MAGIC_SIGNAL_X firing.',
    },
    { home }
  );
  assert.equal(stopRes2.status, 0);

  rows = readJsonl(path.join(telemetryDirFor(home), `${sessionId}.jsonl`));
  cited = rows.filter((r) => r.event === 'cited' && r.memory === 'mem-signals');
  assert.equal(cited.length, 1, 'declared signal must trigger cited row');
  assert.equal(cited[0].match, 'MAGIC_SIGNAL_X');
});

// ---- AC8 — auto-extracted signals fire when cite_signals absent ------------

test('Auto-extracted signals fire when cite_signals is absent', (t) => {
  const home = mktemp('synapsys-disp-tel-home-');
  const fx = makeFixture({ home });
  t.after(fx.cleanup);

  writeMemory(fx.storeDir, 'mem-auto', {
    description: 'auto-extract from body',
    events: 'UserPromptSubmit',
    triggerPrompt: 'auto-trigger',
    triggerSession: false,
    inject: 'full',
    body: 'Use the `auto-ident-token` somewhere later.',
  });

  const sessionId = 'session-ggg';
  runDispatcher(
    'UserPromptSubmit',
    {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'auto-trigger ok',
      cwd: fx.cwd,
      session_id: sessionId,
    },
    { home }
  );

  // Response mentions the backticked identifier from the body — auto-extraction
  // should pick it up.
  const stopRes = runDispatcher(
    'Stop',
    {
      hook_event_name: 'Stop',
      cwd: fx.cwd,
      session_id: sessionId,
      response: 'I used auto-ident-token to finish.',
    },
    { home }
  );
  assert.equal(stopRes.status, 0);

  const rows = readJsonl(path.join(telemetryDirFor(home), `${sessionId}.jsonl`));
  const cited = rows.filter((r) => r.event === 'cited' && r.memory === 'mem-auto');
  assert.equal(cited.length, 1, 'auto-extracted signal must cite');
});

// ---- Scenario (g) — missing session_id falls back to _unknown-session.jsonl

test('Missing session_id falls back to _unknown-session.jsonl', (t) => {
  const home = mktemp('synapsys-disp-tel-home-');
  const fx = makeFixture({ home });
  t.after(fx.cleanup);

  writeMemory(fx.storeDir, 'mem-unknown', {
    description: 'no session id',
    events: 'UserPromptSubmit',
    triggerPrompt: 'unknown-session-trigger',
    triggerSession: false,
    inject: 'full',
  });

  const result = runDispatcher(
    'UserPromptSubmit',
    {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'unknown-session-trigger go',
      cwd: fx.cwd,
      // session_id intentionally omitted
    },
    { home }
  );
  assert.equal(result.status, 0, `stderr=${result.stderr}`);

  const unknown = path.join(telemetryDirFor(home), '_unknown-session.jsonl');
  assert.equal(fs.existsSync(unknown), true, '_unknown-session.jsonl must be created');
  const rows = readJsonl(unknown);
  const firedRows = rows.filter((r) => r.event === 'fired' && r.memory === 'mem-unknown');
  assert.ok(firedRows.length >= 1, 'fired row must be recorded in _unknown-session.jsonl');
});
