'use strict';

/**
 * Tests for `plugins/synapsys/scripts/synapsys-explain.js` PostToolUse routing
 * (GH-473, Task 9).
 *
 * Covers the gherkin scenario "synapsys-explain surfaces the matched exit
 * signal for a PostToolUse fire": running explain with `--event=PostToolUse`
 * (verbose) against a `trigger_pretool` + `trigger_posttool_exit` memory marks
 * the memory fired and renders the matched `posttool_exit` label, and a content
 * case renders the matched `posttool_content_substring` label.
 *
 * Each test builds a temporary fixture store, feeds the CLI a raw PostToolUse
 * hook payload via `--stdin` (so the `tool_response`/exit-code surface is
 * present, which the flag-built payload omits), and asserts on stdout/exit code.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EXPLAIN = path.resolve(__dirname, '..', '..', 'scripts', 'synapsys-explain.js');

function writeMemory(storeDir, name, frontmatter, body = '') {
  const lines = ['---', `name: ${name}`];
  for (const [k, v] of Object.entries(frontmatter)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push('---', '', body, '');
  fs.writeFileSync(path.join(storeDir, `${name}.md`), lines.join('\n'));
}

function makeFixtureStore(memories) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-explain-posttool-'));
  const storeDir = path.join(cwd, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ projectName: 'synapsys-explain-posttool-fixture' })
  );
  for (const mem of memories) {
    writeMemory(storeDir, mem.name, mem.frontmatter, mem.body || '');
  }
  return { cwd, storeDir, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

function runExplain(args, opts = {}) {
  return spawnSync(process.execPath, [EXPLAIN, ...args], {
    encoding: 'utf8',
    input: opts.input,
    env: {
      ...process.env,
      SYNAPSYS_NO_SETUP_HINT: '1',
      SYNAPSYS_DISABLE_HOME_STORES: '1',
    },
  });
}

// Exit-signal case: trigger_pretool + trigger_posttool_exit:"nonzero" memory,
// payload with tool_response.exit_code:1 → fired + matched.posttool_exit label.
test('PostToolUse verbose: failing-test memory fires and shows matched posttool_exit', (t) => {
  const memories = [
    {
      name: 'failing-test-reminder',
      frontmatter: {
        description: 'Remind on failing tests',
        events: 'PostToolUse',
        trigger_pretool: 'Bash:.*test.*',
        trigger_posttool_exit: 'nonzero',
      },
      body: 'A test just failed — investigate before continuing.',
    },
  ];
  const { cwd, cleanup } = makeFixtureStore(memories);
  t.after(cleanup);

  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'pnpm test' },
    tool_response: { stdout: '1 failing', stderr: '', exit_code: 1 },
    cwd,
  });

  const result = runExplain(['--stdin', '--verbose', `--cwd=${cwd}`], { input: payload });

  assert.equal(result.status, 0, `exit non-zero. stderr=${result.stderr}`);
  assert.match(
    result.stdout,
    /fired: ✓/,
    `expected memory to fire. stdout=${result.stdout}`
  );
  assert.match(
    result.stdout,
    /matched\.posttool_exit:\s*nonzero/,
    `expected matched.posttool_exit line. stdout=${result.stdout}`
  );
  assert.match(result.stdout, /1\/1 memories fired\./);
});

// Content case: trigger_pretool + trigger_posttool_content memory, payload with
// matching tool_response output → fired + matched.posttool_content_substring.
test('PostToolUse verbose: network-error memory shows matched posttool_content_substring', (t) => {
  const memories = [
    {
      name: 'network-error-reminder',
      frontmatter: {
        description: 'Remind on network errors',
        events: 'PostToolUse',
        trigger_pretool: 'Bash:.*',
        trigger_posttool_content: 'ENOTFOUND',
      },
      body: 'Network lookup failed — check connectivity.',
    },
  ];
  const { cwd, cleanup } = makeFixtureStore(memories);
  t.after(cleanup);

  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'pnpm install' },
    tool_response: { stdout: 'getaddrinfo ENOTFOUND registry.npmjs.org', stderr: '' },
    cwd,
  });

  const result = runExplain(['--stdin', '--verbose', `--cwd=${cwd}`], { input: payload });

  assert.equal(result.status, 0, `exit non-zero. stderr=${result.stderr}`);
  assert.match(
    result.stdout,
    /fired: ✓/,
    `expected memory to fire. stdout=${result.stdout}`
  );
  assert.match(
    result.stdout,
    /matched\.posttool_content_substring:.*ENOTFOUND/,
    `expected matched.posttool_content_substring line. stdout=${result.stdout}`
  );
});

// --event=PostToolUse must be accepted (not rejected as unknown --event).
test('PostToolUse is an accepted --event (not rejected as unknown)', (t) => {
  const memories = [
    {
      name: 'failing-test-reminder',
      frontmatter: {
        description: 'Remind on failing tests',
        events: 'PostToolUse',
        trigger_pretool: 'Bash:.*',
        trigger_posttool_exit: 'nonzero',
      },
      body: 'A test just failed.',
    },
  ];
  const { cwd, cleanup } = makeFixtureStore(memories);
  t.after(cleanup);

  const result = runExplain(['--event=PostToolUse', '--tool=Bash', `--cwd=${cwd}`]);

  assert.equal(
    result.status,
    0,
    `expected exit 0, got ${result.status}. stderr=${result.stderr}`
  );
  assert.doesNotMatch(result.stderr, /unknown --event/i);
});
