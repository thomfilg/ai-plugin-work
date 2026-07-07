// WP-09 — tmux.sendLine dialect awareness: the `❯` receipt probe is a
// claude-TUI contract. Codex dialects skip it (an exec pane has no composer;
// the codex TUI grammar is unverified) and report 'submitted-unverified'.
// Claude callers (no dialect argument) keep the full receipt behavior.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMUX_LIB = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'tmux.js');

function makeLoggingTmux(dir) {
  const logPath = path.join(dir, 'calls.log');
  fs.writeFileSync(
    path.join(dir, 'tmux'),
    [
      '#!/usr/bin/env bash',
      `printf '%s\\0' "$@" >> "${logPath}"; printf '\\n' >> "${logPath}"`,
      // A pane that still shows the text in the composer — a claude receipt
      // probe would see it and retry; codex dialects must never even look.
      'if [ "$1" = "capture-pane" ]; then printf "❯ hello there"; fi',
      'exit 0',
    ].join('\n') + '\n',
    { mode: 0o755 }
  );
  return logPath;
}

function loadTmuxWithPath(fakeDir) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/maestro-conduct/')) delete require.cache[k];
  }
  process.env.MAESTRO_SEND_VERIFY_DELAY_SEC = '0';
  process.env.PATH = `${fakeDir}:${process.env.PATH}`;
  return require(TMUX_LIB);
}

function invocations(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\0').filter(Boolean));
}

test('sendLine on codex dialects: keys sent, receipt probe skipped, submitted-unverified', () => {
  for (const dialect of ['codex-exec-json', 'codex-tui-conservative']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sendline-codex-'));
    const logPath = makeLoggingTmux(dir);
    const tmux = loadTmuxWithPath(dir);

    const status = tmux.sendLine('GH-1-work', 'hello there', dialect);
    assert.equal(status, 'submitted-unverified', dialect);

    const calls = invocations(logPath);
    // Text + End + Enter still delivered…
    assert.ok(
      calls.some((c) => c.includes('send-keys') && c.includes('hello there')),
      `text delivered (${dialect})`
    );
    // …but no capture-pane receipt probe and no C-m retry.
    assert.ok(!calls.some((c) => c.includes('capture-pane')), `no receipt probe on ${dialect}`);
    assert.ok(!calls.some((c) => c.includes('C-m')), `no retry path on ${dialect}`);
  }
});

test('sendLine without a dialect keeps the claude receipt contract (probe runs)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sendline-claude-'));
  const logPath = makeLoggingTmux(dir);
  const tmux = loadTmuxWithPath(dir);

  // The scripted pane always shows the text stuck in the composer, so the
  // claude path probes, retries via C-m, and reports stuck-in-composer.
  const status = tmux.sendLine('GH-1-work', 'hello there');
  assert.equal(status, 'stuck-in-composer');
  const calls = invocations(logPath);
  assert.ok(
    calls.some((c) => c.includes('capture-pane')),
    'receipt probe ran'
  );
  assert.ok(
    calls.some((c) => c.includes('C-m')),
    'retry attempted'
  );
});
