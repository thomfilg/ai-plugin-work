// Regression test for the sendLine shell-injection hardening (PR #465 review).
//
// Before the fix, sendLine quoted `text` with JSON.stringify and ran the result
// through `execSync` (which spawns /bin/sh -c). JSON double-quotes do NOT
// escape `$`, backticks, or `\`, so a payload like  `id`  inside a bot review
// title — flowing through handlePrComments → sendLine — could trigger arbitrary
// command substitution on the orchestrator host.
//
// After the fix, sendLine uses spawnSync('tmux', [...args]) directly, so
// metacharacters are passed as literal argv entries and never interpreted by
// a shell. This test proves the payload survives intact.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { sendLine, sendKey } = require('../lib/maestro-conduct/tmux.js');

/**
 * Build a temporary directory holding a fake `tmux` shim that appends each
 * invocation's argv (one per line, NUL-separated) to a log file. Return the
 * dir path so the caller can prepend it to PATH.
 */
function makeFakeTmuxDir(logPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-tmux-'));
  const shim = path.join(dir, 'tmux');
  // Use printf %s\0 so any backticks / $ in args are preserved verbatim.
  const script = [
    '#!/usr/bin/env bash',
    `LOG=${JSON.stringify(logPath)}`,
    'for a in "$@"; do printf "%s\\0" "$a" >>"$LOG"; done',
    'printf "\\n" >>"$LOG"',
    'exit 0',
    '',
  ].join('\n');
  fs.writeFileSync(shim, script);
  fs.chmodSync(shim, 0o755);
  return dir;
}

test('sendLine passes backtick/$ payload to tmux as a literal arg (no shell eval)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sendline-test-'));
  const logPath = path.join(tmpDir, 'tmux.log');
  fs.writeFileSync(logPath, '');
  const fakeBin = makeFakeTmuxDir(logPath);

  const prevPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${prevPath}`;
  try {
    // Payload includes backticks (command substitution), $(...) form, raw $,
    // a backslash, and single + double quotes — every classic shell-injection
    // metacharacter that JSON.stringify would NOT have neutralized.
    const payload = 'hi `id` $(whoami) $USER \\ \' "x"';
    sendLine('GH-TEST-work', payload);
  } finally {
    process.env.PATH = prevPath;
  }

  const raw = fs.readFileSync(logPath, 'utf8');
  // Each invocation is a sequence of NUL-terminated argv strings + trailing \n.
  const invocations = raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split('\0').filter((s) => s.length > 0));

  assert.equal(invocations.length, 3, 'expected three tmux send-keys calls');

  const [first, second, third] = invocations;
  // sendLine uses -l for literal delivery so short payloads can't collide with
  // tmux key names (e.g. "Enter", "Space").
  assert.deepEqual(first.slice(0, 4), ['send-keys', '-l', '-t', 'GH-TEST-work']);
  assert.equal(
    first[4],
    'hi `id` $(whoami) $USER \\ \' "x"',
    'payload must reach tmux verbatim with backticks/$ intact'
  );
  assert.deepEqual(second, ['send-keys', '-t', 'GH-TEST-work', 'End']);
  assert.deepEqual(third, ['send-keys', '-t', 'GH-TEST-work', 'Enter']);
});

test('sendKey passes raw key as a literal argv entry', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sendkey-test-'));
  const logPath = path.join(tmpDir, 'tmux.log');
  fs.writeFileSync(logPath, '');
  const fakeBin = makeFakeTmuxDir(logPath);

  const prevPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${prevPath}`;
  try {
    sendKey('GH-TEST-work', 'Escape');
  } finally {
    process.env.PATH = prevPath;
  }

  const raw = fs.readFileSync(logPath, 'utf8');
  const invocations = raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split('\0').filter((s) => s.length > 0));

  assert.equal(invocations.length, 1);
  assert.deepEqual(invocations[0], ['send-keys', '-t', 'GH-TEST-work', 'Escape']);
});
