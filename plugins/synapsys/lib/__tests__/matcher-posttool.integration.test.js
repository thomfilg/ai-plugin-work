'use strict';

/**
 * GH-473 Task 10 — Golden + integration + e2e coverage for PostToolUse.
 *
 * Unlike matcher-posttool.test.js (which requires the sub-module directly and
 * injects fake helpers), this suite exercises the ALREADY-SHIPPED surface
 * end-to-end against the real wiring:
 *
 *   (a) golden content-gate: a memory parsed from real frontmatter through
 *       memory-store fires through matcher.selectForEvent only on the intended
 *       tool_response, and its negative content gate suppresses an otherwise
 *       positive match (P2-2).
 *   (b) exit-gate: a `trigger_pretool: "Bash:pnpm test"` +
 *       `trigger_posttool_exit: "nonzero"` memory fires on exit_code 1 and is
 *       'no-exit-match' on exit_code 0 (P2-3).
 *   (c) pretool target mismatch → the memory does not fire (no-pretool-match).
 *   (d) the synapsys.js PostToolUse hook exits 0 within budget on a
 *       failing-test payload and stdout contains the memory body (AC-hook-e2e).
 *
 * No production edits in this task — only this new test file. It asserts the
 * contract delivered by Tasks 1–9.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const matcher = require(path.resolve(__dirname, '..', 'matcher'));
const memoryStore = require(path.resolve(__dirname, '..', 'memory-store'));

const DISPATCHER = path.resolve(__dirname, '..', '..', 'hooks', 'synapsys.js');

// ----------------------------------------------------------------------------
// Fixture helpers: write a real frontmatter memory file, parse it through
// memory-store, so the integration tests operate on genuinely-parsed memory
// objects (camelCase trigger fields) rather than hand-built literals.
// ----------------------------------------------------------------------------

function makeStore() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-posttool-int-'));
  const storeDir = path.join(cwd, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ projectName: 'posttool-integration-fixture' })
  );
  return { cwd, storeDir, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

function writeMemory(storeDir, name, frontmatterLines, body) {
  const file = path.join(storeDir, `${name}.md`);
  const content = ['---', ...frontmatterLines, '---', '', body, ''].join('\n');
  fs.writeFileSync(file, content);
  return file;
}

// Parse every memory file in the fixture store back into the runtime memory
// object shape (camelCase trigger fields) that matcher.selectForEvent consumes.
function loadMemories(storeDir) {
  return memoryStore.listMemoriesFromStore({ dir: storeDir });
}

function postPayload(overrides) {
  return Object.assign(
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test' },
      tool_response: { stdout: '', stderr: '', exit_code: 0 },
    },
    overrides
  );
}

// ===========================================================================
// (a) GOLDEN content-gate: positive + negative (P2-2)
// ===========================================================================

test('golden content gate: fires only on the intended tool_response payload', (t) => {
  const { storeDir, cleanup } = makeStore();
  t.after(cleanup);

  writeMemory(
    storeDir,
    'enotfound-network-error',
    [
      'name: enotfound-network-error',
      'description: Network DNS failure reminder.',
      'events: PostToolUse',
      'trigger_pretool: Bash',
      'trigger_posttool_content: ENOTFOUND',
      'trigger_session: false',
      'inject: full',
    ],
    'Check your network / proxy — the host could not be resolved.'
  );
  const memories = loadMemories(storeDir);
  assert.equal(memories.length, 1, 'fixture memory should parse');

  // Intended payload: tool_response contains ENOTFOUND → fires.
  const firedOnMatch = matcher.selectForEvent(
    memories,
    'PostToolUse',
    postPayload({ tool_response: { stderr: 'getaddrinfo ENOTFOUND registry.npmjs.org', exit_code: 1 } })
  );
  assert.equal(firedOnMatch.length, 1, 'content-gated memory must fire on the matching tool_response');

  // Unrelated payload: no ENOTFOUND anywhere → must NOT fire.
  const noFire = matcher.selectForEvent(
    memories,
    'PostToolUse',
    postPayload({ tool_response: { stdout: 'All tests passed', exit_code: 0 } })
  );
  assert.equal(noFire.length, 0, 'content-gated memory must NOT fire on a non-matching tool_response');
});

test('negative content gate suppresses an otherwise-positive match', (t) => {
  const { storeDir, cleanup } = makeStore();
  t.after(cleanup);

  writeMemory(
    storeDir,
    'flaky-test-not-timeout',
    [
      'name: flaky-test-not-timeout',
      'description: Flaky failure reminder, but not for timeouts.',
      'events: PostToolUse',
      'trigger_pretool: Bash',
      'trigger_posttool_content: FAIL',
      'trigger_posttool_content_not: timeout',
      'trigger_session: false',
      'inject: full',
    ],
    'A test failed — re-run to confirm it is not flaky.'
  );
  const memories = loadMemories(storeDir);

  // Positive pattern present (FAIL), negative absent → fires.
  const fired = matcher.selectForEvent(
    memories,
    'PostToolUse',
    postPayload({ tool_response: { stdout: 'FAIL src/foo.test.ts', exit_code: 1 } })
  );
  assert.equal(fired.length, 1, 'should fire when positive matches and negative is absent');

  // Positive present (FAIL) AND negative present (timeout) → suppressed.
  const suppressed = matcher.selectForEvent(
    memories,
    'PostToolUse',
    postPayload({ tool_response: { stdout: 'FAIL src/foo.test.ts: timeout exceeded', exit_code: 1 } })
  );
  assert.equal(
    suppressed.length,
    0,
    'negative content pattern must suppress an otherwise-positive content match'
  );
});

// ===========================================================================
// (b) EXIT-gate: Bash:pnpm test + trigger_posttool_exit nonzero (P2-3)
// ===========================================================================

test('exit gate: fires on exit_code 1 and not on exit_code 0', (t) => {
  const { storeDir, cleanup } = makeStore();
  t.after(cleanup);

  writeMemory(
    storeDir,
    'failing-test-reminder',
    [
      'name: failing-test-reminder',
      'description: Failing test reminder.',
      'events: PostToolUse',
      'trigger_pretool: "Bash:pnpm test"',
      'trigger_posttool_exit: nonzero',
      'trigger_session: false',
      'inject: full',
    ],
    'Tests failed — read the failure above before pushing.'
  );
  const memories = loadMemories(storeDir);
  assert.equal(memories[0].triggerPosttoolExit, 'nonzero', 'exit gate must parse from frontmatter');

  // Nonzero exit → fires.
  const onNonzero = matcher.selectForEvent(
    memories,
    'PostToolUse',
    postPayload({ tool_response: { stdout: '1 failing', exit_code: 1 } })
  );
  assert.equal(onNonzero.length, 1, 'failing-test memory must fire on a nonzero exit');

  // Zero exit → suppressed (no-exit-match).
  const onZero = matcher.selectForEvent(
    memories,
    'PostToolUse',
    postPayload({ tool_response: { stdout: 'all green', exit_code: 0 } })
  );
  assert.equal(onZero.length, 0, 'failing-test memory must NOT fire on a successful (zero) exit');

  // Direct matcher introspection: the suppression reason is exactly no-exit-match.
  const zeroResult = matcher.matchPostTool(
    memories[0],
    postPayload({ tool_response: { stdout: 'all green', exit_code: 0 } })
  );
  assert.equal(zeroResult.fired, false);
  assert.equal(zeroResult.reason, 'no-exit-match');
});

// ===========================================================================
// (c) trigger_pretool target mismatch → no-pretool-match
// ===========================================================================

test('pretool target mismatch does not fire (no-pretool-match)', (t) => {
  const { storeDir, cleanup } = makeStore();
  t.after(cleanup);

  writeMemory(
    storeDir,
    'failing-test-reminder-bash-only',
    [
      'name: failing-test-reminder-bash-only',
      'description: Failing test reminder, Bash only.',
      'events: PostToolUse',
      'trigger_pretool: "Bash:pnpm test"',
      'trigger_posttool_exit: nonzero',
      'trigger_session: false',
      'inject: full',
    ],
    'Tests failed.'
  );
  const memories = loadMemories(storeDir);

  // Tool is Read, not Bash → pretool target mismatch even though exit is nonzero.
  const payload = postPayload({
    tool_name: 'Read',
    tool_input: { file_path: '/x' },
    tool_response: { stdout: 'oops', exit_code: 1 },
  });
  const fired = matcher.selectForEvent(memories, 'PostToolUse', payload);
  assert.equal(fired.length, 0, 'memory must not fire when the trigger_pretool target tool mismatches');

  const result = matcher.matchPostTool(memories[0], payload);
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'no-pretool-match');
});

// ===========================================================================
// (d) HOOK e2e through synapsys.js (AC-hook-e2e)
// ===========================================================================

function runDispatcher(cwd, sessionTmp, payload) {
  return spawnSync(process.execPath, [DISPATCHER, 'PostToolUse'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      SYNAPSYS_NO_SETUP_HINT: '1',
      SYNAPSYS_SESSION_DIR: sessionTmp,
    },
  });
}

test('hook e2e: synapsys.js PostToolUse exits 0 and injects the memory body on a failing test run', (t) => {
  const { cwd, storeDir, cleanup } = makeStore();
  const sessionTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-posttool-int-session-'));
  t.after(() => {
    cleanup();
    fs.rmSync(sessionTmp, { recursive: true, force: true });
  });

  const body = 'Tests failed — read the failure above before pushing.';
  writeMemory(
    storeDir,
    'failing-test-e2e',
    [
      'name: failing-test-e2e',
      'description: Failing test e2e reminder.',
      'events: PostToolUse',
      'trigger_pretool: "Bash:pnpm test"',
      'trigger_posttool_exit: nonzero',
      'trigger_session: false',
      'inject: full',
    ],
    body
  );

  const payload = {
    hook_event_name: 'PostToolUse',
    cwd,
    tool_name: 'Bash',
    tool_input: { command: 'pnpm test' },
    tool_response: { stdout: '1 failing', stderr: '', exit_code: 1 },
  };

  const start = Date.now();
  const result = runDispatcher(cwd, sessionTmp, payload);
  const elapsed = Date.now() - start;

  assert.equal(result.status, 0, `dispatcher exited non-zero: stderr=${result.stderr}`);
  assert.ok(elapsed < 20000, `hook should complete within budget, took ${elapsed}ms`);
  assert.ok(
    result.stdout.includes(body),
    `PostToolUse memory body was not injected end-to-end. stdout=${result.stdout}`
  );
});
