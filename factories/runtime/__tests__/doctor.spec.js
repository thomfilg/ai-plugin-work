/**
 * Tests for factories/runtime/doctor.js — [hooks.state] parsing, expected-key
 * enumeration (GT §2.1.4 format), best-effort hash comparison, and per-plugin
 * trusted/modified/untrusted/disabled classification (C9).
 *
 * Run: node --test factories/runtime/__tests__/doctor.spec.js
 */

'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  snakeEventName,
  computeHookHash,
  parseHooksState,
  expectedHookEntries,
  report,
} = require('../doctor');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-spec-'));
after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

const HOOKS_JSON = {
  hooks: {
    PreToolUse: [
      {
        matcher: 'Task|Skill|Agent',
        hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/a.js"' }],
      },
    ],
    UserPromptSubmit: [
      {
        matcher: '^\\s*/work\\s+',
        hooks: [{ type: 'command', command: 'node b.js', timeout: 30 }],
      },
    ],
    Stop: [{ hooks: [{ type: 'command', command: 'node c.js' }] }],
  },
};

describe('snakeEventName', () => {
  it('matches the codex identity labels', () => {
    assert.equal(snakeEventName('PreToolUse'), 'pre_tool_use');
    assert.equal(snakeEventName('UserPromptSubmit'), 'user_prompt_submit');
    assert.equal(snakeEventName('SessionStart'), 'session_start');
    assert.equal(snakeEventName('SubagentStop'), 'subagent_stop');
    assert.equal(snakeEventName('Stop'), 'stop');
  });
});

describe('expectedHookEntries', () => {
  it('enumerates <keySource>:<snake_event>:<matcherIdx>:<handlerIdx> keys', () => {
    const entries = expectedHookEntries(HOOKS_JSON, 'work-workflow@wm:hooks/hooks.json');
    assert.deepEqual(
      entries.map((e) => e.key),
      [
        'work-workflow@wm:hooks/hooks.json:pre_tool_use:0:0',
        'work-workflow@wm:hooks/hooks.json:user_prompt_submit:0:0',
        'work-workflow@wm:hooks/hooks.json:stop:0:0',
      ]
    );
    for (const entry of entries) assert.match(entry.hash, /^sha256:[0-9a-f]{64}$/);
  });

  it('hash is stable and sensitive to command/matcher/timeout changes', () => {
    const handler = { type: 'command', command: 'node a.js' };
    const base = computeHookHash('PreToolUse', 'Bash', [handler]);
    assert.equal(computeHookHash('PreToolUse', 'Bash', [handler]), base);
    assert.notEqual(computeHookHash('PreToolUse', 'Bash|Agent', [handler]), base);
    assert.notEqual(
      computeHookHash('PreToolUse', 'Bash', [{ ...handler, command: 'node z.js' }]),
      base
    );
    assert.notEqual(computeHookHash('PreToolUse', 'Bash', [{ ...handler, timeout: 30 }]), base);
    // timeout defaults to 600 — an explicit 600 hashes identically.
    assert.equal(computeHookHash('PreToolUse', 'Bash', [{ ...handler, timeout: 600 }]), base);
  });
});

describe('parseHooksState', () => {
  it('reads trusted_hash and enabled from [hooks.state."key"] tables', () => {
    const toml = [
      '[projects."/x"]',
      'trust_level = "trusted"',
      '',
      '[hooks.state."p@m:hooks/hooks.json:stop:0:0"]',
      'trusted_hash = "sha256:abc"',
      '',
      '[hooks.state."p@m:hooks/hooks.json:pre_tool_use:0:0"]',
      'trusted_hash = "sha256:def"',
      'enabled = false',
    ].join('\n');
    const state = parseHooksState(toml);
    assert.deepEqual(state.get('p@m:hooks/hooks.json:stop:0:0'), {
      trustedHash: 'sha256:abc',
      enabled: true,
    });
    assert.deepEqual(state.get('p@m:hooks/hooks.json:pre_tool_use:0:0'), {
      trustedHash: 'sha256:def',
      enabled: false,
    });
    assert.equal(state.has('projects'), false);
  });
});

