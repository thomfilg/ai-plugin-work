/**
 * Tests for factories/runtime/index.js — detection precedence (design §A),
 * session stamp, mode resolution, memoization.
 *
 * Run: node --test factories/runtime/__tests__/index.spec.js
 */

'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  getRuntime,
  detectRuntime,
  stampRuntime,
  resetRuntimeCache,
  stampPath,
  resolveMode,
} = require('../index');

// Redirect HOME so stamp reads/writes never touch the real ~/.claude
// (os.homedir() prefers $HOME on POSIX).
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-home-'));
let realHome;
before(() => {
  realHome = process.env.HOME;
  process.env.HOME = FAKE_HOME;
});
after(() => {
  process.env.HOME = realHome;
  try {
    fs.rmSync(FAKE_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

const ROLLOUT_PATH =
  '/tmp/codex-probe-home/sessions/2026/07/07/rollout-2026-07-07T08-16-51-019f3c4b.jsonl';
const CLAUDE_PATH = '/home/user/.claude/projects/-tmp-repo/abc.jsonl';

describe('detectRuntime precedence', () => {
  it('1: AGENT_RUNTIME pin wins over every codex signal', () => {
    const env = { AGENT_RUNTIME: 'claude', CODEX_THREAD_ID: 't', PLUGIN_ROOT: '/x' };
    assert.equal(detectRuntime({ turn_id: 'x' }, env), 'claude');
  });

  it('1: AGENT_RUNTIME=codex pins codex', () => {
    assert.equal(detectRuntime(null, { AGENT_RUNTIME: 'codex' }), 'codex');
  });

  it('1: unknown AGENT_RUNTIME value falls back to claude', () => {
    assert.equal(detectRuntime(null, { AGENT_RUNTIME: 'gemini' }), 'claude');
  });

  it('2: payload turn_id sniffs codex', () => {
    assert.equal(detectRuntime({ turn_id: '019f3c4b' }, {}), 'codex');
  });

  it('2: rollout transcript_path sniffs codex', () => {
    assert.equal(detectRuntime({ transcript_path: ROLLOUT_PATH }, {}), 'codex');
  });

  it('2: claude transcript_path sniffs claude even with CODEX_THREAD_ID set', () => {
    const env = { CODEX_THREAD_ID: 't' };
    assert.equal(detectRuntime({ transcript_path: CLAUDE_PATH }, env), 'claude');
  });

  it('3: PLUGIN_ROOT (codex-only hook env) means codex', () => {
    assert.equal(detectRuntime(null, { PLUGIN_ROOT: '/cache/plugins/work' }), 'codex');
  });

  it('4: probe leak scenario — CLAUDECODE=1 + CODEX_THREAD_ID both set ⇒ codex', () => {
    const env = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'sid', CODEX_THREAD_ID: 'thread' };
    assert.equal(detectRuntime(null, env), 'codex');
  });

  it('6: Claude env signals rank below all codex signals but above default', () => {
    assert.equal(detectRuntime(null, { CLAUDECODE: '1' }), 'claude');
    assert.equal(detectRuntime(null, { CLAUDE_CODE_SESSION_ID: 'sid' }), 'claude');
  });

  it('7: nothing set defaults to claude', () => {
    assert.equal(detectRuntime(null, {}), 'claude');
  });
});

describe('session stamp (§A.5)', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-cwd-'));
  after(() => {
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  it('stampRuntime writes and detectRuntime reads it (step 5, above Claude env)', () => {
    process.env.AGENT_RUNTIME = 'codex';
    try {
      stampRuntime({ cwd, session_id: 'sid-1' });
    } finally {
      delete process.env.AGENT_RUNTIME;
    }
    const stamp = JSON.parse(fs.readFileSync(stampPath(cwd), 'utf8'));
    assert.equal(stamp.runtime, 'codex');
    assert.equal(stamp.sessionId, 'sid-1');
    // Stamp outranks the Claude env signal (the probe-leak fix for driver CLIs).
    assert.equal(detectRuntime({ cwd }, { CLAUDECODE: '1' }), 'codex');
  });

  it('expired stamps (>12h) are ignored', () => {
    const stale = {
      runtime: 'codex',
      sessionId: 'sid-2',
      ts: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(),
    };
    fs.writeFileSync(stampPath(cwd), `${JSON.stringify(stale)}\n`);
    assert.equal(detectRuntime({ cwd }, {}), 'claude');
  });

  it('corrupt stamps are ignored', () => {
    fs.writeFileSync(stampPath(cwd), 'not json\n');
    assert.equal(detectRuntime({ cwd }, {}), 'claude');
  });

  it('readStamp: fresh stamps round-trip, invalid/expired/missing read as null', () => {
    const { readStamp } = require('../index');
    fs.writeFileSync(
      stampPath(cwd),
      `${JSON.stringify({ runtime: 'codex', sessionId: 's', ts: new Date().toISOString() })}\n`
    );
    assert.equal(readStamp(cwd).runtime, 'codex');
    fs.writeFileSync(
      stampPath(cwd),
      `${JSON.stringify({ runtime: 'gemini', sessionId: 's', ts: new Date().toISOString() })}\n`
    );
    assert.equal(readStamp(cwd), null);
    fs.rmSync(stampPath(cwd));
    assert.equal(readStamp(cwd), null);
  });
});

describe('resolveMode', () => {
  it('claude is always interactive', () => {
    assert.equal(
      resolveMode('claude', { permission_mode: 'bypassPermissions' }, {}),
      'interactive'
    );
  });

  it('codex bypassPermissions payload means exec', () => {
    assert.equal(resolveMode('codex', { permission_mode: 'bypassPermissions' }, {}), 'exec');
  });

  it('codex interactive permission modes mean interactive', () => {
    assert.equal(resolveMode('codex', { permission_mode: 'default' }, {}), 'interactive');
    assert.equal(resolveMode('codex', { permission_mode: 'acceptEdits' }, {}), 'interactive');
  });

  it('codex without a payload is unknown', () => {
    assert.equal(resolveMode('codex', null, {}), 'unknown');
  });

  it('AGENT_RUNTIME_MODE overrides the heuristic', () => {
    const env = { AGENT_RUNTIME_MODE: 'interactive' };
    assert.equal(
      resolveMode('codex', { permission_mode: 'bypassPermissions' }, env),
      'interactive'
    );
  });
});

describe('getRuntime facade', () => {
  beforeEach(() => resetRuntimeCache());
  after(() => resetRuntimeCache());

  it('is memoized for the process lifetime', () => {
    process.env.AGENT_RUNTIME = 'codex';
    try {
      assert.equal(getRuntime().name, 'codex');
    } finally {
      delete process.env.AGENT_RUNTIME;
    }
    assert.equal(getRuntime().name, 'codex'); // still the first verdict
    resetRuntimeCache();
    assert.equal(getRuntime().name, detectRuntime(undefined, process.env));
  });

  it('exposes the bound facets', () => {
    process.env.AGENT_RUNTIME = 'codex';
    try {
      const rt = getRuntime({ permission_mode: 'bypassPermissions' });
      assert.equal(rt.mode(), 'exec');
      assert.equal(typeof rt.emit.block, 'function');
      const evt = rt.normalizeHookPayload({ tool_name: 'Bash', tool_input: { command: 'ls' } });
      assert.equal(evt.runtime, 'codex');
      assert.equal(rt.isSubagentContext(evt), false);
    } finally {
      delete process.env.AGENT_RUNTIME;
    }
  });
});
