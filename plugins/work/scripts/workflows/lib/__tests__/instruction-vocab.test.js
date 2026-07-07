/**
 * Tests for lib/instruction-vocab.js — the work plugin's emission-time
 * vocabulary renderer (WP-08).
 *
 * Claude is pinned byte-identical (passthrough/same-reference); codex
 * renders the degradation contract: request_user_input prose + parked-gate
 * notice per mode (C3), inline-agent personas with an on-disk personaPath
 * resolved against the plugin root (C1).
 *
 * Run: node --test scripts/workflows/lib/__tests__/instruction-vocab.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { resetRuntimeCache } = require('../runtime');
const {
  renderQuestionText,
  renderDelegateForRuntime,
  getRuntime,
  PARKED_NOTICE,
  PLUGIN_ROOT,
} = require('../instruction-vocab');

const ENV_KEYS = ['AGENT_RUNTIME', 'AGENT_RUNTIME_MODE'];
const saved = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetRuntimeCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetRuntimeCache();
});

// Pin the runtime explicitly — never rely on ambient detection in tests.
function rtFor(name, mode) {
  process.env.AGENT_RUNTIME = name;
  if (mode) process.env.AGENT_RUNTIME_MODE = mode;
  resetRuntimeCache();
  return getRuntime();
}

describe('PLUGIN_ROOT', () => {
  it('resolves to the work plugin root (agents/ and skills/ exist under it)', () => {
    assert.equal(path.basename(PLUGIN_ROOT), 'work');
    assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, 'agents')));
    assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, 'skills', 'work', 'SKILL.md')));
  });
});

describe('renderQuestionText (C3)', () => {
  const TEXT = 'Use AskUserQuestion to resolve 2 open question(s).';

  it('claude: byte-identical passthrough (same reference)', () => {
    assert.equal(renderQuestionText(TEXT, rtFor('claude')), TEXT);
  });

  it('codex interactive: swaps the question vocabulary, no parked notice', () => {
    const out = renderQuestionText(TEXT, rtFor('codex', 'interactive'));
    assert.equal(out, 'Use request_user_input to resolve 2 open question(s).');
    assert.ok(!out.includes(PARKED_NOTICE));
  });

  it('codex exec: swap + parked-gate notice', () => {
    const out = renderQuestionText(TEXT, rtFor('codex', 'exec'));
    assert.match(out, /request_user_input/);
    assert.ok(out.endsWith(`\n${PARKED_NOTICE}`));
  });

  it('codex unknown mode (driver CLIs have no payload): notice included', () => {
    const out = renderQuestionText(TEXT, rtFor('codex'));
    assert.ok(out.includes(PARKED_NOTICE));
  });

  it('parked notice carries the greppable degradation prefix', () => {
    assert.match(PARKED_NOTICE, /^\[work:codex-degraded\] interactive gate parked/);
  });
});

describe('renderDelegateForRuntime (C1)', () => {
  const taskDelegate = {
    type: 'task',
    agentType: 'developer-nodejs-tdd',
    description: 'Task 1/2 — implement',
    prompt: 'Run task-next.js.',
    note: 'Pass the prompt directly to the agent.',
  };

  it('claude: returns the SAME delegate reference — provably inert', () => {
    assert.equal(renderDelegateForRuntime(taskDelegate, rtFor('claude')), taskDelegate);
  });

  it('codex: task → inline-agent with an on-disk personaPath under the plugin root', () => {
    const rendered = renderDelegateForRuntime(taskDelegate, rtFor('codex'));
    assert.equal(rendered.type, 'inline-agent');
    assert.equal(rendered.personaPath, path.join(PLUGIN_ROOT, 'agents', 'developer-nodejs-tdd.md'));
    assert.ok(fs.existsSync(rendered.personaPath), 'personaPath exists on disk');
    assert.match(rendered.notices[0], /^\[work:codex-degraded\]/);
  });

  it('codex: skill delegate howTo points at the real SKILL.md', () => {
    const rendered = renderDelegateForRuntime(
      { type: 'skill', name: 'check', prompt: '/check GH-1' },
      rtFor('codex')
    );
    assert.match(rendered.howTo, /\$check skill/);
    assert.ok(rendered.howTo.includes(path.join(PLUGIN_ROOT, 'skills', 'check', 'SKILL.md')));
  });

  it('bash/commit delegates pass through on both runtimes', () => {
    const bash = { type: 'bash', description: 'd', command: 'ls' };
    assert.equal(renderDelegateForRuntime(bash, rtFor('codex')), bash);
    resetRuntimeCache();
    assert.equal(renderDelegateForRuntime(bash, rtFor('claude')), bash);
  });
});
