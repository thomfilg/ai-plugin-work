'use strict';

// inbox-dir.js (GH-622) — /work messaging must resolve the SAME per-namespace
// mailbox maestro uses, so signal/listen don't split-brain under MAESTRO_NS.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const LIB = path.resolve(__dirname, '..', 'inbox-dir.js');

function load(env = {}) {
  delete require.cache[require.resolve(LIB)];
  delete process.env.CLAUDE_AGENT_INBOX_DIR;
  delete process.env.MAESTRO_NS;
  Object.assign(process.env, env);
  return require(LIB).resolveInboxDir;
}

test('unset MAESTRO_NS → historical global mailbox (back-compat)', () => {
  assert.equal(load()(), '/tmp/claude-agent-inbox');
});

test('MAESTRO_NS nests the mailbox under the namespace', () => {
  assert.equal(load({ MAESTRO_NS: 'proj-a' })(), '/tmp/claude-agent-inbox/proj-a');
});

test('malformed MAESTRO_NS falls open to the global mailbox (no path injection)', () => {
  for (const bad of ['a/b', 'a.b', 'a b', '', '..']) {
    assert.equal(load({ MAESTRO_NS: bad })(), '/tmp/claude-agent-inbox', `"${bad}"`);
  }
});

test('CLAUDE_AGENT_INBOX_DIR overrides the NS-derived default', () => {
  assert.equal(load({ MAESTRO_NS: 'proj-a', CLAUDE_AGENT_INBOX_DIR: '/custom' })(), '/custom');
});

test('agrees with maestro namespace.inboxDir() under the same MAESTRO_NS', () => {
  // The two plugins use different override vars but MUST share the NS-derived
  // default, else /work and maestro signal land in different dirs (GH-622).
  const resolve = load({ MAESTRO_NS: 'proj-a' });
  const maestroNs = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'maestro',
    'scripts',
    'lib',
    'maestro-conduct',
    'namespace.js'
  );
  delete require.cache[require.resolve(maestroNs)];
  const maestro = require(maestroNs);
  assert.equal(resolve(), maestro.inboxDir());
});
