'use strict';

/**
 * Integration tests for reminder-dispatcher.js — the single consolidated
 * UserPromptSubmit reminder hook. Spawns the hook as a child process (the
 * established pattern for hook behavior) with a temp manifest, temp body
 * files, and REMIND_ONCE_SESSION_DIR isolation.
 *
 * Coverage:
 *   - validateManifest / `validate` CLI: bad regex, missing body, unknown
 *     cadence each drop only the offending entry; clean manifest → exit 0.
 *   - Cadence: once-per-session fires on prompt 1, suppressed on prompt 2 (same
 *     session), re-armed by a new session id; every-prompt fires every prompt.
 *   - Trigger regex gates a reminder to matching prompts; "always" always fires.
 *   - N entries → ONE combined block from ONE process.
 *   - Fail-open: empty/parse-error stdin, unreadable manifest → exit 0, no out.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', 'reminder-dispatcher.js');

let tmp;
let ledgerDir;
let bodyDir;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-disp-'));
  ledgerDir = path.join(tmp, 'ledgers');
  bodyDir = path.join(tmp, 'bodies');
  fs.mkdirSync(ledgerDir, { recursive: true });
  fs.mkdirSync(bodyDir, { recursive: true });
});

afterEach(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function writeBody(name, text) {
  const p = path.join(bodyDir, name);
  fs.writeFileSync(p, text);
  return p;
}

function writeManifest(entries) {
  const p = path.join(tmp, 'reminders.manifest.json');
  fs.writeFileSync(p, JSON.stringify(entries));
  return p;
}

function run(args, { stdin, manifest, sessionId, env = {} } = {}) {
  const childEnv = { ...process.env, REMIND_ONCE_SESSION_DIR: ledgerDir, ...env };
  // Scrub inherited node --test flags so the child runs the hook, not tests.
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_OPTIONS;
  delete childEnv.CLAUDE_CODE_SESSION_ID;
  delete childEnv.AGENT_SESSION_ID;
  if (manifest) childEnv.REMINDER_MANIFEST = manifest;
  const input =
    stdin === null || stdin === undefined
      ? ''
      : JSON.stringify({ session_id: sessionId, prompt: stdin.prompt });
  const r = spawnSync(process.execPath, [HOOK, ...args], {
    input,
    encoding: 'utf8',
    env: childEnv,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

describe('validate CLI + manifest validation', () => {
  it('exits 0 for a clean manifest', () => {
    const body = writeBody('a.md', 'A');
    const manifest = writeManifest([{ id: 'a', trigger: 'always', body }]);
    const r = run(['validate', manifest]);
    assert.equal(r.code, 0);
  });

  it('exits 1 and drops bad-regex / missing-body / unknown-cadence entries', () => {
    const body = writeBody('a.md', 'A');
    const manifest = writeManifest([
      { id: 'ok', trigger: 'always', body },
      { id: 'badre', trigger: '(', body },
      { id: 'nobody', trigger: 'always', body: path.join(bodyDir, 'missing.md') },
      { id: 'badcad', trigger: 'always', body, cadence: 'hourly' },
    ]);
    const r = run(['validate', manifest]);
    assert.equal(r.code, 1);
    assert.match(r.stderr + r.stdout, /badre/);
    assert.match(r.stderr + r.stdout, /nobody/);
    assert.match(r.stderr + r.stdout, /badcad/);
  });
});

describe('cadence + trigger filtering (hook path)', () => {
  it('once-per-session fires on prompt 1, suppressed on prompt 2, re-armed by new session', () => {
    const body = writeBody('a.md', 'AGENT-BLOCK');
    const manifest = writeManifest([
      { id: 'a', trigger: 'always', body, cadence: 'once-per-session' },
    ]);
    const first = run([], { stdin: { prompt: 'hello' }, manifest, sessionId: 'sess1' });
    assert.equal(first.code, 0);
    assert.match(first.stdout, /AGENT-BLOCK/);
    const second = run([], { stdin: { prompt: 'hello again' }, manifest, sessionId: 'sess1' });
    assert.equal(second.code, 0);
    assert.doesNotMatch(second.stdout, /AGENT-BLOCK/);
    const other = run([], { stdin: { prompt: 'hi' }, manifest, sessionId: 'sess2' });
    assert.match(other.stdout, /AGENT-BLOCK/);
  });

  it('every-prompt fires on every prompt', () => {
    const body = writeBody('e.md', 'EVERY');
    const manifest = writeManifest([{ id: 'e', trigger: 'always', body, cadence: 'every-prompt' }]);
    const first = run([], { stdin: { prompt: 'x' }, manifest, sessionId: 's' });
    const second = run([], { stdin: { prompt: 'y' }, manifest, sessionId: 's' });
    assert.match(first.stdout, /EVERY/);
    assert.match(second.stdout, /EVERY/);
  });

  it('trigger regex gates a reminder to matching prompts', () => {
    const body = writeBody('t.md', 'DEPLOY-HELP');
    const manifest = writeManifest([{ id: 't', trigger: 'deploy', body, cadence: 'every-prompt' }]);
    const miss = run([], { stdin: { prompt: 'just chatting' }, manifest, sessionId: 's' });
    assert.doesNotMatch(miss.stdout, /DEPLOY-HELP/);
    const hit = run([], { stdin: { prompt: 'please deploy the app' }, manifest, sessionId: 's' });
    assert.match(hit.stdout, /DEPLOY-HELP/);
  });
});

describe('combined output + fail-open', () => {
  it('N firing entries → ONE combined block from ONE process', () => {
    const b1 = writeBody('1.md', 'ONE-BODY');
    const b2 = writeBody('2.md', 'TWO-BODY');
    const b3 = writeBody('3.md', 'THREE-BODY');
    const manifest = writeManifest([
      { id: 'r1', trigger: 'always', body: b1, cadence: 'every-prompt' },
      { id: 'r2', trigger: 'always', body: b2, cadence: 'every-prompt' },
      { id: 'r3', trigger: 'always', body: b3, cadence: 'every-prompt' },
    ]);
    const r = run([], { stdin: { prompt: 'go' }, manifest, sessionId: 's' });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /ONE-BODY/);
    assert.match(r.stdout, /TWO-BODY/);
    assert.match(r.stdout, /THREE-BODY/);
  });

  it('zero firing entries → no output, exit 0', () => {
    const body = writeBody('n.md', 'NOPE');
    const manifest = writeManifest([
      { id: 'n', trigger: 'zzznomatch', body, cadence: 'every-prompt' },
    ]);
    const r = run([], { stdin: { prompt: 'hello' }, manifest, sessionId: 's' });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '');
  });

  it('empty stdin → fail-open exit 0, no output', () => {
    const r = run([], { stdin: null });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '');
  });

  it('unreadable manifest → fail-open exit 0, no output', () => {
    const r = run([], {
      stdin: { prompt: 'hi' },
      manifest: path.join(tmp, 'does-not-exist.json'),
      sessionId: 's',
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '');
  });

  it('one bad entry does not abort the rest (per-entry fail-open)', () => {
    const good = writeBody('g.md', 'GOOD-BODY');
    const manifest = writeManifest([
      { id: 'bad', trigger: '(', body: good, cadence: 'every-prompt' },
      { id: 'good', trigger: 'always', body: good, cadence: 'every-prompt' },
    ]);
    const r = run([], { stdin: { prompt: 'x' }, manifest, sessionId: 's' });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /GOOD-BODY/);
  });
});
