// WP-09 acceptance — inbox naming untouched.
//
// The file mailbox is a plain path contract between our own scripts
// (design §H): `/tmp/claude-agent-inbox` + the `CLAUDE_AGENT_INBOX_DIR`
// env var. Renaming either (e.g. to a codex-flavored name) would break
// every running fleet for zero gain, so this grep-style test locks the
// literals into the modules that own them.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const MAESTRO_ROOT = path.resolve(__dirname, '..', '..');

function read(rel) {
  return fs.readFileSync(path.join(MAESTRO_ROOT, rel), 'utf8');
}

test('namespace.js keeps the /tmp/claude-agent-inbox base and MAESTRO_INBOX_DIR override', () => {
  const src = read('scripts/lib/maestro-conduct/namespace.js');
  assert.match(src, /\/tmp\/claude-agent-inbox/);
  assert.match(src, /MAESTRO_INBOX_DIR/);
});

test('launch paths still export CLAUDE_AGENT_INBOX_DIR (bootstrap + restart-launch)', () => {
  assert.match(read('scripts/maestro-bootstrap.sh'), /CLAUDE_AGENT_INBOX_DIR=/);
  assert.match(read('scripts/lib/maestro-conduct/restart-launch.js'), /CLAUDE_AGENT_INBOX_DIR=/);
});

test('no codex-flavored inbox rename crept into the maestro scripts', () => {
  const files = [
    'scripts/maestro-bootstrap.sh',
    'scripts/lib/maestro-conduct/namespace.js',
    'scripts/lib/maestro-conduct/restart-launch.js',
    'scripts/lib/maestro-conduct/runtime-profile.js',
    'lib/inbox.js',
  ];
  for (const rel of files) {
    const src = read(rel);
    assert.doesNotMatch(src, /codex-agent-inbox|CODEX_AGENT_INBOX/, rel);
  }
});
