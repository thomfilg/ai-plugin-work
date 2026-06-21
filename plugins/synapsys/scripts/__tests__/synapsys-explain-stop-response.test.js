'use strict';

/**
 * synapsys-explain — debug CLI must not lie about Stop+trigger_stop_response
 * memories. Before this fix, evaluateMemory called matcher.matchStop(memory)
 * with no payload, which made _extractStopResponse return '' and the regex
 * miss, producing a misleading `fired: ✗ no-stop-response-match` row.
 *
 * Covers gap from PR #575 review:
 *   - default invocation (no --response) reports an informational "would fire"
 *     state instead of claiming the memory will never fire.
 *   - --response=<matching text> reports the memory as fired.
 *   - --response=<non-matching text> reports `no-stop-response-match`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'synapsys-explain.js');
const MEMORY_NAME = 'flaky-test-fix-protocol';
const STOP_REGEX = 'bump\\s+timeout';

function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-explain-stopresp-'));
  const storeDir = path.join(dir, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ kind: 'worktree', projectName: 'test', schemaVersion: 1 })
  );
  const frontmatter = [
    '---',
    `name: ${MEMORY_NAME}`,
    'description: Steps to take when a test goes flaky.',
    'events: Stop',
    `trigger_stop_response: ${STOP_REGEX}`,
    'inject: full',
    '---',
    '',
    'body',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(storeDir, `${MEMORY_NAME}.md`), frontmatter);
  return { cwd: dir };
}

function runExplain(cwd, extraArgs = []) {
  const res = spawnSync(process.execPath, [SCRIPT, '--event=Stop', `--cwd=${cwd}`, ...extraArgs], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
      SYNAPSYS_DISABLE_HOME_STORES: '1',
    },
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
}

test('synapsys-explain Stop+trigger_stop_response without --response does not lie about fired:false', () => {
  const { cwd } = makeTempStore();
  const { stdout, status } = runExplain(cwd);
  assert.equal(status, 0, `expected exit 0, got ${status}; stdout=${stdout}`);

  // Must NOT report the negative `no-stop-response-match` reason that the
  // pre-fix matcher.matchStop(memory) regression produced.
  assert.doesNotMatch(
    stdout,
    /no-stop-response-match/,
    `output should not claim the memory will never fire.\n--- STDOUT ---\n${stdout}`
  );

  // Must surface the informational "would fire" hint (table truncates the
  // reason column; the full phrase shows up in --verbose mode, asserted
  // separately below).
  assert.match(
    stdout,
    /would fire if response/,
    `expected informational "would fire if response" hint.\n--- STDOUT ---\n${stdout}`
  );

  // The ? marker is the table's "needs input to evaluate" state.
  assert.match(
    stdout,
    new RegExp(`${MEMORY_NAME}\\s+\\|\\s+\\?`),
    `expected ${MEMORY_NAME} row to render with "?" pending-input marker.\n--- STDOUT ---\n${stdout}`
  );
});

test('synapsys-explain Stop with --response matching trigger_stop_response reports fired ✓', () => {
  const { cwd } = makeTempStore();
  const { stdout, status } = runExplain(cwd, ['--response=please bump timeout for now']);
  assert.equal(status, 0, `expected exit 0, got ${status}; stdout=${stdout}`);

  assert.match(
    stdout,
    new RegExp(`${MEMORY_NAME}\\s+\\|\\s+✓`),
    `expected ${MEMORY_NAME} row to mark fired ✓.\n--- STDOUT ---\n${stdout}`
  );
  assert.match(stdout, /1\/1 memories fired\./, `expected "1/1 memories fired." footer`);
});

test('synapsys-explain Stop with --response not matching trigger_stop_response reports no-stop-response-match', () => {
  const { cwd } = makeTempStore();
  const { stdout, status } = runExplain(cwd, ['--response=ran the tests and they passed']);
  assert.equal(status, 0, `expected exit 0, got ${status}; stdout=${stdout}`);

  assert.match(
    stdout,
    new RegExp(`${MEMORY_NAME}\\s+\\|\\s+✗\\s+\\|\\s+no-stop-response-match`),
    `expected ${MEMORY_NAME} row to mark ✗ with no-stop-response-match reason.\n--- STDOUT ---\n${stdout}`
  );
});

test('synapsys-explain --verbose surfaces the would_fire_if hint when --response is omitted', () => {
  const { cwd } = makeTempStore();
  const { stdout, status } = runExplain(cwd, ['--verbose']);
  assert.equal(status, 0, `expected exit 0, got ${status}; stdout=${stdout}`);

  assert.match(
    stdout,
    /fired:\s+\?\s+\(needs --response/,
    `expected "fired: ?" needs-response label`
  );
  assert.match(
    stdout,
    /would_fire_if:\s+response matches \/bump/,
    `expected would_fire_if line with regex pattern.\n--- STDOUT ---\n${stdout}`
  );
});

test('synapsys-explain Stop with NO trigger_stop_response still fires unconditionally', () => {
  // Backward-compat: memories without trigger_stop_response should still
  // report fired ✓ for any Stop event invocation, regardless of --response.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-explain-stopresp-uncond-'));
  const storeDir = path.join(dir, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ kind: 'worktree', projectName: 'test', schemaVersion: 1 })
  );
  const frontmatter = [
    '---',
    'name: unconditional-stop-memory',
    'description: Always fires on Stop',
    'events: Stop',
    'inject: full',
    '---',
    '',
    'body',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(storeDir, 'unconditional-stop-memory.md'), frontmatter);

  const res = spawnSync(process.execPath, [SCRIPT, '--event=Stop', `--cwd=${dir}`], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
      SYNAPSYS_DISABLE_HOME_STORES: '1',
    },
  });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /unconditional-stop-memory\s+\|\s+✓/);
});
