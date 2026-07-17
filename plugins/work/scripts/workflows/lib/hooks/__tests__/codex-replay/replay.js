'use strict';

/**
 * codex-replay — replay recorded codex-shaped hook payloads through a real
 * hook script and assert the codex response contract (GH-774).
 *
 * Under codex the host is strict: a JSON-response event whose stdout is not
 * valid, well-formed JSON is REJECTED ("hook returned invalid JSON"), a
 * PostToolUse that runs past ~2s is killed ("timed out after 2s"), and any
 * uncaught throw becomes a non-zero exit the host reports as a hook failure.
 * The corpus + this helper are the regression net: every migrated hook, fed a
 * codex payload with NO CLAUDE_HOOK_TYPE env, must exit 0 (or a legitimate
 * block) and emit schema-valid-or-empty stdout within the latency budget.
 */

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

/** The codex PostToolUse kill budget; a migrated hook must finish well under. */
const LATENCY_BUDGET_MS = 2000;

/** Load one recorded codex payload by fixture stem (e.g. 'stop'). */
function loadFixture(name) {
  const file = path.join(FIXTURES_DIR, `${name}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * A child env that mimics codex: NO CLAUDE_HOOK_TYPE, and the node-test
 * harness vars scrubbed so the spawned hook runs as a plain process.
 */
function codexEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of ['CLAUDE_HOOK_TYPE', 'NODE_TEST_CONTEXT', 'NODE_OPTIONS']) {
    delete env[key];
  }
  return env;
}

/**
 * Replay a payload through a hook script.
 *
 * @param {string} hookPath - Absolute path to the hook entrypoint.
 * @param {object} payload - Recorded codex payload (mutated copy is sent).
 * @param {{env?: object, cwd?: string}} [opts]
 * @returns {{code: number, stdout: string, stderr: string, durationMs: number, timedOut: boolean}}
 */
function replay(hookPath, payload, opts = {}) {
  const start = Date.now();
  const res = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15000,
    cwd: opts.cwd,
    env: codexEnv(opts.env || {}),
  });
  return {
    code: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    durationMs: Date.now() - start,
    timedOut: res.error != null && res.error.code === 'ETIMEDOUT',
  };
}

// Events whose stdout MUST be empty or exactly one valid JSON value (codex
// parses it as the structured hook response / additionalContext envelope).
const JSON_RESPONSE_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'Stop']);

// UserPromptSubmit / SessionStart context rides PLAIN stdout on codex (not a
// JSON envelope). The only hard rule is the codex JSON-sniff: exit-0 stdout
// whose first non-whitespace char is `{`, `[` or `"` is parsed as JSON, and a
// parse failure makes codex DROP the text and mark the hook Failed. So such
// stdout must be empty, non-JSON-looking, or valid JSON.
const PLAIN_CONTEXT_EVENTS = new Set(['UserPromptSubmit', 'SessionStart', 'SubagentStart']);
const JSON_LOOKING_RE = /^\s*["[{]/;

/**
 * Assert a replay result satisfies the codex response contract.
 *
 * @param {object} result - A replay() return value.
 * @param {object} expected
 * @param {string} expected.event - The hook event under test.
 * @param {number[]} [expected.codes] - Allowed exit codes (default [0]).
 *   Pass [2] (or [0,2]) for hooks whose legitimate block exits 2.
 */
function assertContract(result, expected) {
  const codes = expected.codes || [0];
  assert.ok(
    codes.includes(result.code),
    `exit ${result.code} not in allowed ${JSON.stringify(codes)} (stderr: ${result.stderr})`
  );
  assert.ok(
    !result.timedOut && result.durationMs < LATENCY_BUDGET_MS,
    `hook exceeded the ${LATENCY_BUDGET_MS}ms codex budget (${result.durationMs}ms, timedOut=${result.timedOut})`
  );
  assertStdoutSchema(result.stdout, expected.event);
  // A fail-open (exit 0) hook must never dirty stderr — the host reads any
  // stderr byte as a failure. Blocks (exit 2) legitimately use stderr.
  if (result.code === 0) {
    assert.equal(result.stderr, '', `exit-0 hook wrote to stderr: ${result.stderr}`);
  }
}

/** Assert stdout obeys the per-event codex contract (see the sets above). */
function assertStdoutSchema(stdout, event) {
  const trimmed = stdout.trim();
  if (trimmed === '') return;
  if (JSON_RESPONSE_EVENTS.has(event)) {
    assert.doesNotThrow(
      () => JSON.parse(trimmed),
      `stdout on JSON-response event ${event} is not valid JSON: ${JSON.stringify(stdout)}`
    );
    return;
  }
  if (PLAIN_CONTEXT_EVENTS.has(event) && JSON_LOOKING_RE.test(trimmed)) {
    assert.doesNotThrow(
      () => JSON.parse(trimmed),
      `JSON-looking stdout on ${event} would be dropped by the codex sniff: ${JSON.stringify(stdout)}`
    );
  }
}

module.exports = {
  FIXTURES_DIR,
  LATENCY_BUDGET_MS,
  loadFixture,
  codexEnv,
  replay,
  assertContract,
  assertStdoutSchema,
};
