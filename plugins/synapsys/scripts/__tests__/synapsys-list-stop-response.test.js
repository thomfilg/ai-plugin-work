'use strict';

/**
 * P0 #5 — synapsys-list surfaces trigger_stop_response in verbose listings.
 *
 * Spawns `node synapsys-list.js --verbose --no-color --cwd=<temp>` against a
 * temp store containing one memory carrying `trigger_stop_response: "bump\s+timeout"`
 * and asserts the verbose output prints a `stop-response:` line with the regex.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'synapsys-list.js');

function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-list-stopresp-'));
  const storeDir = path.join(dir, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ projectName: 'test' })
  );
  return { cwd: dir, storeDir };
}

function writeMemory(storeDir, name, frontmatter) {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const content = `---\n${fm}\n---\nbody\n`;
  fs.writeFileSync(path.join(storeDir, name), content);
}

function runList(cwd) {
  const res = spawnSync(
    process.execPath,
    [SCRIPT, '--verbose', '--no-color', `--cwd=${cwd}`],
    { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } }
  );
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
}

test('verbose listing prints stop-response: line with the regex when memory carries trigger_stop_response', () => {
  const { cwd, storeDir } = makeTempStore();
  writeMemory(storeDir, 'flaky-test-fix-protocol.md', {
    name: 'flaky-test-fix-protocol',
    description: 'Detect flaky-test bump-timeout protocol',
    events: 'Stop',
    trigger_stop_response: '"bump\\s+timeout"',
  });

  const { stdout, status } = runList(cwd);
  assert.equal(status, 0, `expected exit 0, got ${status}`);
  assert.match(
    stdout,
    /stop-response:\s*.*bump\\s\+timeout/,
    `expected stdout to contain "stop-response:" followed by bump\\s+timeout regex.\n--- STDOUT ---\n${stdout}`
  );
});

test('verbose listing omits stop-response: line when memory has no trigger_stop_response', () => {
  const { cwd, storeDir } = makeTempStore();
  writeMemory(storeDir, 'no-stop.md', {
    name: 'no-stop',
    description: 'plain memory without stop trigger',
    events: 'UserPromptSubmit',
    trigger_prompt: '"hello"',
  });

  const { stdout, status } = runList(cwd);
  assert.equal(status, 0, `expected exit 0, got ${status}`);
  assert.doesNotMatch(
    stdout,
    /stop-response:/,
    `expected stdout NOT to contain "stop-response:".\n--- STDOUT ---\n${stdout}`
  );
});
