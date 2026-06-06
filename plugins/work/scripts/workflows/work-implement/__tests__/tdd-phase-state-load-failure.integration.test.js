/**
 * Integration tests for `record-red` RED-load-failure rejection (GH-532 Task 1).
 *
 * These tests assert that `cmdRecordRed` rejects fake-RED test runs whose
 * non-zero exit was actually caused by a test-file LOAD failure
 * (ReferenceError / SyntaxError / Cannot find module / 0 tests reported)
 * rather than a real assertion failure.
 *
 * Run with: node --test plugins/work/scripts/workflows/work-implement/__tests__/tdd-phase-state-load-failure.integration.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CLI_PATH = path.join(__dirname, '..', 'tdd-phase-state.js');

function createTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-state-loadfail-'));
  fs.mkdirSync(path.join(dir, 'worktrees', 'tasks'), { recursive: true });
  return dir;
}

function createTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-git-loadfail-'));
  const gitOpts = { cwd: dir, stdio: 'pipe' };
  spawnSync('git', ['init', '-q'], gitOpts);
  spawnSync('git', ['config', 'user.email', 'test@test.com'], gitOpts);
  spawnSync('git', ['config', 'user.name', 'Test'], gitOpts);
  fs.writeFileSync(path.join(dir, 'README.md'), 'init');
  spawnSync('git', ['add', '.'], gitOpts);
  spawnSync('git', ['commit', '-q', '-m', 'init'], gitOpts);
  // Stage a fresh test file so the RED `testFiles.length === 0` gate passes.
  fs.writeFileSync(path.join(dir, 'foo.test.js'), '// failing test placeholder\n');
  spawnSync('git', ['add', 'foo.test.js'], gitOpts);
  return dir;
}

/**
 * Create a shell script that prints the given output (split across stdout and
 * stderr) and exits with the given code. The fixture stands in for a
 * `node --test` invocation that crashed at test-file load time.
 */
