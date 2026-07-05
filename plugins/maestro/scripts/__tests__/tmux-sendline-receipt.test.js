// tmux.sendLine receipt contract (GH-449 modes 6/10).
//
// `send-keys … Enter` is fire-and-forget; a busy TUI swallows the Enter and
// the text sits unsubmitted in the composer (observed: a directive queued
// 1.5h while its agent idled). sendLine now captures the pane after sending
// and retries once via C-m, reporting the delivery status.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMUX_LIB = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'tmux.js');

/**
 * Fake tmux whose capture-pane output is scripted per call: reads one line
 * from a queue file per capture. Also logs every invocation.
 */
function makeScriptedTmux(dir, { captures }) {
  const logPath = path.join(dir, 'calls.log');
  const queuePath = path.join(dir, 'captures.queue');
  // One capture output per line, base64-encoded so panes can contain anything.
  fs.writeFileSync(
    queuePath,
    captures.map((c) => Buffer.from(c, 'utf8').toString('base64')).join('\n') + '\n'
  );
  const shim = path.join(dir, 'tmux');
  fs.writeFileSync(
    shim,
    [
      '#!/usr/bin/env bash',
      `printf '%s\\0' "$@" >> "${logPath}"; printf '\\n' >> "${logPath}"`,
      'if [ "$1" = "capture-pane" ]; then',
      `  head -n1 "${queuePath}" | base64 -d`,
      `  sed -i '1d' "${queuePath}"`,
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    { mode: 0o755 }
  );
  return { logPath };
}

function loadTmuxWithPath(fakeDir) {
  delete require.cache[require.resolve(TMUX_LIB)];
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/maestro-conduct/')) delete require.cache[k];
  }
  process.env.MAESTRO_SEND_VERIFY_DELAY_SEC = '0';
  process.env.PATH = `${fakeDir}:${process.env.PATH}`;
  return require(TMUX_LIB);
}

function invocations(logPath) {
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\0').filter(Boolean));
}

test('sendLine: clean composer after Enter → submitted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-ok-'));
  const { logPath } = makeScriptedTmux(dir, { captures: ['● agent output\n❯ \n'] });
  const tmux = loadTmuxWithPath(dir);
  assert.equal(tmux.sendLine('S-work', 'MAESTRO nudge text'), 'submitted');
  const kinds = invocations(logPath).map((i) => `${i[0]}:${i[i.length - 1]}`);
  assert.equal(kinds.filter((k) => k.startsWith('capture-pane')).length, 1);
});

test('sendLine: text stuck after Enter, gone after C-m retry → submitted-on-retry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-retry-'));
  const { logPath } = makeScriptedTmux(dir, {
    captures: [
      '● agent output\n❯ MAESTRO nudge text\n', // Enter swallowed
      '● agent output\n❯ \n', // C-m landed
    ],
  });
  const tmux = loadTmuxWithPath(dir);
  assert.equal(tmux.sendLine('S-work', 'MAESTRO nudge text'), 'submitted-on-retry');
  const flat = invocations(logPath).map((i) => i.join(' '));
  assert.ok(
    flat.some((c) => c.includes('send-keys -t S-work C-m')),
    'retry must use the C-m keycode path'
  );
});

test('sendLine: text still stuck after retry → stuck-in-composer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-stuck-'));
  const stuckPane = '● agent output\n❯ MAESTRO nudge text\n';
  const { logPath } = makeScriptedTmux(dir, { captures: [stuckPane, stuckPane] });
  const tmux = loadTmuxWithPath(dir);
  assert.equal(tmux.sendLine('S-work', 'MAESTRO nudge text'), 'stuck-in-composer');
  assert.ok(invocations(logPath).length >= 5, 'text, End, Enter, capture, End, C-m, capture');
});

test('sendLine: newlines are flattened so send-keys -l cannot submit mid-text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-nl-'));
  const { logPath } = makeScriptedTmux(dir, { captures: ['❯ \n'] });
  const tmux = loadTmuxWithPath(dir);
  tmux.sendLine('S-work', 'line one\nline two');
  const literal = invocations(logPath).find((i) => i[0] === 'send-keys' && i[1] === '-l');
  assert.ok(!literal[literal.length - 1].includes('\n'), 'no raw newline may reach send-keys -l');
  assert.match(literal[literal.length - 1], /line one ⏎ line two/);
});