describe('report', () => {
  it('classifies trusted / modified / untrusted / disabled per plugin', () => {
    const codexHome = path.join(TMP, 'codex-home');
    fs.mkdirSync(codexHome, { recursive: true });
    const hooksJsonPath = path.join(TMP, 'work-hooks.json');
    fs.writeFileSync(hooksJsonPath, `${JSON.stringify(HOOKS_JSON, null, 2)}\n`);

    const keySource = 'work-workflow@wm:hooks/hooks.json';
    const entries = expectedHookEntries(HOOKS_JSON, keySource);
    const toml = [
      `[hooks.state."${entries[0].key}"]`,
      `trusted_hash = "${entries[0].hash}"`, // matches → trusted
      '',
      `[hooks.state."${entries[1].key}"]`,
      'trusted_hash = "sha256:junkjunkjunk"', // mismatch → modified
      // entries[2] absent → untrusted
    ].join('\n');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), `${toml}\n`);

    const result = report({
      codexHome,
      plugins: [{ plugin: 'work-workflow', marketplace: 'wm', hooksJsonPath }],
    });
    assert.equal(result.configError, null);
    const plugin = result.plugins[0];
    assert.equal(plugin.total, 3);
    assert.equal(plugin.trusted, 1);
    assert.equal(plugin.modified, 1);
    assert.equal(plugin.untrusted, 1);
    assert.equal(plugin.disabled, 0);
    assert.equal(
      plugin.summary,
      '2/3 work-workflow hooks UNTRUSTED — gates are OFF. Review in /hooks or relaunch with --dangerously-bypass-hook-trust'
    );
  });

  it('all-trusted plugins report clean; disabled entries are counted', () => {
    const codexHome = path.join(TMP, 'codex-home-2');
    fs.mkdirSync(codexHome, { recursive: true });
    const hooksJsonPath = path.join(TMP, 'small-hooks.json');
    const small = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node c.js' }] }] } };
    fs.writeFileSync(hooksJsonPath, JSON.stringify(small));
    const [entry] = expectedHookEntries(small, 'heimdall@wm:hooks/hooks.json');
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      `[hooks.state."${entry.key}"]\ntrusted_hash = "${entry.hash}"\n`
    );
    const clean = report({
      codexHome,
      plugins: [{ plugin: 'heimdall', marketplace: 'wm', hooksJsonPath }],
    });
    assert.equal(clean.plugins[0].summary, '1/1 heimdall hooks trusted');

    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      `[hooks.state."${entry.key}"]\ntrusted_hash = "${entry.hash}"\nenabled = false\n`
    );
    const disabled = report({
      codexHome,
      plugins: [{ plugin: 'heimdall', marketplace: 'wm', hooksJsonPath }],
    });
    assert.equal(disabled.plugins[0].disabled, 1);
    assert.match(disabled.plugins[0].summary, /1\/1 heimdall hooks UNTRUSTED/);
  });

  it('missing config.toml surfaces configError and everything reads untrusted', () => {
    const hooksJsonPath = path.join(TMP, 'small-hooks.json');
    const result = report({
      codexHome: path.join(TMP, 'nonexistent-home'),
      plugins: [{ plugin: 'heimdall', marketplace: 'wm', hooksJsonPath }],
    });
    assert.match(result.configError, /cannot read/);
    assert.equal(result.plugins[0].untrusted, 1);
  });

  it('unreadable hooks.json surfaces a per-plugin error', () => {
    const result = report({
      codexHome: path.join(TMP, 'nonexistent-home'),
      plugins: [
        { plugin: 'ghost', marketplace: 'wm', hooksJsonPath: path.join(TMP, 'absent.json') },
      ],
    });
    assert.match(result.plugins[0].error, /cannot read/);
    assert.deepEqual(result.plugins[0].entries, []);
  });
});
