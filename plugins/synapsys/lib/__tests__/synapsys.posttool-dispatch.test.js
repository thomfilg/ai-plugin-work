'use strict';

/**
 * Dispatcher PostToolUse acceptance test (GH-473, Task 5).
 *
 * Contract: `plugins/synapsys/hooks/synapsys.js` gates incoming events through
 * `VALID_EVENTS`; an event not in the set short-circuits with `process.exit(0)`
 * and empty stdout BEFORE memories are ever loaded or matched. Task 5 adds
 * `'PostToolUse'` to that set so PostToolUse memories reach the matcher and
 * inject, while genuinely unknown events stay rejected.
 *
 * Covers:
 *   - Dispatcher ACCEPTS `PostToolUse`: a fixture PostToolUse memory whose
 *     `trigger_pretool` prefix matches the tool fires and its full body is
 *     written to stdout (proves the event was not dropped at the VALID_EVENTS
 *     gate).
 *   - Dispatcher still REJECTS an unknown event: stdout is empty and exit 0
 *     (proves the gate was narrowed to known events only, not removed).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DISPATCHER = path.resolve(__dirname, '..', '..', 'hooks', 'synapsys.js');

const MEMORY_NAME = 'posttool-dispatch-memory';
const MEMORY_DESCRIPTION = 'PostToolUse dispatch acceptance memory.';
const MEMORY_BODY = 'PostToolUse body line one.\nPostToolUse body line two.';

const EXPECTED_STDOUT =
  `[synapsys:local] ${MEMORY_NAME} — ${MEMORY_DESCRIPTION}\n\n` + MEMORY_BODY;

function makeFixtureStore() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-posttool-dispatch-'));
  const storeDir = path.join(cwd, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ projectName: 'posttool-dispatch-fixture' })
  );

  const memoryFile = path.join(storeDir, `${MEMORY_NAME}.md`);
  const frontmatter = [
    '---',
    `name: ${MEMORY_NAME}`,
    `description: ${MEMORY_DESCRIPTION}`,
    'events: PostToolUse',
    'trigger_pretool: Bash',
    'trigger_session: false',
    'inject: full',
    '---',
    '',
    MEMORY_BODY,
    '',
  ].join('\n');
  fs.writeFileSync(memoryFile, frontmatter);

  return { cwd, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

function runDispatcher(event, cwd, sessionTmp) {
  const payload = {
    hook_event_name: event,
    cwd,
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    tool_response: { stdout: 'hi', exit_code: 0 },
  };
  return spawnSync(process.execPath, [DISPATCHER, event], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      SYNAPSYS_NO_SETUP_HINT: '1',
      SYNAPSYS_SESSION_DIR: sessionTmp,
    },
  });
}

test('dispatcher ACCEPTS PostToolUse and injects a matching memory body', (t) => {
  const { cwd, cleanup } = makeFixtureStore();
  const sessionTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-posttool-dispatch-session-'));
  t.after(() => {
    cleanup();
    fs.rmSync(sessionTmp, { recursive: true, force: true });
  });

  const result = runDispatcher('PostToolUse', cwd, sessionTmp);

  assert.equal(result.status, 0, `dispatcher exited non-zero: stderr=${result.stderr}`);
  assert.equal(
    result.stdout,
    EXPECTED_STDOUT,
    'PostToolUse memory was not injected — event likely dropped at VALID_EVENTS gate'
  );
});

test('dispatcher still REJECTS an unknown event with empty stdout', (t) => {
  const { cwd, cleanup } = makeFixtureStore();
  const sessionTmp = fs.mkdtempSync(
    path.join(os.tmpdir(), 'synapsys-posttool-dispatch-unknown-session-')
  );
  t.after(() => {
    cleanup();
    fs.rmSync(sessionTmp, { recursive: true, force: true });
  });

  const result = runDispatcher('NotARealEvent', cwd, sessionTmp);

  assert.equal(result.status, 0, `dispatcher exited non-zero: stderr=${result.stderr}`);
  assert.equal(result.stdout, '', 'unknown event must short-circuit with empty stdout');
});
