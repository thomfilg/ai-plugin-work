'use strict';

/**
 * Tests for `plugins/synapsys/scripts/synapsys-explain.js` (GH-443, Task 3).
 *
 * Covers Gherkin scenarios G1, G2, G3, G4, G5, G6, G7, G9 — the per-memory
 * trigger debugger CLI. Each test builds a temporary fixture store with
 * `fs.mkdtempSync`, spawns the CLI synchronously, and asserts on stdout/stderr
 * and the exit code.
 *
 * Requirements: R1, R4, R5, R6, R7, R8, R9 (subset), R16.
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
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-explain-'));
  const storeDir = path.join(cwd, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ projectName: 'synapsys-explain-fixture' })
  );
  for (const mem of memories) {
    writeMemory(storeDir, mem.name, mem.frontmatter, mem.body || '');
  }
  return { cwd, storeDir, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

function defaultFourMemoryFixture() {
  return [
    {
      name: 'jira-ops-use-task-creator',
      frontmatter: {
        description: 'Use jira task creator',
        events: 'UserPromptSubmit',
        trigger_prompt: '(create jira ticket|jira ticket)',
      },
      body: 'Always use the jira task creator.',
    },
    {
      name: 'other-prompt-memory',
      frontmatter: {
        description: 'A different prompt memory',
        events: 'UserPromptSubmit',
        trigger_prompt: 'totally-unrelated-token',
      },
      body: 'Unrelated body.',
    },
    {
      name: 'agent-must-use-ask-question-when-blocked',
      frontmatter: {
        description: 'PreToolUse only memory',
        events: 'PreToolUse',
        trigger_pretool: 'Bash:.*',
      },
      body: 'Ask question when blocked.',
    },
    {
      name: 'session-start-memory',
      frontmatter: {
        description: 'SessionStart memory',
        events: 'SessionStart',
        trigger_session: 'true',
      },
      body: 'Session start body.',
    },
  ];
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

// G1 — UserPromptSubmit prompt matches one memory in fixture store
test('G1: UserPromptSubmit prompt matches one memory in fixture store', (t) => {
  const { cwd, cleanup } = makeFixtureStore(defaultFourMemoryFixture());
  t.after(cleanup);

  const result = runExplain([
    '--event=UserPromptSubmit',
    '--prompt=create jira ticket for X',
    `--cwd=${cwd}`,
  ]);

  assert.equal(result.status, 0, `exit non-zero. stderr=${result.stderr}`);
  assert.match(result.stdout, /jira-ops-use-task-creator/);
  assert.match(result.stdout, /1\/4 memories fired\./);
});

// G2 — Memory whose events list excludes the current event reports events-exclude
test('G2: events-exclude reason for memory whose events list excludes current event', (t) => {
  const { cwd, cleanup } = makeFixtureStore(defaultFourMemoryFixture());
  t.after(cleanup);

  const result = runExplain(['--event=UserPromptSubmit', '--prompt=anything', `--cwd=${cwd}`]);

  assert.equal(result.status, 0, `exit non-zero. stderr=${result.stderr}`);
  // The PreToolUse-only memory should appear with events-exclude reason.
  const row = result.stdout
    .split('\n')
    .find((l) => l.includes('agent-must-use-ask-question-when-blocked'));
  assert.ok(
    row,
    `expected row for agent-must-use-ask-question-when-blocked. stdout=${result.stdout}`
  );
  assert.match(row, /events-exclude/);
});

// G3 — PreToolUse Edit with trigger_pretool_content content match fires
test('G3: PreToolUse Edit with trigger_pretool_content content match fires', (t) => {
  const memories = [
    {
      name: 'ui-component-Button',
      frontmatter: {
        description: 'Prefer Button component over raw <button>',
        events: 'PreToolUse',
        trigger_pretool: 'Edit:.*',
        trigger_pretool_content: '<button\\b',
      },
      body: 'Use the shared Button component.',
    },
  ];
  const { cwd, cleanup } = makeFixtureStore(memories);
  t.after(cleanup);

  const result = runExplain([
    '--event=PreToolUse',
    '--tool=Edit',
    '--tool-input={"file_path":"/x.tsx","new_string":"<button>"}',
    `--cwd=${cwd}`,
  ]);

  assert.equal(result.status, 0, `exit non-zero. stderr=${result.stderr}`);
  const row = result.stdout.split('\n').find((l) => l.includes('ui-component-Button'));
  assert.ok(row, `expected row for ui-component-Button. stdout=${result.stdout}`);
  assert.match(row, /✓/, `expected fired ✓ in row: ${row}`);
});

// G4 — PreToolUse Edit whose content does not match reports no-content-match
test('G4: no-content-match reason when content pattern misses', (t) => {
  const memories = [
    {
      name: 'ui-component-Button',
      frontmatter: {
        description: 'Prefer Button component over raw <button>',
        events: 'PreToolUse',
        trigger_pretool: 'Edit:.*',
        trigger_pretool_content: '<button\\b',
      },
      body: 'Use the shared Button component.',
    },
  ];
  const { cwd, cleanup } = makeFixtureStore(memories);
  t.after(cleanup);

  const result = runExplain([
    '--event=PreToolUse',
    '--tool=Edit',
    '--tool-input={"file_path":"/x.tsx","new_string":"<div>plain html</div>"}',
    `--cwd=${cwd}`,
  ]);

  assert.equal(result.status, 0, `exit non-zero. stderr=${result.stderr}`);
  const row = result.stdout.split('\n').find((l) => l.includes('ui-component-Button'));
  assert.ok(row, `expected row for ui-component-Button. stdout=${result.stdout}`);
  assert.match(row, /no-content-match/);
  assert.match(row, /✗/);
});

// G5 — --only filter restricts evaluation to named memories
test('G5: --only filter restricts evaluation to a single memory', (t) => {
  const { cwd, cleanup } = makeFixtureStore(defaultFourMemoryFixture());
  t.after(cleanup);

  const result = runExplain([
    '--only=jira-ops-use-task-creator',
    '--event=UserPromptSubmit',
    '--prompt=anything',
    `--cwd=${cwd}`,
  ]);

  assert.equal(result.status, 0, `exit non-zero. stderr=${result.stderr}`);
  assert.match(result.stdout, /jira-ops-use-task-creator/);
  // No other memory names should appear in the output.
  assert.doesNotMatch(result.stdout, /other-prompt-memory/);
  assert.doesNotMatch(result.stdout, /agent-must-use-ask-question-when-blocked/);
  assert.doesNotMatch(result.stdout, /session-start-memory/);
  // Footer denominator equals 1.
  assert.match(result.stdout, /\/1 memories fired\./);
});

// G6 — --stdin accepts a raw hook event JSON payload
test('G6: --stdin accepts a raw hook event JSON payload', (t) => {
  const { cwd, cleanup } = makeFixtureStore(defaultFourMemoryFixture());
  t.after(cleanup);

  const payload = JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    prompt: 'create jira ticket for Y',
    cwd,
  });

  const result = runExplain(['--stdin', `--cwd=${cwd}`], { input: payload });

  assert.equal(result.status, 0, `exit non-zero. stderr=${result.stderr}`);
  assert.match(result.stdout, /jira-ops-use-task-creator/);
});

// G7 — Invalid stdin JSON exits with code 2
test('G7: invalid stdin JSON exits with code 2', (t) => {
  const { cwd, cleanup } = makeFixtureStore(defaultFourMemoryFixture());
  t.after(cleanup);

  const result = runExplain(['--stdin', `--cwd=${cwd}`], { input: 'not json' });

  assert.equal(
    result.status,
    2,
    `expected exit 2, got ${result.status}. stdout=${result.stdout} stderr=${result.stderr}`
  );
  assert.match(result.stderr, /invalid stdin JSON/i);
});

// G9 — Verbose output for a fired memory exposes the matched alternative and substring
test('G9: --verbose exposes matched alternative + substring for fired memory', (t) => {
  const memories = [
    {
      name: 'feature-flag-memory',
      frontmatter: {
        description: 'Feature flag warning memory',
        events: 'UserPromptSubmit',
        trigger_prompt: 'feature flag|enable.*in.*(prod|uat)',
      },
      body: 'Be careful with feature flags in production.',
    },
  ];
  const { cwd, cleanup } = makeFixtureStore(memories);
  t.after(cleanup);

  const result = runExplain([
    '--verbose',
    '--event=UserPromptSubmit',
    '--prompt=enable preview in prod',
    `--cwd=${cwd}`,
  ]);

  assert.equal(result.status, 0, `exit non-zero. stderr=${result.stderr}`);
  // Memory must actually fire so renderFiredBlock is exercised.
  assert.match(
    result.stdout,
    /fired: ✓/,
    `expected memory to fire so matched.* fields are rendered. stdout=${result.stdout}`
  );
  // (a) source trigger_prompt regex appears in the trigger: line.
  assert.match(
    result.stdout,
    /feature flag\|enable\.\*in\.\*\(prod\|uat\)/,
    `expected source regex in verbose output. stdout=${result.stdout}`
  );
  // (b) matched.prompt_token names the alternative that fired ("enable...").
  assert.match(
    result.stdout,
    /matched\.prompt_token:\s*enable\.\*in\.\*\(prod\|uat\)/,
    `expected matched.prompt_token line. stdout=${result.stdout}`
  );
  // (c) matched.prompt_substring contains the actually-matched substring.
  assert.match(
    result.stdout,
    /matched\.prompt_substring:.*enable preview in prod/,
    `expected matched.prompt_substring line. stdout=${result.stdout}`
  );
});
