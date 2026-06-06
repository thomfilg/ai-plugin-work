'use strict';

/**
 * Dispatcher-level e2e integration test for the `trigger_stop_response`
 * field (GH-521, Task 5).
 *
 * Invokes the synapsys dispatcher `hooks/synapsys.js` with a Stop event +
 * stdin JSON payload (`response`, `tool_inputs`, `tool_results`) and asserts:
 *   (i)  matching response   → exit 0, stdout contains memory header.
 *   (ii) non-matching response → exit 0, stdout empty.
 *
 * Covers:
 *   - R11 (dispatcher-level integration test for the new field path).
 *   - R12 / Gherkin @e2e — End-to-end Stop hook injection only when agent
 *     response matches.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DISPATCHER = path.resolve(__dirname, '..', '..', 'hooks', 'synapsys.js');

const MEMORY_NAME = 'flaky-test-fix-protocol';
const MEMORY_DESCRIPTION = 'Steps to take when a test goes flaky.';
const MEMORY_BODY =
  'When a test goes flaky:\n' +
  '1. Reproduce locally with --runInBand.\n' +
  '2. Quarantine before bumping the timeout.';
const STOP_REGEX = '\\b(flaky|bump\\s+timeout)\\b';

// Build a worktree-kind store at `<base>/.claude/synapsys` with the session
// cwd at `<base>/worktree-stop-response/` (one level below the store base).
// This produces `[synapsys:worktree] <name>` in dispatcher output, matching
// the Task 5 acceptance criteria.
function makeWorktreeStore() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-stop-resp-'));
  const storeDir = path.join(base, '.claude', 'synapsys');
  const cwd = path.join(base, 'worktree-stop-response');

  fs.mkdirSync(storeDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });

  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({
      kind: 'worktree',
      projectName: 'stop-response-fixture',
      schemaVersion: 1,
    })
  );

  const frontmatter = [
    '---',
    `name: ${MEMORY_NAME}`,
    `description: ${MEMORY_DESCRIPTION}`,
    'events: Stop',
    `trigger_stop_response: ${STOP_REGEX}`,
    'trigger_session: false',
    'inject: full',
    '---',
    '',
    MEMORY_BODY,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(storeDir, `${MEMORY_NAME}.md`), frontmatter);

  const sessionTmp = path.join(base, '.session');
  fs.mkdirSync(sessionTmp, { recursive: true });

  return {
    base,
    cwd,
    sessionTmp,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

function runDispatcher(payload, sessionTmp) {
  return spawnSync(process.execPath, [DISPATCHER, 'Stop'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      SYNAPSYS_NO_SETUP_HINT: '1',
      SYNAPSYS_SESSION_DIR: sessionTmp,
    },
  });
}

test('Stop dispatcher injects memory when agent response matches trigger_stop_response', (t) => {
  const { cwd, sessionTmp, cleanup } = makeWorktreeStore();
  t.after(cleanup);

  const payload = {
    hook_event_name: 'Stop',
    cwd,
    response: 'this test is flaky, let me bump timeout to stabilize it',
    tool_inputs: [],
    tool_results: [],
  };

  const result = runDispatcher(payload, sessionTmp);

  assert.equal(result.status, 0, `dispatcher exited non-zero: stderr=${result.stderr}`);
  assert.ok(
    result.stdout.includes(`[synapsys:worktree] ${MEMORY_NAME}`),
    `expected stdout to contain memory header; got: ${JSON.stringify(result.stdout)}`
  );
});

test('Stop dispatcher emits no output when agent response does not match trigger_stop_response', (t) => {
  const { cwd, sessionTmp, cleanup } = makeWorktreeStore();
  t.after(cleanup);

  const payload = {
    hook_event_name: 'Stop',
    cwd,
    response: 'added a new component',
    tool_inputs: [],
    tool_results: [],
  };

  const result = runDispatcher(payload, sessionTmp);

  assert.equal(result.status, 0, `dispatcher exited non-zero: stderr=${result.stderr}`);
  assert.equal(
    result.stdout,
    '',
    `expected empty stdout for non-matching Stop response; got: ${JSON.stringify(result.stdout)}`
  );
});

test('Stop dispatcher does not match against tool_inputs or tool_results (surface excluded)', (t) => {
  const { cwd, sessionTmp, cleanup } = makeWorktreeStore();
  t.after(cleanup);

  // The trigger pattern appears only inside tool_inputs / tool_results,
  // never in `response`. Per R4 the match surface excludes tool fields,
  // so the dispatcher must emit nothing.
  const payload = {
    hook_event_name: 'Stop',
    cwd,
    response: 'added a new component',
    tool_inputs: [{ name: 'Bash', input: { command: 'bump timeout && retry' } }],
    tool_results: [{ output: 'flaky test detected' }],
  };

  const result = runDispatcher(payload, sessionTmp);

  assert.equal(result.status, 0, `dispatcher exited non-zero: stderr=${result.stderr}`);
  assert.equal(
    result.stdout,
    '',
    `expected empty stdout when match-pattern only appears in tool fields; got: ${JSON.stringify(result.stdout)}`
  );
});
