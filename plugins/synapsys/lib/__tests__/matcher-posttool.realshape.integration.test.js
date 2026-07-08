'use strict';

/**
 * GH-473 PR follow-up — exit-code payload-shape verification against a REAL
 * captured Claude Code PostToolUse hook payload.
 *
 * WHY THIS EXISTS: the other PostToolUse suites feed SYNTHETIC payloads that
 * already embed `tool_response.exit_code`, so they stay green even if no real
 * payload ever carries that field. A PR reviewer flagged that `trigger_posttool_exit`
 * (AC#1) could therefore be a SILENT NO-OP in production. This suite pins the
 * actual contract using payloads captured on 2026-06-20 from a live Claude Code
 * PostToolUse hook (a temporary capture hook dumped stdin while a headless
 * `claude -p` session ran Bash commands).
 *
 * CONFIRMED REAL SHAPE — the Bash `tool_response` is an object with keys
 *   { stdout, stderr, interrupted, isImage, noOutputExpected }
 * (plus `returnCodeInterpretation` on some failures). It carries NO numeric exit
 * code under tool_response.exit_code, tool_response.exitCode, or payload.exit_code.
 * Top-level payload keys observed: session_id, transcript_path, cwd,
 * permission_mode, effort, hook_event_name, tool_name, tool_input, tool_response,
 * tool_use_id, duration_ms.
 *
 * CONSEQUENCE pinned below: for the Bash tool, `trigger_posttool_exit` fails
 * closed (never fires); failing-Bash detection MUST use `trigger_posttool_content`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const matcher = require(path.resolve(__dirname, '..', 'matcher'));
const memoryStore = require(path.resolve(__dirname, '..', 'memory-store'));
const { _evaluatePostToolExit, _extractPostToolResponse } = require(
  path.resolve(__dirname, '..', 'matcher-posttool')
);

// ---------------------------------------------------------------------------
// REAL captured payloads (verbatim tool_response objects, 2026-06-20).
// ---------------------------------------------------------------------------

// `echo hello` — success. Captured top-level keys preserved to assert the real
// envelope; tool_response is the exact object Claude Code delivered.
const REAL_SUCCESS = {
  session_id: '00000000-real-capture',
  transcript_path: '/tmp/transcript.jsonl',
  cwd: '/tmp',
  permission_mode: 'default',
  effort: 'default',
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'echo hello' },
  tool_response: {
    stdout: 'hello\n',
    stderr: '',
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
  },
  tool_use_id: 'toolu_real_success',
  duration_ms: 12,
};

// `grep nonexistentpattern /etc/hostname` — exit 1. Captured verbatim: note the
// `returnCodeInterpretation` failure annotation and the ABSENCE of any exit code.
const REAL_FAILURE = {
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'grep nonexistentpattern /etc/hostname' },
  tool_response: {
    stdout: '',
    stderr: '',
    interrupted: false,
    isImage: false,
    returnCodeInterpretation: 'No matches found',
    noOutputExpected: false,
  },
};

// A failing `pnpm test`-style run. The KEY SHAPE is the captured real Bash
// tool_response shape (no exit code); only `stdout`/`stderr` carry the command's
// own output — exactly how Claude Code surfaces a Bash command's text.
const REAL_FAILING_TEST = {
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'pnpm test' },
  tool_response: {
    stdout: 'Test Suites: 1 failed, 2 total\nTests: 3 failed, 40 passed',
    stderr: 'FAIL src/foo.test.js',
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
  },
};

function makeStore() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-posttool-realshape-'));
  const storeDir = path.join(cwd, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ projectName: 'posttool-realshape-fixture' })
  );
  return { cwd, storeDir, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

function writeMemory(storeDir, name, frontmatterLines, body) {
  const file = path.join(storeDir, `${name}.md`);
  fs.writeFileSync(file, ['---', ...frontmatterLines, '---', '', body, ''].join('\n'));
  return file;
}

// ===========================================================================
// (1) Shape assertions — the captured envelope carries NO exit code.
// ===========================================================================

test('real Bash tool_response carries no exit code under any read key', () => {
  for (const payload of [REAL_SUCCESS, REAL_FAILURE, REAL_FAILING_TEST]) {
    const resp = payload.tool_response;
    assert.equal(
      resp.exit_code,
      undefined,
      'tool_response.exit_code must be absent in real payload'
    );
    assert.equal(resp.exitCode, undefined, 'tool_response.exitCode must be absent in real payload');
    assert.equal(payload.exit_code, undefined, 'payload.exit_code must be absent in real payload');
  }
});

test('real tool_response is stringified into the content surface', () => {
  const text = _extractPostToolResponse(REAL_FAILING_TEST);
  assert.ok(
    text.includes('FAIL src/foo.test.js'),
    'stderr must be searchable in the content surface'
  );
  assert.ok(text.includes('1 failed'), 'stdout must be searchable in the content surface');
});

// ===========================================================================
// (2) trigger_posttool_exit FAILS CLOSED on the real Bash shape (the no-op).
// ===========================================================================

test('trigger_posttool_exit fails closed on a real Bash payload (no exit code present)', () => {
  // nonzero spec but no resolvable code → matched:false (silent no-op for Bash).
  const onFailure = _evaluatePostToolExit({ triggerPosttoolExit: 'nonzero' }, REAL_FAILURE);
  assert.deepEqual(
    onFailure,
    { matched: false },
    'nonzero exit gate must fail closed when no code is present'
  );

  const onSuccess = _evaluatePostToolExit({ triggerPosttoolExit: 'zero' }, REAL_SUCCESS);
  assert.deepEqual(
    onSuccess,
    { matched: false },
    'zero exit gate must fail closed when no code is present'
  );
});

test('an exit-gated memory does NOT fire end-to-end on a real failing Bash payload', (t) => {
  const { storeDir, cleanup } = makeStore();
  t.after(cleanup);
  writeMemory(
    storeDir,
    'exit-gated-bash',
    [
      'name: exit-gated-bash',
      'description: Exit-gated failing-test reminder.',
      'events: PostToolUse',
      'trigger_pretool: "Bash:pnpm test"',
      'trigger_posttool_exit: nonzero',
      'trigger_session: false',
      'inject: full',
    ],
    'Tests failed (exit-gated).'
  );
  const memories = memoryStore.listMemoriesFromStore({ dir: storeDir });
  const fired = matcher.selectForEvent(memories, 'PostToolUse', REAL_FAILING_TEST);
  assert.equal(
    fired.length,
    0,
    'exit-gated memory must NOT fire on the real Bash shape — proves exit gating is a no-op for Bash'
  );
  const result = matcher.matchPostTool(memories[0], REAL_FAILING_TEST);
  assert.equal(result.reason, 'no-exit-match', 'suppression reason is the fail-closed exit gate');
});

// ===========================================================================
// (3) The SUPPORTED Bash failure path — content gate — fires on the real shape.
// ===========================================================================

test('a content-gated memory DOES fire on the real failing Bash payload', (t) => {
  const { storeDir, cleanup } = makeStore();
  t.after(cleanup);
  writeMemory(
    storeDir,
    'content-gated-bash',
    [
      'name: content-gated-bash',
      'description: Content-gated failing-test reminder.',
      'events: PostToolUse',
      'trigger_pretool: "Bash:pnpm test"',
      'trigger_posttool_content: "FAIL|failed"',
      'trigger_session: false',
      'inject: full',
    ],
    'Tests failed (content-gated).'
  );
  const memories = memoryStore.listMemoriesFromStore({ dir: storeDir });

  // Fires on the real failing payload (stderr contains FAIL).
  const fired = matcher.selectForEvent(memories, 'PostToolUse', REAL_FAILING_TEST);
  assert.equal(
    fired.length,
    1,
    'content-gated memory must fire on real failure output — the supported Bash path'
  );

  // Stays silent on the real success payload (no FAIL/failed text).
  const quiet = matcher.selectForEvent(memories, 'PostToolUse', REAL_SUCCESS);
  assert.equal(quiet.length, 0, 'content-gated memory must stay silent on a real successful run');
});
