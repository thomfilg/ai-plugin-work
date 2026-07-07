// WP-09 — detectors/exec-json.js: aliveness/silence over a teed
// `codex exec --json` stream. The fixture mirrors probe-verified event shapes
// (thread.started / turn.started / item.started+completed command_execution /
// agent_message / turn.completed with usage — /tmp/codex-probe-logs/
// exec1-envprobe.jsonl, adapter design Appendix 2 P8).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const EXEC_JSON_LIB = path.resolve(
  __dirname,
  '..',
  'lib',
  'maestro-conduct',
  'detectors',
  'exec-json.js'
);
const STATE_LIB = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'state.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'codex-exec', 'exec-stream.jsonl');

function freshModules(env = {}) {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/maestro-conduct/')) delete require.cache[key];
  }
  Object.assign(process.env, env);
  return { execJson: require(EXEC_JSON_LIB), state: require(STATE_LIB) };
}

function sandbox() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-json-'));
  return { tmp, stateDir: path.join(tmp, 'state') };
}

test('readStreamInfo: turns, token usage, and the bypass-warning confirmation from the fixture', () => {
  const { tmp } = sandbox();
  const { execJson } = freshModules({ STATE_DIR: path.join(tmp, 'state') });
  const info = execJson.readStreamInfo(FIXTURE);
  assert.equal(info.turnsCompleted, 2, 'two turn.completed records in the fixture');
  // Last turn.completed usage: input 81210 + output 1890.
  assert.equal(info.lastTokens, 83100);
  assert.equal(info.lastEventType, 'turn.completed');
  // §H: the --dangerously-bypass-hook-trust warning item is the conductor's
  // confirmation that hooks actually ran on this agent.
  assert.equal(info.hookTrustBypassed, true);
});

test('readStreamInfo: missing stream → unavailable, zero counts', () => {
  const { tmp } = sandbox();
  const { execJson } = freshModules({ STATE_DIR: path.join(tmp, 'state') });
  const info = execJson.readStreamInfo(path.join(tmp, 'nope.exec.jsonl'));
  assert.equal(info.unavailable, true);
  assert.equal(info.turnsCompleted, 0);
  assert.equal(info.lastTokens, null);
});

test('detect: first sighting and appended bytes are alive; a stalled stream past the limit hits', () => {
  const { tmp, stateDir } = sandbox();
  const { execJson, state } = freshModules({ STATE_DIR: stateDir });
  const execLog = path.join(tmp, 'GH-42.exec.jsonl');
  fs.copyFileSync(FIXTURE, execLog);
  const ctx = { session: 'GH-42-work', ticket: 'GH-42', execLog, limitSec: 300 };

  // First sighting → alive (marker seeded).
  assert.deepEqual(execJson.detect(ctx), { hit: false });

  // Same size, recent marker → silent but under the limit.
  const under = execJson.detect(ctx);
  assert.equal(under.hit, false);
  assert.ok(under.silenceSec >= 0);

  // Same size, marker aged past the limit → silence verdict with stream info.
  // Stat + append on ONE descriptor — no path-based check-then-use gap
  // (CodeQL js/file-system-race, precedent 47107ae6). The 0o600 mode is
  // inert for an existing file but satisfies js/insecure-temporary-file.
  const fd = fs.openSync(execLog, 'a', 0o600);
  try {
    state.write('GH-42-work', 'exec-json', {
      size: fs.fstatSync(fd).size,
      lastActiveAt: state.now() - 9999,
    });
    const hit = execJson.detect(ctx);
    assert.equal(hit.hit, true);
    assert.equal(hit.kind, 'silence');
    assert.ok(hit.silenceSec >= 9999);
    assert.equal(hit.limitSec, 300);
    assert.equal(hit.turnsCompleted, 2);

    // Bytes appended → alive again and the marker refreshes. O_APPEND
    // writes always land at EOF, and fstat reuses the same descriptor.
    fs.appendFileSync(fd, '{"type":"turn.started"}\n');
    assert.deepEqual(execJson.detect(ctx), { hit: false });
    const refreshed = state.read('GH-42-work', 'exec-json');
    assert.equal(refreshed.size, fs.fstatSync(fd).size);
  } finally {
    fs.closeSync(fd);
  }
});

test('detect: missing/absent stream is fail-open (no-stream capability, never a restart verdict)', () => {
  const { tmp, stateDir } = sandbox();
  const { execJson } = freshModules({ STATE_DIR: stateDir });
  const missing = execJson.detect({
    session: 'GH-1-work',
    ticket: 'GH-1',
    execLog: path.join(tmp, 'absent.exec.jsonl'),
    limitSec: 300,
  });
  assert.equal(missing.hit, false);
  assert.equal(missing.capability, 'no-stream');
  const noPath = execJson.detect({ session: 'GH-1-work', ticket: 'GH-1', limitSec: 300 });
  assert.equal(noPath.hit, false);
  assert.equal(noPath.capability, 'no-stream');
});

test('detect: a truncated/rotated stream refreshes the marker instead of counting as silence', () => {
  const { tmp, stateDir } = sandbox();
  const { execJson, state } = freshModules({ STATE_DIR: stateDir });
  const execLog = path.join(tmp, 'GH-9.exec.jsonl');
  fs.copyFileSync(FIXTURE, execLog);
  const ctx = { session: 'GH-9-work', ticket: 'GH-9', execLog, limitSec: 300 };
  execJson.detect(ctx); // seed
  // Rotate: file shrinks. An old lastActiveAt must NOT produce a hit — the
  // size change is treated as activity.
  state.write('GH-9-work', 'exec-json', {
    size: fs.statSync(execLog).size,
    lastActiveAt: state.now() - 9999,
  });
  fs.writeFileSync(execLog, '{"type":"thread.started"}\n');
  assert.deepEqual(execJson.detect(ctx), { hit: false });
});
