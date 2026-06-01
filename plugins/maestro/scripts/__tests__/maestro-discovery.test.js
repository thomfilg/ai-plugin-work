// Discovery parity tests — ported from the old maestro-conduct.sh
// discover_sessions / ticket_id_for tests onto the JS conduct module.
//
// Acceptance:
//   - tmux.listSessions() discovers ECHO-*-work, ECHO-*-dev, ECHO-*-listen
//   - ticket_id_for strips work|dev|listen suffix → bare ticket id
//   - Unrelated sessions (`-clip`, prefix mismatch, lowercase) are skipped
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMUX_LIB = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'tmux.js');

/**
 * Build a fake `tmux` shim that responds to `ls` with a fixed session list.
 * Returns the temp dir so the caller can prepend it to PATH.
 */
function makeFakeTmuxDir(sessions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-tmux-ls-'));
  const script = path.join(dir, 'tmux');
  const lines = sessions.map((s) => `${s}: 1 windows`).join('\n');
  fs.writeFileSync(
    script,
    `#!/usr/bin/env bash\nif [ "$1" = "ls" ]; then\n  cat <<'EOF'\n${lines}\nEOF\nfi\nexit 0\n`,
    { mode: 0o755 }
  );
  return dir;
}

function loadFreshTmux(prefix, fakeDir) {
  // Reset env + module cache so resolveTicketPrefix re-reads TICKET_PREFIX and
  // the new PATH binding takes effect.
  delete require.cache[require.resolve(TMUX_LIB)];
  if (prefix === null) delete process.env.TICKET_PREFIX;
  else process.env.TICKET_PREFIX = prefix;
  delete process.env.SESSION_PATTERN;
  process.env.PATH = `${fakeDir}:${process.env.PATH}`;
  return require(TMUX_LIB);
}

test('listSessions discovers ECHO -work, -dev, -listen helpers', () => {
  const sessions = [
    'ECHO-1-work',
    'ECHO-2-dev',
    'ECHO-3-listen',
    'ECHO-4-clip', // not a recognized maestro suffix
    'unrelated', // no prefix
    'gh-5-work', // wrong case
  ];
  const fakeDir = makeFakeTmuxDir(sessions);
  const tmux = loadFreshTmux('ECHO', fakeDir);

  const discovered = tmux.listSessions();
  assert.deepStrictEqual(discovered.sort(), ['ECHO-1-work', 'ECHO-2-dev', 'ECHO-3-listen'].sort());
});

test('listSessions defaults to GH when TICKET_PREFIX is unset', () => {
  const sessions = ['GH-7-work', 'GH-7-dev', 'GH-7-listen', 'ECHO-1-work'];
  const fakeDir = makeFakeTmuxDir(sessions);
  const tmux = loadFreshTmux(null, fakeDir);

  const discovered = tmux.listSessions();
  assert.deepStrictEqual(discovered.sort(), ['GH-7-work', 'GH-7-dev', 'GH-7-listen'].sort());
});

test('ticketIdFor strips work | dev | listen suffix', () => {
  const tmux = require(TMUX_LIB);
  assert.strictEqual(tmux.ticketIdFor('ECHO-5327-work'), 'ECHO-5327');
  assert.strictEqual(tmux.ticketIdFor('ECHO-5327-dev'), 'ECHO-5327');
  assert.strictEqual(tmux.ticketIdFor('ECHO-5327-listen'), 'ECHO-5327');
  // Non-maestro suffix: leave unchanged.
  assert.strictEqual(tmux.ticketIdFor('ECHO-5327-other'), 'ECHO-5327-other');
});

test('discovery rejects ambiguous compound suffixes like GH-42-dev-work', () => {
  // Regression: an earlier [A-Z0-9-]+ ticket-id class would greedily consume
  // "42-dev" and let the suffix group match "-work", classifying a stray
  // session name as a valid -work ticket. Numeric-only ticket id avoids it.
  const fakeDir = makeFakeTmuxDir(['GH-42-dev-work', 'GH-42-work']);
  const tmux = loadFreshTmux(null, fakeDir);
  const discovered = tmux.listSessions();
  assert.deepStrictEqual(discovered, ['GH-42-work']);
});

test('SESSION_PATTERN env overrides the dynamic default', () => {
  const sessions = ['ECHO-1-work', 'CUSTOM-9'];
  const fakeDir = makeFakeTmuxDir(sessions);
  const tmux = loadFreshTmux('ECHO', fakeDir);
  process.env.SESSION_PATTERN = '^CUSTOM-[0-9]+$';

  const discovered = tmux.listSessions();
  assert.deepStrictEqual(discovered, ['CUSTOM-9']);
  delete process.env.SESSION_PATTERN;
});