function createOutputScript(dir, name, { stdout = '', stderr = '', exitCode = 1 } = {}) {
  const scriptPath = path.join(dir, `${name}.sh`);
  const safeOut = stdout.replace(/'/g, "'\\''");
  const safeErr = stderr.replace(/'/g, "'\\''");
  const body =
    `#!/bin/sh\n` +
    (stdout ? `printf '%s\\n' '${safeOut}'\n` : '') +
    (stderr ? `printf '%s\\n' '${safeErr}' >&2\n` : '') +
    `exit ${exitCode}\n`;
  fs.writeFileSync(scriptPath, body, { mode: 0o755 });
  return scriptPath;
}

function runCli(args, homeDir, cwd) {
  try {
    const tasksBase = path.join(homeDir, 'worktrees', 'tasks');
    const argv = Array.isArray(args) ? args : String(args).match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const cleanArgv = argv.map((a) => (a.startsWith('"') && a.endsWith('"') ? a.slice(1, -1) : a));
    const stdout = execFileSync('node', [CLI_PATH, ...cleanArgv], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: homeDir,
        TASKS_BASE: tasksBase,
        WORK_TDD_TOKEN_SKIP: '1',
        WORK_TDD_SKIP_WORKSPACE_CHECK: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.status || 1 };
  }
}

function readState(homeDir, ticketId) {
  const statePath = path.join(homeDir, 'worktrees', 'tasks', ticketId, 'tdd-phase.json');
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

describe('tdd-phase-state record-red — load-failure rejection (GH-532)', () => {
  let homeDir;
  let scriptDir;
  let repo;

  beforeEach(() => {
    homeDir = createTempHome();
    scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-loadfail-scripts-'));
    repo = createTempGitRepo();
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(scriptDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('ReferenceError at test load is rejected as fake RED', () => {
    runCli('init GH-532-RE', homeDir);
    const script = createOutputScript(scriptDir, 'reference-error', {
      stderr:
        'ReferenceError: setupStagedHook is not defined\n' +
        '    at Object.<anonymous> (/tmp/foo.test.js:3:1)\n',
      exitCode: 1,
    });
    const { exitCode, stderr } = runCli(`record-red GH-532-RE --cmd "${script}"`, homeDir, repo);
    assert.strictEqual(exitCode, 1, `expected rejection, got stderr: ${stderr}`);
    assert.ok(
      /ReferenceError/.test(stderr),
      `stderr should name the matched signature ReferenceError, got: ${stderr}`
    );
    assert.ok(
      !/BYPASS:/.test(stderr),
      `rejection diagnostic MUST NOT contain a BYPASS: line, got: ${stderr}`
    );
    const state = readState(homeDir, 'GH-532-RE');
    assert.strictEqual(state.currentPhase, 'red', 'phase must stay red on rejection');
    const cycle = state.cycles.find((c) => c.cycle === state.currentCycle);
    assert.ok(!cycle || !cycle.red, 'no record.red must be persisted on rejection');
  });

  it('SyntaxError at test load is rejected as fake RED', () => {
    runCli('init GH-532-SE', homeDir);
    const script = createOutputScript(scriptDir, 'syntax-error', {
      stderr:
        'SyntaxError: Unexpected token (3:5)\n' +
        '    at wrapSafe (node:internal/modules/cjs/loader)\n',
      exitCode: 1,
    });
    const { exitCode, stderr } = runCli(`record-red GH-532-SE --cmd "${script}"`, homeDir, repo);
    assert.strictEqual(exitCode, 1, `expected rejection, got stderr: ${stderr}`);
    assert.ok(/SyntaxError/.test(stderr), `stderr should name SyntaxError, got: ${stderr}`);
    assert.ok(!/BYPASS:/.test(stderr), 'rejection diagnostic must not include BYPASS');
    const state = readState(homeDir, 'GH-532-SE');
    assert.strictEqual(state.currentPhase, 'red');
    const cycle = state.cycles.find((c) => c.cycle === state.currentCycle);
    assert.ok(!cycle || !cycle.red, 'no record.red persisted');
  });

  it('Missing-module error is rejected as fake RED', () => {
    runCli('init GH-532-MM', homeDir);
    const script = createOutputScript(scriptDir, 'missing-module', {
      stderr:
        "Error: Cannot find module './missing-helper'\n" +
        '    at Function.Module._resolveFilename (node:internal/modules/cjs/loader:1234:15)\n' +
        "  code: 'MODULE_NOT_FOUND'\n",
      exitCode: 1,
    });
    const { exitCode, stderr } = runCli(`record-red GH-532-MM --cmd "${script}"`, homeDir, repo);
    assert.strictEqual(exitCode, 1, `expected rejection, got: ${stderr}`);
    assert.ok(
      /Cannot find module/.test(stderr),
      `stderr should name Cannot find module, got: ${stderr}`
    );
    assert.ok(!/BYPASS:/.test(stderr));
    const state = readState(homeDir, 'GH-532-MM');
    assert.strictEqual(state.currentPhase, 'red');
    const cycle = state.cycles.find((c) => c.cycle === state.currentCycle);
    assert.ok(!cycle || !cycle.red);
  });

  it('Runner reporting zero tests is rejected as fake RED', () => {
    runCli('init GH-532-ZT', homeDir);
    // node:test TAP summary on a file with no `it(...)` calls.
    const tap =
      'TAP version 13\n' + '1..0\n' + '# tests 0\n' + '# suites 0\n' + '# pass 0\n' + '# fail 0\n';
    const script = createOutputScript(scriptDir, 'zero-tests', {
      stdout: tap,
      exitCode: 1,
    });
    const { exitCode, stderr } = runCli(`record-red GH-532-ZT --cmd "${script}"`, homeDir, repo);
    assert.strictEqual(exitCode, 1, `expected rejection, got: ${stderr}`);
    assert.ok(/0 tests?/.test(stderr), `stderr should name 0 tests, got: ${stderr}`);
    assert.ok(!/BYPASS:/.test(stderr));
    const state = readState(homeDir, 'GH-532-ZT');
    assert.strictEqual(state.currentPhase, 'red');
    const cycle = state.cycles.find((c) => c.cycle === state.currentCycle);
    assert.ok(!cycle || !cycle.red);
  });

  it('Real assertion failure is accepted as valid RED (no regression)', () => {
    runCli('init GH-532-OK', homeDir);
    const script = createOutputScript(scriptDir, 'assertion-fail', {
      stdout:
        'TAP version 13\n' +
        '# Subtest: feature works\n' +
        'not ok 1 - feature works\n' +
        '  ---\n' +
        '  duration_ms: 1.234\n' +
        '  failureType: testCodeFailure\n' +
        '  error: |-\n' +
        '    AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n' +
        '    + actual - expected\n' +
        '    + 1\n' +
        '    - 2\n' +
        '  ...\n' +
        '# tests 1\n' +
        '# pass 0\n' +
        '# fail 1\n',
      exitCode: 1,
    });
    const { exitCode, stdout, stderr } = runCli(
      `record-red GH-532-OK --cmd "${script}"`,
      homeDir,
      repo
    );
    assert.strictEqual(exitCode, 0, `expected acceptance, got exit=${exitCode}, stderr: ${stderr}`);
    const result = JSON.parse(stdout);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.phase, 'red');
    const state = readState(homeDir, 'GH-532-OK');
    const cycle = state.cycles.find((c) => c.cycle === state.currentCycle);
    assert.ok(cycle && cycle.red, 'record.red must be persisted for real RED');
    assert.strictEqual(cycle.red.testExitCode, 1);
  });

  it('Rejection appends a structured audit row', () => {
    // GH-532 Task 2 / R7 / AC10 — on RED load-failure rejection, the recorder
    // MUST append exactly one row to `.work-actions.json` via
    // `appendEnforcementAudit` capturing the matched signature, the test
    // command, the cycle, and a short snippet of the offending output.
    runCli('init GH-532-AUD', homeDir);
    const script = createOutputScript(scriptDir, 'audit-reference-error', {
      stderr:
        'ReferenceError: setupStagedHook is not defined\n' +
        '    at Object.<anonymous> (/tmp/foo.test.js:3:1)\n',
      exitCode: 1,
    });
    const cmdQuoted = `"${script}"`;
    const { exitCode } = runCli(`record-red GH-532-AUD --cmd ${cmdQuoted}`, homeDir, repo);
    assert.strictEqual(exitCode, 1, 'expected rejection exit code 1');

    const actionsPath = path.join(
      homeDir,
      'worktrees',
      'tasks',
      'GH-532-AUD',
      '.work-actions.json'
    );
    assert.ok(fs.existsSync(actionsPath), `expected .work-actions.json at ${actionsPath}`);
    const actions = JSON.parse(fs.readFileSync(actionsPath, 'utf8'));
    const rejectionRows = actions.filter((a) => a.action === 'tdd-red-load-failure-rejected');
    assert.strictEqual(
      rejectionRows.length,
      1,
      `expected exactly one tdd-red-load-failure-rejected row, got ${rejectionRows.length}`
    );
    const row = rejectionRows[0];
    assert.strictEqual(row.allow, false, 'audit row must have allow: false');
    assert.strictEqual(row.phase, 'red', 'audit row phase must be red');
    assert.strictEqual(row.origin, 'ai-subtask', 'audit row origin must be ai-subtask');
    assert.ok(row.meta, 'audit row must have a meta object');
    assert.strictEqual(
      row.meta.signature,
      'ReferenceError',
      `meta.signature should be ReferenceError, got: ${row.meta.signature}`
    );
    assert.ok(
      typeof row.meta.testCommand === 'string' && row.meta.testCommand.includes(script),
      `meta.testCommand should include the script path, got: ${row.meta.testCommand}`
    );
    assert.ok(
      row.meta.cycle !== undefined && row.meta.cycle !== null,
      'meta.cycle must be present'
    );
    assert.ok(
      typeof row.meta.snippet === 'string' && row.meta.snippet.length > 0,
      `meta.snippet must be a non-empty string, got: ${JSON.stringify(row.meta.snippet)}`
    );
    assert.ok(
      /ReferenceError/.test(row.meta.snippet),
      `meta.snippet should excerpt the matched line, got: ${row.meta.snippet}`
    );

    // Phase still stays red and no evidence persisted.
    const state = readState(homeDir, 'GH-532-AUD');
    assert.strictEqual(state.currentPhase, 'red');
    const cycle = state.cycles.find((c) => c.cycle === state.currentCycle);
    assert.ok(!cycle || !cycle.red, 'no record.red persisted on rejection');
  });

  it('ReferenceError thrown inside assert.throws is NOT rejected', () => {
    runCli('init GH-532-DET', homeDir);
    // Top-level output reports a normal failing test; the `details:` block
    // for that test mentions `ReferenceError` because the test body did
    // `assert.throws(() => { undefinedVar; }, ReferenceError)`. The
    // top-level runner output does NOT begin a line with `ReferenceError:`.
    const tap =
      'TAP version 13\n' +
      '# Subtest: throws ReferenceError as expected\n' +
      'not ok 1 - throws ReferenceError as expected\n' +
      '  ---\n' +
      '  duration_ms: 0.5\n' +
      '  failureType: testCodeFailure\n' +
      '  error: |-\n' +
      '    AssertionError [ERR_ASSERTION]: Expected fn to throw\n' +
      '  details:\n' +
      "    expected: 'ReferenceError'\n" +
      '    actual: undefined\n' +
      '  ...\n' +
      '# tests 1\n' +
      '# pass 0\n' +
      '# fail 1\n';
    const script = createOutputScript(scriptDir, 'details-block', {
      stdout: tap,
      exitCode: 1,
    });
    const { exitCode, stdout, stderr } = runCli(
      `record-red GH-532-DET --cmd "${script}"`,
      homeDir,
      repo
    );
    assert.strictEqual(
      exitCode,
      0,
      `details-block ReferenceError must not trigger rejection, got stderr: ${stderr}`
    );
    const result = JSON.parse(stdout);
    assert.strictEqual(result.ok, true);
    const state = readState(homeDir, 'GH-532-DET');
    const cycle = state.cycles.find((c) => c.cycle === state.currentCycle);
    assert.ok(cycle && cycle.red, 'record.red must be persisted (R5 / AC9)');
  });

  it('TAP "not ok" line whose test name contains "0 tests" is accepted as valid RED', () => {
    // Cursor Bugbot (PR #550): the legacy `0 tests` regex `\b0\s+tests?\b`
    // matched anywhere on a line and false-positived on legitimate node:test
    // `not ok` lines whose test name contains the phrase "0 tests".
    // The regex must only match the node:test TAP summary line shape
    // (`# tests 0` anchored at column 0).
    runCli('init GH-532-NOK', homeDir);
    const tap =
      'TAP version 13\n' +
      '# Subtest: returns 0 tests when input is empty\n' +
      'not ok 1 - returns 0 tests when input is empty\n' +
      '  ---\n' +
      '  duration_ms: 0.8\n' +
      '  failureType: testCodeFailure\n' +
      '  error: |-\n' +
      '    AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n' +
      '    + actual - expected\n' +
      '    + 0\n' +
      '    - 1\n' +
      '  ...\n' +
      '1..1\n' +
      '# tests 1\n' +
      '# pass 0\n' +
      '# fail 1\n';
    const script = createOutputScript(scriptDir, 'not-ok-zero-tests', {
      stdout: tap,
      exitCode: 1,
    });
    const { exitCode, stdout, stderr } = runCli(
      `record-red GH-532-NOK --cmd "${script}"`,
      homeDir,
      repo
    );
    assert.strictEqual(
      exitCode,
      0,
      `"not ok" line containing "0 tests" must be accepted, got stderr: ${stderr}`
    );
    const result = JSON.parse(stdout);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.phase, 'red');
    const state = readState(homeDir, 'GH-532-NOK');
    const cycle = state.cycles.find((c) => c.cycle === state.currentCycle);
    assert.ok(cycle && cycle.red, 'record.red must be persisted for real RED');
  });

  it('Runtime ReferenceError inside node:test YAML error block is accepted', () => {
    // Cursor Bugbot (GH-532 PR #550): when a failing test's body throws an
    // error whose multi-line message contains the literal text
    // `ReferenceError:`, node:test's TAP reporter emits it under
    // `error: |-` inside a `---`/`...` YAML diagnostic block. The detector
    // must NOT treat that line as a top-level load failure — it is a real
    // RED.
    //
    // The fixture below is the verbatim TAP output emitted by
    // `node --test --test-reporter=tap` for a test that does
    // `throw new ReferenceError('multi\\nline\\nReferenceError: synthesized')`.
    // We don't shell out to `node --test` here because the outer test
    // process is already a node:test runner; nested `node --test` detects
    // the recursion and skips the run.
    runCli('init GH-532-YAML', homeDir);
    const tap =
      'TAP version 13\n' +
      '# Subtest: runtime ref error\n' +
      'not ok 1 - runtime ref error\n' +
      '  ---\n' +
      '  duration_ms: 0.95\n' +
      "  type: 'test'\n" +
      "  location: '/tmp/runtime-ref.test.js:2:1'\n" +
      "  failureType: 'testCodeFailure'\n" +
      '  error: |-\n' +
      '    multi\n' +
      '    line\n' +
      '    ReferenceError: synthesized\n' +
      "  code: 'ERR_TEST_FAILURE'\n" +
      "  name: 'ReferenceError'\n" +
      '  stack: |-\n' +
      '    TestContext.<anonymous> (/tmp/runtime-ref.test.js:4:9)\n' +
      '    Test.runInAsyncScope (node:async_hooks:228:14)\n' +
      '  ...\n' +
      '1..1\n' +
      '# tests 1\n' +
      '# pass 0\n' +
      '# fail 1\n';
    const script = createOutputScript(scriptDir, 'yaml-runtime-ref', {
      stdout: tap,
      exitCode: 1,
    });
    const { exitCode, stdout, stderr } = runCli(
      `record-red GH-532-YAML --cmd "${script}"`,
      homeDir,
      repo
    );
    assert.strictEqual(
      exitCode,
      0,
      `runtime ReferenceError inside YAML error block must be accepted as RED, got stderr: ${stderr}`
    );
    const result = JSON.parse(stdout);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.phase, 'red');
    const state = readState(homeDir, 'GH-532-YAML');
    const cycle = state.cycles.find((c) => c.cycle === state.currentCycle);
    assert.ok(cycle && cycle.red, 'record.red must be persisted for runtime RED');
  });

  it('Audit snippet quotes the line the detector actually matched (Bug 6)', () => {
    // The detector skips ReferenceError: lines inside a YAML envelope and
    // matches the SECOND ReferenceError: line below (the unindented one).
    // The audit row's meta.snippet must quote the matched line — NOT the
    // earlier YAML-enveloped one. Otherwise operators debugging from
    // .work-actions.json chase the wrong cause.
    runCli('init GH-532-SNIP', homeDir);
    const tap =
      'TAP version 13\n' +
      '# Subtest: a real failing test\n' +
      'not ok 1 - a real failing test\n' +
      '  ---\n' +
      '  duration_ms: 0.5\n' +
      '  error: |-\n' +
      '    ReferenceError: enveloped runtime error\n' +
      '  ...\n' +
      'ReferenceError: top-level load crash here\n' +
      '# tests 1\n' +
      '# pass 0\n' +
      '# fail 1\n';
    const script = createOutputScript(scriptDir, 'snippet-mismatch', {
      stdout: tap,
      exitCode: 1,
    });
    const { exitCode } = runCli(`record-red GH-532-SNIP --cmd "${script}"`, homeDir, repo);
    assert.strictEqual(exitCode, 1, 'expected rejection');
    const actions = JSON.parse(
      fs.readFileSync(
        path.join(homeDir, 'worktrees', 'tasks', 'GH-532-SNIP', '.work-actions.json'),
        'utf8'
      )
    );
    const row = actions.find((a) => a.action === 'tdd-red-load-failure-rejected');
    assert.ok(row, 'expected rejection audit row');
    assert.ok(
      /top-level load crash here/.test(row.meta.snippet),
      `snippet must quote the matched (top-level) line, got: ${row.meta.snippet}`
    );
    assert.ok(
      !/enveloped runtime error/.test(row.meta.snippet),
      `snippet must NOT quote a YAML-enveloped line the detector skipped, got: ${row.meta.snippet}`
    );
  });

  it('stderr load failure is detected even when stdout truncates mid-YAML (Bug 7)', () => {
    // Test runner killed mid-YAML (timeout/signal) so stdout ends INSIDE a
    // `---` envelope without ever emitting `...`. The real load failure
    // surfaces on stderr. If detector state carries across the stdout→stderr
    // seam, the stderr ReferenceError: gets skipped → real fault masked.
    runCli('init GH-532-TRUNC', homeDir);
    const truncatedStdout =
      'TAP version 13\n' +
      '# Subtest: hung test\n' +
      'not ok 1 - hung test\n' +
      '  ---\n' +
      '  duration_ms: 4999\n' +
      '  error: |-\n' +
      '    timeout\n';
    const stderr = 'ReferenceError: setupStagedHook is not defined\n';
    const script = createOutputScript(scriptDir, 'truncated-yaml', {
      stdout: truncatedStdout,
      stderr,
      exitCode: 1,
    });
    const { exitCode, stderr: rejStderr } = runCli(
      `record-red GH-532-TRUNC --cmd "${script}"`,
      homeDir,
      repo
    );
    assert.strictEqual(
      exitCode,
      1,
      `truncated-stdout-then-stderr load failure must be rejected, got stderr: ${rejStderr}`
    );
    assert.ok(
      /ReferenceError/.test(rejStderr),
      `expected ReferenceError diagnostic, got: ${rejStderr}`
    );
  });

  it('TAP "not ok" title containing "ReferenceError:" is accepted as valid RED (Finding 1a)', () => {
    // Symmetric to the existing "0 tests" fix: a real failing test whose
    // name embeds the literal text "ReferenceError:" emits a top-level
    // `not ok 1 - throws ReferenceError: ...` line. The detector must NOT
    // treat that as a load-failure signature — it's a TAP control line for
    // a genuine assertion failure.
    runCli('init GH-532-NOK-RE', homeDir);
    const tap =
      'TAP version 13\n' +
      '# Subtest: throws ReferenceError: when given bad arg\n' +
      'not ok 1 - throws ReferenceError: when given bad arg\n' +
      '  ---\n' +
      '  duration_ms: 0.5\n' +
      '  failureType: testCodeFailure\n' +
      '  error: |-\n' +
      '    AssertionError [ERR_ASSERTION]: Expected fn to throw\n' +
      '  ...\n' +
      '1..1\n' +
      '# tests 1\n' +
      '# pass 0\n' +
      '# fail 1\n';
    const script = createOutputScript(scriptDir, 'not-ok-referror', { stdout: tap, exitCode: 1 });
    const { exitCode, stdout, stderr } = runCli(
      `record-red GH-532-NOK-RE --cmd "${script}"`,
      homeDir,
      repo
    );
    assert.strictEqual(
      exitCode,
      0,
      `"not ok" line embedding "ReferenceError:" must be accepted, got stderr: ${stderr}`
    );
    const result = JSON.parse(stdout);
    assert.strictEqual(result.ok, true);
  });

  it('TAP "not ok" title containing "SyntaxError:" is accepted as valid RED (Finding 1b)', () => {
    runCli('init GH-532-NOK-SE', homeDir);
    const tap =
      'TAP version 13\n' +
      '# Subtest: emits SyntaxError: on invalid JSON\n' +
      'not ok 1 - emits SyntaxError: on invalid JSON\n' +
      '  ---\n' +
      '  duration_ms: 0.5\n' +
      '  ...\n' +
      '1..1\n' +
      '# tests 1\n' +
      '# pass 0\n' +
      '# fail 1\n';
    const script = createOutputScript(scriptDir, 'not-ok-syntaxerr', { stdout: tap, exitCode: 1 });
    const { exitCode, stderr } = runCli(
      `record-red GH-532-NOK-SE --cmd "${script}"`,
      homeDir,
      repo
    );
    assert.strictEqual(
      exitCode,
      0,
      `"not ok" line embedding "SyntaxError:" must be accepted, got stderr: ${stderr}`
    );
  });

  it('TAP "not ok" title containing "MODULE_NOT_FOUND" is accepted as valid RED (Finding 1c)', () => {
    runCli('init GH-532-NOK-MNF', homeDir);
    const tap =
      'TAP version 13\n' +
      '# Subtest: returns MODULE_NOT_FOUND when path is missing\n' +
      'not ok 1 - returns MODULE_NOT_FOUND when path is missing\n' +
      '  ---\n' +
      '  duration_ms: 0.5\n' +
      '  ...\n' +
      '1..1\n' +
      '# tests 1\n' +
      '# pass 0\n' +
      '# fail 1\n';
    const script = createOutputScript(scriptDir, 'not-ok-mnf', { stdout: tap, exitCode: 1 });
    const { exitCode, stderr } = runCli(
      `record-red GH-532-NOK-MNF --cmd "${script}"`,
      homeDir,
      repo
    );
    assert.strictEqual(
      exitCode,
      0,
      `"not ok" line embedding "MODULE_NOT_FOUND" must be accepted, got stderr: ${stderr}`
    );
  });

  it('MODULE_NOT_FOUND code line is rejected with accurate signature (Finding 3)', () => {
    // When the matched line is the canonical `code: 'MODULE_NOT_FOUND'`
    // emission from node's module loader, the audit row's
    // `meta.signature` MUST name `MODULE_NOT_FOUND` (matching the actual
    // matched substring), not the unrelated `Cannot find module` literal
    // — operators reading .work-actions.json would otherwise see a name
    // that doesn't appear in the snippet.
    runCli('init GH-532-MNF-SIG', homeDir);
    const script = createOutputScript(scriptDir, 'mnf-code-line', {
      stderr: "Error: load failed\n    at /tmp/foo.js:1:1\n  code: 'MODULE_NOT_FOUND'\n",
      exitCode: 1,
    });
    const { exitCode } = runCli(`record-red GH-532-MNF-SIG --cmd "${script}"`, homeDir, repo);
    assert.strictEqual(exitCode, 1, 'expected rejection');
    const actions = JSON.parse(
      fs.readFileSync(
        path.join(homeDir, 'worktrees', 'tasks', 'GH-532-MNF-SIG', '.work-actions.json'),
        'utf8'
      )
    );
    const row = actions.find((a) => a.action === 'tdd-red-load-failure-rejected');
    assert.ok(row, 'expected rejection audit row');
    assert.strictEqual(
      row.meta.signature,
      'MODULE_NOT_FOUND',
      `signature must match the actual matched substring, got: ${row.meta.signature}`
    );
    assert.ok(
      /MODULE_NOT_FOUND/.test(row.meta.snippet),
      `snippet must include the matched text, got: ${row.meta.snippet}`
    );
  });

  it('Unindented "---" in test output does not open a YAML envelope (Bug 9)', () => {
    // A test prints a top-level divider `---` followed by a load-failure
    // signature. The TAP YAML envelope is ALWAYS indented under `not ok`;
    // an unindented `---` is just a divider. The detector must not treat
    // it as a YAML opener and silently swallow the subsequent
    // ReferenceError:.
    runCli('init GH-532-DIV', homeDir);
    const stdout =
      'TAP version 13\n' +
      '---\n' +
      'ReferenceError: simulated load error in test fixture\n' +
      '...\n' +
      '# tests 0\n';
    const script = createOutputScript(scriptDir, 'unindented-divider', {
      stdout,
      exitCode: 1,
    });
    const { exitCode, stderr } = runCli(`record-red GH-532-DIV --cmd "${script}"`, homeDir, repo);
    assert.strictEqual(
      exitCode,
      1,
      `unindented "---" must not gate the ReferenceError, got stderr: ${stderr}`
    );
    assert.ok(/ReferenceError/.test(stderr), `expected ReferenceError diagnostic, got: ${stderr}`);
  });

  it('Recovery round-trip: reject load failure, then fix and re-record successfully (Finding G)', () => {
    // The documented recovery path is: rejection -> agent fixes the test
    // file -> re-run record-red succeeds and persists evidence. Prove the
    // system is not permanently wedged by exercising the full round-trip
    // against the same ticket+task+cycle.
    runCli('init GH-532-RECOV', homeDir);

    // 1. First attempt: ReferenceError at load → rejected, no evidence persisted.
    const brokenScript = createOutputScript(scriptDir, 'broken', {
      stderr: 'ReferenceError: setupStagedHook is not defined\n',
      exitCode: 1,
    });
    const rejection = runCli(`record-red GH-532-RECOV --cmd "${brokenScript}"`, homeDir, repo);
    assert.strictEqual(rejection.exitCode, 1, 'first attempt must be rejected');
    assert.match(rejection.stderr, /ReferenceError/);
    const afterReject = readState(homeDir, 'GH-532-RECOV');
    assert.strictEqual(afterReject.currentPhase, 'red');
    const rejCycle = afterReject.cycles.find((c) => c.cycle === afterReject.currentCycle);
    assert.ok(!rejCycle || !rejCycle.red, 'no record.red persisted on rejection');

    // 2. Second attempt: agent "fixed" the test → real assertion failure with
    //    proper TAP envelope → accepted; record.red persists into the same
    //    cycle, currentCycle unchanged.
    const fixedScript = createOutputScript(scriptDir, 'fixed', {
      stdout:
        'TAP version 13\n' +
        '# Subtest: feature works\n' +
        'not ok 1 - feature works\n' +
        '  ---\n' +
        '  duration_ms: 1\n' +
        '  failureType: testCodeFailure\n' +
        '  error: |-\n' +
        '    AssertionError [ERR_ASSERTION]: Expected 1 === 2\n' +
        '  ...\n' +
        '1..1\n' +
        '# tests 1\n' +
        '# pass 0\n' +
        '# fail 1\n',
      exitCode: 1,
    });
    const acceptance = runCli(`record-red GH-532-RECOV --cmd "${fixedScript}"`, homeDir, repo);
    assert.strictEqual(
      acceptance.exitCode,
      0,
      `recovery must be accepted, got stderr: ${acceptance.stderr}`
    );
    const result = JSON.parse(acceptance.stdout);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.phase, 'red');

    const afterAccept = readState(homeDir, 'GH-532-RECOV');
    assert.strictEqual(
      afterAccept.currentCycle,
      afterReject.currentCycle,
      'cycle must not advance during recovery'
    );
    const accCycle = afterAccept.cycles.find((c) => c.cycle === afterAccept.currentCycle);
    assert.ok(accCycle && accCycle.red, 'record.red must be persisted after recovery');
    assert.strictEqual(accCycle.red.testExitCode, 1);

    // 3. transition red->green is now unblocked (the gate sees real evidence).
    const tx = runCli(`transition GH-532-RECOV green`, homeDir, repo);
    assert.strictEqual(
      tx.exitCode,
      0,
      `transition must succeed after recovery, got stderr: ${tx.stderr}`
    );
    const afterTx = readState(homeDir, 'GH-532-RECOV');
    assert.strictEqual(afterTx.currentPhase, 'green', 'phase must advance to green after recovery');

    // 4. Exactly one rejection audit row was appended (the broken attempt);
    //    the accepted re-run does not add another.
    const actions = JSON.parse(
      fs.readFileSync(
        path.join(homeDir, 'worktrees', 'tasks', 'GH-532-RECOV', '.work-actions.json'),
        'utf8'
      )
    );
    const rejections = actions.filter((a) => a.action === 'tdd-red-load-failure-rejected');
    assert.strictEqual(
      rejections.length,
      1,
      `expected exactly one rejection audit row across the round-trip, got ${rejections.length}`
    );
  });
});
