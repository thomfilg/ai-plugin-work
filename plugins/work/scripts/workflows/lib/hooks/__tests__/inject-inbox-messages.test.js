'use strict';

/**
 * Tests for inject-inbox-messages.js — the PostToolUse hook that delivers
 * new inbox lines into the agent's tool result via stderr. Validates:
 *
 *   1. Ticket-id derivation priority (transcript_path > tool_input.command).
 *   2. Cursor state advances and prevents re-injecting the same line.
 *   3. New lines appended after first fire are picked up on the next fire.
 *   4. Cap at 5 lines per fire (no flooding).
 *   5. Empty/missing inbox file → fail-open silently.
 *   6. INJECT_INBOX=0 → disabled (no output).
 *   7. Malformed JSON stdin → fail-open silently.
 */

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', 'inject-inbox-messages.js');

function runHook(stdinObj, env = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(stdinObj),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function appendInbox(file, ...lines) {
  fs.appendFileSync(file, lines.map((l) => `${l}\n`).join(''));
}

describe('inject-inbox-messages.js', () => {
  let tmp;
  let inboxDir;
  let stateDir;
  let envBase;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-inbox-'));
    inboxDir = path.join(tmp, 'inbox');
    stateDir = path.join(tmp, '.claude', 'work-workflow', 'state');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    // Hide real ~/.claude state by pointing HOME at tmp.
    envBase = {
      HOME: tmp,
      CLAUDE_AGENT_INBOX_DIR: inboxDir,
    };
  });

  beforeEach(() => {
    // Reset cursor file between tests (HOME-based path).
    const cursors = path.join(stateDir, 'inbox-cursors.json');
    try {
      fs.unlinkSync(cursors);
    } catch {
      /* ignore */
    }
    // Reset inbox files between tests.
    for (const f of fs.readdirSync(inboxDir)) {
      fs.unlinkSync(path.join(inboxDir, f));
    }
  });

  after(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('derives ticket from transcript_path and injects all new lines', () => {
    const ticket = 'ECHO-7001';
    const inbox = path.join(inboxDir, `${ticket}.log`);
    appendInbox(inbox, '[t] hello', '[t] world');

    const r = runHook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        transcript_path: `/x/y/tabwoah-${ticket}-something/abc.jsonl`,
      },
      envBase
    );

    assert.equal(r.code, 0, 'hook always exits 0 (fail-open)');
    assert.match(r.stderr, /Monitor messages for ECHO-7001 \(2\/2 new\)/);
    assert.match(r.stderr, /\[MONITOR\] \[t\] hello/);
    assert.match(r.stderr, /\[MONITOR\] \[t\] world/);
  });

  it('falls back to command when transcript has no ticket', () => {
    const ticket = 'ECHO-7002';
    appendInbox(path.join(inboxDir, `${ticket}.log`), '[t] from-cmd');

    const r = runHook(
      {
        tool_name: 'Bash',
        tool_input: { command: `node x.js ${ticket} task1` },
        transcript_path: '/x/no-ticket-here/abc.jsonl',
      },
      envBase
    );
    assert.match(r.stderr, /Monitor messages for ECHO-7002/);
    assert.match(r.stderr, /\[MONITOR\] \[t\] from-cmd/);
  });

  it('cursor prevents re-injecting the same line on a second fire', () => {
    const ticket = 'ECHO-7003';
    const inbox = path.join(inboxDir, `${ticket}.log`);
    appendInbox(inbox, '[t] one', '[t] two');

    const stdin = {
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      transcript_path: `/x/${ticket}/abc.jsonl`,
    };

    const r1 = runHook(stdin, envBase);
    assert.match(r1.stderr, /\(2\/2 new\)/);

    const r2 = runHook(stdin, envBase);
    assert.equal(r2.stderr.trim(), '', 'second fire with no new lines emits nothing');
  });

  it('appended lines after first fire are picked up on next fire', () => {
    const ticket = 'ECHO-7004';
    const inbox = path.join(inboxDir, `${ticket}.log`);
    appendInbox(inbox, '[t] one');

    const stdin = {
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      transcript_path: `/x/${ticket}/abc.jsonl`,
    };

    runHook(stdin, envBase); // cursor → 1
    appendInbox(inbox, '[t] two', '[t] three');

    const r2 = runHook(stdin, envBase);
    assert.match(r2.stderr, /\(2\/2 new\)/);
    assert.match(r2.stderr, /\[MONITOR\] \[t\] two/);
    assert.match(r2.stderr, /\[MONITOR\] \[t\] three/);
    assert.doesNotMatch(r2.stderr, /\[MONITOR\] \[t\] one/);
  });

  it('caps output at 5 lines per fire (last 5 of however many are new)', () => {
    const ticket = 'ECHO-7005';
    const inbox = path.join(inboxDir, `${ticket}.log`);
    appendInbox(inbox, '[t] 1', '[t] 2', '[t] 3', '[t] 4', '[t] 5', '[t] 6', '[t] 7', '[t] 8');

    const r = runHook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        transcript_path: `/x/${ticket}/abc.jsonl`,
      },
      envBase
    );
    assert.match(r.stderr, /\(5\/8 new\)/, 'shows 5-out-of-8 in the header');
    // Should contain the last 5 (4..8), not the first 3.
    for (const n of [4, 5, 6, 7, 8]) {
      assert.match(r.stderr, new RegExp(`\\[MONITOR\\] \\[t\\] ${n}\\b`));
    }
    for (const n of [1, 2, 3]) {
      assert.doesNotMatch(r.stderr, new RegExp(`\\[MONITOR\\] \\[t\\] ${n}\\b`));
    }
  });

  it('no inbox file → silent fail-open (exit 0, no stderr)', () => {
    const r = runHook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        transcript_path: '/x/ECHO-7006/abc.jsonl',
      },
      envBase
    );
    assert.equal(r.code, 0);
    assert.equal(r.stderr.trim(), '');
  });

  it('INJECT_INBOX=0 disables the hook (no output even if messages exist)', () => {
    const ticket = 'ECHO-7007';
    appendInbox(path.join(inboxDir, `${ticket}.log`), '[t] should-not-appear');

    const r = runHook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        transcript_path: `/x/${ticket}/abc.jsonl`,
      },
      { ...envBase, INJECT_INBOX: '0' }
    );
    assert.equal(r.code, 0);
    assert.equal(r.stderr.trim(), '');
  });

  it('malformed stdin → silent fail-open (exit 0, no stderr)', () => {
    const r = spawnSync(process.execPath, [HOOK], {
      input: '{not-json',
      encoding: 'utf8',
      env: { ...process.env, ...envBase },
    });
    assert.equal(r.status, 0);
    assert.equal((r.stderr || '').trim(), '');
  });
});
