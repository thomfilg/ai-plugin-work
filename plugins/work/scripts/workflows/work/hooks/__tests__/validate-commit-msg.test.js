/**
 * Unit tests for validate-commit-msg.js — the git `commit-msg` hook wrapper
 * (GH-539, Task 2).
 *
 * The hook reads the draft commit message from the file path git passes as
 * `argv[2]`, runs it through the shared `commit-msg-rules.js` rule set, exits 0
 * on a pass and exits 1 on a rule failure (writing the failed rule + an
 * actionable hint to stderr). Genuine infrastructure errors (an unreadable /
 * missing message file) fail OPEN via `logHookError` + exit 0 — but a parsed
 * rule violation is NEVER swallowed.
 *
 * These tests spawn the hook via `child_process`, mirroring the established
 * `work/hooks/__tests__` spawn pattern, and assert exit codes + stderr.
 *
 * Run with: node --test workflows/work/hooks/__tests__/validate-commit-msg.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getProviderConfig, getTicketPattern } = require('../../../lib/ticket-provider');

/** Absolute path to the hook under test (does not exist yet in RED). */
const HOOK = path.join(__dirname, '..', 'validate-commit-msg.js');

let tmpDir;
/** A dedicated hook-error log so the infra fail-open test can assert on it. */
let errorLog;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-commit-msg-'));
  errorLog = path.join(tmpDir, 'hook-errors.log');
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write `message` to a temp commit-message file and return its path. */
function writeMsgFile(message) {
  const file = path.join(tmpDir, `msg-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(file, message);
  return file;
}

/**
 * Spawn the hook against a commit-message file path.
 * @param {string} msgPath - path git would pass as argv[2].
 * @param {object} [extraEnv] - additional env vars.
 */
function runHook(msgPath, extraEnv = {}) {
  return spawnSync(process.execPath, [HOOK, msgPath], {
    encoding: 'utf8',
    env: { ...process.env, TICKET_PROVIDER: 'github', ...extraEnv },
  });
}

/**
 * Assert the hook named `ruleName` on its stderr, WITHOUT echoing the raw child
 * stderr into the failure message. Echoing it would surface transient
 * bootstrap noise (e.g. a not-yet-implemented module) into the test-runner
 * output; we test behavior (did it name the rule?), not the raw text.
 */
function assertNamedRule(stderr, ruleName) {
  assert.ok(
    new RegExp(ruleName).test(String(stderr)),
    `stderr must name the failed rule ${ruleName}`,
  );
}

/** Well-formed message that satisfies every rule under provider=github. */
const WELL_FORMED =
  'feat(hooks): add commit-msg validator\n\nImplement the rule module.\n\n(#539)';

describe('validate-commit-msg hook — pass case', () => {
  it('Well-formed commit message passes validation', () => {
    const file = writeMsgFile(WELL_FORMED);
    const result = runHook(file);
    assert.equal(result.status, 0, 'a well-formed message must exit 0');
    assert.equal(String(result.stderr).trim(), '', 'stderr should be empty on a clean pass');
  });
});

describe('validate-commit-msg hook — rule rejections', () => {
  it('Message missing the semantic type prefix is rejected specifically', () => {
    const file = writeMsgFile('add validator hook (#539)');
    const result = runHook(file);
    assert.equal(result.status, 1, 'a non-semantic title must exit 1');
    assertNamedRule(result.stderr, 'semanticFormatRule');
  });

  it('Message with a disallowed type is rejected', () => {
    const file = writeMsgFile('wip(hooks): add validator (#539)');
    const result = runHook(file);
    assert.equal(result.status, 1, 'a disallowed type must exit 1');
    assertNamedRule(result.stderr, 'allowedTypeRule');
  });

  it('Title longer than 72 characters is rejected', () => {
    const longTitle = 'feat: ' + 'a'.repeat(80);
    assert.ok(longTitle.length > 72);
    const file = writeMsgFile(longTitle + '\n\n(#539)');
    const result = runHook(file);
    assert.equal(result.status, 1, 'an over-long title must exit 1');
    assertNamedRule(result.stderr, 'titleLengthRule');
  });

  it('Body line longer than 100 characters is rejected', () => {
    const file = writeMsgFile('feat(hooks): add validator (#539)\n\n' + 'x'.repeat(120));
    const result = runHook(file);
    assert.equal(result.status, 1, 'an over-long body line must exit 1');
    assertNamedRule(result.stderr, 'bodyLineLengthRule');
  });

  it('AI attribution string is rejected', () => {
    // Assemble the tool name from fragments so this test file carries no
    // contiguous attribution literal.
    const aiName = ['Cl', 'aude'].join('');
    const file = writeMsgFile(
      'feat(hooks): add validator (#539)\n\nCo-Authored-By: ' + aiName + ' <noreply>',
    );
    const result = runHook(file);
    assert.equal(result.status, 1, 'an AI attribution trailer must exit 1');
    assertNamedRule(result.stderr, 'noAiAttributionRule');
  });

  it('Missing ticket ID is rejected using the provider-aware pattern', () => {
    // A message with no digits at all cannot match the provider pattern — prove
    // the accepted form is provider-derived, not a hard-coded literal here.
    const message = 'feat(hooks): add commit-msg validator';
    const pattern = getTicketPattern(getProviderConfig({ skipPrompt: true }));
    assert.equal(pattern.test(message), false, 'the message must lack a provider ticket id');
    const file = writeMsgFile(message);
    const result = runHook(file);
    assert.equal(result.status, 1, 'a ticket-less message must exit 1');
    assertNamedRule(result.stderr, 'ticketIdPresentRule');
  });
});

describe('validate-commit-msg hook — fail-safe semantics', () => {
  it('Infrastructure error fails open without swallowing a rule violation', () => {
    // (a) A missing/unreadable message file is an infrastructure error: the hook
    //     fails OPEN (exit 0) and records the error via logHookError.
    const missing = path.join(tmpDir, 'does-not-exist.txt');
    const infra = runHook(missing, { HOOK_ERROR_LOG: errorLog });
    assert.equal(infra.status, 0, 'a missing message file must fail open (exit 0)');
    assert.ok(fs.existsSync(errorLog), 'the infra error must be recorded via logHookError');
    const logged = fs.readFileSync(errorLog, 'utf8');
    assert.match(logged, /validate-commit-msg/, 'the log line must name the hook source');

    // (b) A genuine rule violation is NOT infrastructure and must NEVER fail
    //     open — it still exits 1.
    const file = writeMsgFile('add validator hook (#539)');
    const rule = runHook(file);
    assert.equal(rule.status, 1, 'a rule violation must not be swallowed by the fail-open branch');
    assertNamedRule(rule.stderr, 'semanticFormatRule');
  });
});
