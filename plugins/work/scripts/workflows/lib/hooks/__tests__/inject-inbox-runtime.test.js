'use strict';

/**
 * Dual-runtime tests for inject-inbox-messages.js (WP-06 / C11).
 *
 * Claude keeps the exact stderr-on-exit-0 bytes it printed before the port
 * (pinned byte-identically here). Codex drops the stderr channel — invisible
 * there — and relays through the PostToolUse additionalContext envelope,
 * prefixed with the [work:codex-degraded] notice.
 */

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', 'inject-inbox-messages.js');
const NOTICE = '[work:codex-degraded] inbox relayed via PostToolUse hook (no Monitor on codex)';

function expectedText(ticket, shown, total, lines) {
  return (
    `\n=== Monitor messages for ${ticket} (${shown}/${total} new) ===\n` +
    lines.map((l) => `[MONITOR] ${l}`).join('\n') +
    '\n=== end monitor messages ===\n'
  );
}

describe('inject-inbox-messages — dual runtime', () => {
  let tmp;
  let inboxDir;
  let envBase;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-inbox-rt-'));
    inboxDir = path.join(tmp, 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });
    envBase = { HOME: tmp, CLAUDE_AGENT_INBOX_DIR: inboxDir };
  });

  beforeEach(() => {
    for (const f of fs.readdirSync(inboxDir)) fs.unlinkSync(path.join(inboxDir, f));
    const cursors = path.join(tmp, '.claude', 'work-workflow', 'state', 'inbox-cursors.json');
    try {
      fs.unlinkSync(cursors);
    } catch {
      /* ignore */
    }
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function runHook(payload, env = {}) {
    const merged = { ...process.env, ...envBase, ...env };
    for (const key of ['AGENT_RUNTIME', 'AGENT_SESSION_ID', 'CODEX_THREAD_ID', 'PLUGIN_ROOT']) {
      if (!(key in env)) delete merged[key];
    }
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: merged,
    });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  }

  it('claude: stderr bytes are byte-identical to the pre-port emission', () => {
    const ticket = 'ECHO-8001';
    fs.appendFileSync(path.join(inboxDir, `${ticket}.log`), '[t] hello\n[t] world\n');
    const r = runHook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        transcript_path: `/x/${ticket}/abc.jsonl`,
      },
      { AGENT_RUNTIME: 'claude' }
    );
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, expectedText(ticket, 2, 2, ['[t] hello', '[t] world']));
  });

  it('codex: stderr is dropped; envelope carries notice + identical text', () => {
    const ticket = 'ECHO-8002';
    fs.appendFileSync(path.join(inboxDir, `${ticket}.log`), '[t] wake up\n');
    const r = runHook(
      {
        tool_name: 'Bash',
        turn_id: 't-1',
        tool_input: { command: `node x.js ${ticket}` },
        transcript_path: '/tmp/h/sessions/2026/07/07/rollout-x.jsonl',
      },
      { AGENT_RUNTIME: 'codex' }
    );
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '', 'codex drops the stderr-on-exit-0 channel');
    const parsed = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput']);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.equal(
      parsed.hookSpecificOutput.additionalContext,
      `${NOTICE}\n${expectedText(ticket, 1, 1, ['[t] wake up'])}`
    );
  });

  it('codex: nothing new → silent on both channels', () => {
    const ticket = 'ECHO-8003';
    fs.appendFileSync(path.join(inboxDir, `${ticket}.log`), '[t] once\n');
    const payload = {
      tool_name: 'Bash',
      turn_id: 't-1',
      tool_input: { command: `node x.js ${ticket}` },
      transcript_path: '/tmp/h/sessions/2026/07/07/rollout-x.jsonl',
    };
    runHook(payload, { AGENT_RUNTIME: 'codex' });
    const r = runHook(payload, { AGENT_RUNTIME: 'codex' });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  });
});
