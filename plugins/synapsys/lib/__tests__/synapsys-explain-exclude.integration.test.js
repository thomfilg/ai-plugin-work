'use strict';

/**
 * Integration tests for `plugins/synapsys/scripts/synapsys-explain.js`
 * exclude-matched rendering (GH-510, Task 4).
 *
 * Asserts that `synapsys:explain` over a memory whose `exclude_prompt`
 * suppresses a positive `trigger_prompt` match prints:
 *   - reason `exclude-matched` (table + verbose)
 *   - `matched.excluded_pattern: <regex>` line (verbose)
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
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-explain-exclude-'));
  const storeDir = path.join(cwd, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ projectName: 'synapsys-explain-exclude-fixture' })
  );
  for (const mem of memories) {
    writeMemory(storeDir, mem.name, mem.frontmatter, mem.body || '');
  }
  return { cwd, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

function runExplain(args, opts = {}) {
  return spawnSync(process.execPath, [EXPLAIN, ...args], {
    encoding: 'utf8',
    input: opts.input,
    env: { ...process.env, SYNAPSYS_NO_SETUP_HINT: '1' },
  });
}

test('Task 4: --verbose surfaces exclude-matched reason and matched.excluded_pattern', (t) => {
  const memories = [
    {
      name: 'jira-ops-exclude-demo',
      frontmatter: {
        description: 'Demo memory with exclude_prompt suppression',
        events: 'UserPromptSubmit',
        trigger_prompt: 'create jira ticket',
        exclude_prompt: 'dry-run',
      },
      body: 'Use the jira task creator.',
    },
  ];
  const { cwd, cleanup } = makeFixtureStore(memories);
  t.after(cleanup);

  const result = runExplain([
    '--verbose',
    '--event=UserPromptSubmit',
    '--prompt=create jira ticket dry-run',
    `--cwd=${cwd}`,
  ]);

  assert.equal(result.status, 0, `exit non-zero. stderr=${result.stderr}`);
  assert.match(
    result.stdout,
    /exclude-matched/,
    `expected exclude-matched reason in verbose output. stdout=${result.stdout}`
  );
  assert.match(
    result.stdout,
    /matched\.excluded_pattern:\s*dry-run/,
    `expected matched.excluded_pattern line. stdout=${result.stdout}`
  );
});

test('Task 4: --verbose surfaces exclude-matched label via MATCHED_LABELS', (t) => {
  const memories = [
    {
      name: 'jira-ops-exclude-demo-2',
      frontmatter: {
        description: 'Demo memory with exclude_prompt suppression',
        events: 'UserPromptSubmit',
        trigger_prompt: 'create jira ticket',
        exclude_prompt: 'dry-run',
      },
      body: 'Use the jira task creator.',
    },
  ];
  const { cwd, cleanup } = makeFixtureStore(memories);
  t.after(cleanup);

  const result = runExplain([
    '--verbose',
    '--event=UserPromptSubmit',
    '--prompt=create jira ticket dry-run',
    `--cwd=${cwd}`,
  ]);

  assert.equal(result.status, 0, `exit non-zero. stderr=${result.stderr}`);
  // The labels block (mirrors negative-excludes) should render the excluded_pattern key.
  assert.match(
    result.stdout,
    /excluded_pattern/,
    `expected excluded_pattern label in verbose output. stdout=${result.stdout}`
  );
});

test('Task 4: table mode shows exclude-matched reason in row', (t) => {
  const memories = [
    {
      name: 'jira-ops-exclude-demo',
      frontmatter: {
        description: 'Demo memory with exclude_prompt suppression',
        events: 'UserPromptSubmit',
        trigger_prompt: 'create jira ticket',
        exclude_prompt: 'dry-run',
      },
      body: 'Use the jira task creator.',
    },
  ];
  const { cwd, cleanup } = makeFixtureStore(memories);
  t.after(cleanup);

  const result = runExplain([
    '--event=UserPromptSubmit',
    '--prompt=create jira ticket dry-run',
    `--cwd=${cwd}`,
  ]);

  assert.equal(result.status, 0, `exit non-zero. stderr=${result.stderr}`);
  const row = result.stdout
    .split('\n')
    .find((l) => l.includes('jira-ops-exclude-demo'));
  assert.ok(row, `expected row for jira-ops-exclude-demo. stdout=${result.stdout}`);
  assert.match(row, /exclude-matched/, `expected exclude-matched in row: ${row}`);
  assert.match(row, /✗/, `expected fired ✗ in row: ${row}`);
});
