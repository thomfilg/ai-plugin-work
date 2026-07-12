/**
 * Test-execution helpers for the implement gate.
 *
 * Runs a task's test command before and after the dev agent is dispatched and
 * records authentic RED / GREEN TDD evidence. The evidence/log writers and
 * command classifiers live in `evidence.js`; this module owns the execution
 * flow and the env a synthesized command runs in.
 */

'use strict';

const path = require('path');
const { execSync } = require('child_process');

const { findNearestEnvrc, detectMalformedTestCommand, detectUnsetEnvelopeCommand } = require(
  path.join(__dirname, 'test-command')
);

const {
  writeTestLog,
  evidencePathFor,
  isE2eCommand,
  shouldSkipTestExecution,
  writeSkipStubEvidence,
  malformedStrategyReason,
  malformedPreTestBlock,
  unsetEnvelopeBlock,
  unsetEnvelopeReason,
  preTestPassOutcome,
} = require(path.join(__dirname, 'evidence'));

// W11 — the ONE gate evidence writer (atomic writes + recorder-parity traps).
// Lives beside the recorder so both sides share the hang/load-failure guards.
const { writeGateRed, gateHangRejection } = require(
  path.join(__dirname, '..', '..', '..', '..', 'work-implement', 'tdd-phase-state', 'gate-writer')
);
// GREEN persistence (extracted for file-size burndown, GH-694) — preserves
// the pre-test RED and applies the writer's traps, incl. the tests-only
// changed-test-files rule.
const { persistGateGreen } = require(path.join(__dirname, 'persist-gate-green'));
// W5 §5 — same env-overridable timeout the recorder uses
// (TDD_PHASE_TEST_TIMEOUT_MS, default 5min), so tests can exercise the
// hang-rejection path without waiting minutes.
const { resolveTestTimeoutMs } = require(
  path.join(__dirname, '..', '..', '..', '..', 'work-implement', 'tdd-phase-state', 'io')
);

/**
 * Build the environment a synthesized test command runs in.
 *
 * Strategy-synthesized envelope commands reference the test-command env var
 * by name (e.g. `eval "$TEST_INTEGRATION_COMMAND"`). That var lives in the
 * worktree's `.envrc`, which is NOT sourced into the gate's process env — so
 * without this the `eval` expands to the empty string and the command no-ops
 * to exit 0 (the empty-command trap). Fold the worktree `.envrc` vars into the
 * base env, with the worktree `.envrc` winning over any ambient value: the
 * `.envrc` is the worktree's authoritative test envelope, so a `TEST_*_COMMAND`
 * that leaked into the gate's process env (e.g. from a parent test harness that
 * runs the gate under its own `$TEST_INTEGRATION_COMMAND`) must not shadow the
 * value the worktree actually declares.
 *
 * @param {object} baseEnv - the env the gate would otherwise use
 * @param {string} worktreeDir - worktree root used to resolve `.envrc`
 * @returns {object}
 */
function withEnvrcVars(baseEnv, worktreeDir) {
  if (!worktreeDir) return baseEnv;
  let resolved;
  try {
    resolved = findNearestEnvrc(worktreeDir);
  } catch {
    return baseEnv;
  }
  if (!resolved || !resolved.vars) return baseEnv;
  const merged = { ...baseEnv };
  for (const [name, value] of Object.entries(resolved.vars)) {
    // The worktree `.envrc` is authoritative for its own test envelope. Skip
    // only empty/undefined `.envrc` values so a real ambient export still
    // survives the empty-command trap; otherwise the `.envrc` value wins.
    if (value === undefined || value === '') continue;
    merged[name] = value;
  }
  return merged;
}

/**
 * Execute a test command and capture its exit code + combined output.
 * @returns {{ exitCode: number, output: string, timedOut?: boolean, timeoutMs: number }}
 */
function execTestCommand(cmd, workingDir, env) {
  const timeoutMs = resolveTestTimeoutMs();
  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
      cwd: workingDir,
      env,
      timeout: timeoutMs,
      stdio: 'pipe',
      // Strict-mode prefixes (W9) need bash: `pipefail` is a bash-ism and
      // /bin/sh is dash on Debian/Ubuntu. PATH-resolved `bash`, NOT an
      // absolute /bin/bash pin — the recorder (tdd-phase-state/io.js) and
      // task-next.js runTest resolve bash via PATH, and an absolute pin
      // would ENOENT the gate half of the unified pipeline (NixOS etc.).
      shell: 'bash',
    });
    return { exitCode: 0, output, timeoutMs };
  } catch (err) {
    const output = (err.stdout || '') + (err.stderr || '');
    if (err && err.signal) {
      // W5 / GH-584 — timeout/killed run: a HANG, not a test outcome. Callers
      // must reject it as a planner defect (watch-mode/interactive command),
      // never record it as RED or misread its exit as a plain failure.
      // Preserve any partial output for the retry diagnostic.
      return { exitCode: err.status ?? 1, output, timedOut: true, timeoutMs };
    }
    return { exitCode: err.status ?? 1, output, timeoutMs };
  }
}

/**
 * W11 — capture authentic gate RED through the shared writer, which applies
 * the recorder-parity traps (hang + RED load-failure rejection) and writes
 * atomically. Rejections come back as a block decision the gate turns into a
 * retry; `preTestIncomplete` keeps the pre-test marker unset so the next gate
 * pass (after the defect is fixed) re-runs the pre-test.
 */
function captureGateRed(p) {
  const { gateTasksBase, safeName, taskNum, evidencePath, cmd, exitCode, output, now } = p;
  const redLog = writeTestLog(path.dirname(evidencePath), 'red', cmd, exitCode, output, now);
  let wr;
  try {
    wr = writeGateRed({
      tasksBase: gateTasksBase,
      ticketId: safeName,
      taskNum,
      evidencePath,
      cmd,
      exitCode,
      output,
      now,
      redLog,
    });
  } catch {
    /* fail-open on write error (matches the previous raw-write catch) */
    wr = { written: true };
  }
  if (wr.rejected) {
    return {
      decision: 'block',
      preTestIncomplete: true,
      plannerDefect: wr.plannerDefect,
      defectKind: wr.defectKind,
      reason: wr.reason,
      command: cmd,
      exitCode,
      outputTail: String(output).slice(-4000),
    };
  }
  return { decision: 'dispatch' };
}

/**
 * Run the test command BEFORE the dev agent is dispatched and write authentic
 * RED evidence (or block, or skip) based on outcome and task type.
 *
 *   - exit non-zero        → write real RED, return { decision: 'dispatch' }
 *   - exit zero, TDD type  → return { decision: 'block', reason }
 *   - exit zero, non-TDD   → write skip-stub RED, return { decision: 'dispatch' }
 *   - timeout (hang)       → return { decision: 'block', plannerDefect: true } (W5 §4)
 *   - unset envelope var   → return { decision: 'block', plannerDefect: true } (W6/GH-466)
 */
function runPreImplementTest(cmd, safeName, taskNum, workingDir, env, gateTasksBase, taskType) {
  if (!gateTasksBase) {
    return { decision: 'dispatch', preTestSkipped: true };
  }

  // Detect malformed parser output (fenced-block fragment, bare shell name)
  // and surface it BEFORE execSync — otherwise we burn retries on garbage.
  const malformed = detectMalformedTestCommand(cmd);
  if (malformed) {
    return malformedPreTestBlock(cmd, taskNum, malformed);
  }

  // Honor WORK_SKIP_E2E=1 / WORK_SKIP_E2E_TESTS=1 — record a skip stub and
  // dispatch. Operator choice: process.env only (see shouldSkipTestExecution).
  const skipReason = shouldSkipTestExecution(cmd);
  if (skipReason) {
    writeSkipStubEvidence(cmd, safeName, taskNum, gateTasksBase, skipReason);
    return { decision: 'dispatch', preTestSkipped: true, skipReason };
  }

  // W6 / GH-466 — an `eval "$VAR"` envelope whose var is unset in the run env
  // would no-op to exit 0 and fabricate evidence. Refuse to execute it.
  const unsetVar = detectUnsetEnvelopeCommand(cmd, env);
  if (unsetVar) {
    return unsetEnvelopeBlock(cmd, taskNum, unsetVar);
  }

  const { exitCode, output, timedOut, timeoutMs } = execTestCommand(cmd, workingDir, env);
  const evidencePath = evidencePathFor(gateTasksBase, safeName, taskNum);
  const now = new Date().toISOString();

  // W5 §4 / GH-584 — a pre-test hang used to early-return `preTestSkipped`
  // with NO evidence; the post-test then refused `noRedEvidence` and cleared
  // the marker, looping forever on the hanging command. Block as a planner
  // defect instead (audited via the shared writer's hang rejection).
  if (timedOut) {
    const rej = gateHangRejection({
      tasksBase: gateTasksBase,
      ticketId: safeName,
      taskNum,
      phase: 'red',
      cmd,
      timeoutMs,
    });
    return {
      decision: 'block',
      preTestIncomplete: true,
      plannerDefect: true,
      defectKind: 'hang', // never re-probed (would re-run the hang); hash-clearing only
      reason: rej.reason,
      command: cmd,
      exitCode: null,
      outputTail: String(output).slice(-4000),
    };
  }

  if (exitCode === 0) {
    return preTestPassOutcome({ cmd, taskNum, taskType, output, evidencePath, now });
  }

  return captureGateRed({
    gateTasksBase,
    safeName,
    taskNum,
    evidencePath,
    cmd,
    exitCode,
    output,
    now,
  });
}

/**
 * Short-circuit the post-implement test for a malformed command or an active
 * skip policy. Returns a terminal result, or null to proceed with execution.
 */
function preflightPostTest(cmd, env, safeName, taskNum, gateTasksBase) {
  // Detect malformed parser output up front — return a structured planner-
  // defect failure (W3) so the gate holds for the operator instead of
  // surfacing an opaque "no GREEN".
  const malformed = detectMalformedTestCommand(cmd);
  if (malformed) {
    return {
      passed: false,
      malformed,
      plannerDefect: true,
      defectKind: 'malformed-strategy',
      reason: malformedStrategyReason(cmd, taskNum, malformed),
      command: String(cmd || ''),
      exitCode: null,
      outputTail: '',
    };
  }

  // Honor WORK_SKIP_E2E — write skip stub and pass (process.env only).
  const skipReason = shouldSkipTestExecution(cmd);
  if (skipReason && gateTasksBase) {
    writeSkipStubEvidence(cmd, safeName, taskNum, gateTasksBase, skipReason);
    return { passed: true, skipped: skipReason };
  }

  // W6 / GH-466 — refuse to run (and therefore to record GREEN from) an
  // `eval "$VAR"` envelope whose var is unset in the run env: `eval ""`
  // exits 0 instantly with zero output and would record a false GREEN.
  const unsetVar = detectUnsetEnvelopeCommand(cmd, env);
  if (unsetVar) {
    return {
      passed: false,
      plannerDefect: true,
      defectKind: 'unset-envelope',
      reason: unsetEnvelopeReason(taskNum, unsetVar),
      command: String(cmd || ''),
      exitCode: null,
      outputTail: '',
    };
  }
  return null;
}

/**
 * Post-implement test: run command, on pass record GREEN evidence via
 * `persistGateGreen` (which preserves the pre-test RED and applies the
 * recorder-parity traps, including RC-D).
 *
 * @returns {object} result — { passed: true } or a structured failure
 */
function runTestAndRecord(cmd, safeName, taskNum, workingDir, env, gateTasksBase, taskType) {
  const early = preflightPostTest(cmd, env, safeName, taskNum, gateTasksBase);
  if (early) return early;

  const { exitCode, output, timedOut, timeoutMs } = execTestCommand(cmd, workingDir, env);

  // W5 §4 / GH-584 — a post-test hang is not a failing test: reject it as a
  // planner defect (audited) instead of surfacing "test failed (exit 1)".
  if (timedOut) {
    const rej = gateHangRejection({
      tasksBase: gateTasksBase,
      ticketId: safeName,
      taskNum,
      phase: 'green',
      cmd,
      timeoutMs,
    });
    return {
      passed: false,
      timedOut: true,
      plannerDefect: true,
      defectKind: 'hang', // hash-clearing only — never re-run to re-probe
      reason: rej.reason,
      command: cmd,
      exitCode: null,
      outputTail: String(output).slice(-4000),
    };
  }

  if (exitCode !== 0)
    return { passed: false, command: cmd, exitCode, outputTail: String(output).slice(-4000) };
  if (!gateTasksBase) return { passed: false, command: cmd, exitCode: 0, outputTail: '' };

  return persistGateGreen({ cmd, output, safeName, taskNum, gateTasksBase, taskType, workingDir });
}

module.exports = {
  withEnvrcVars,
  isE2eCommand,
  shouldSkipTestExecution,
  writeSkipStubEvidence,
  runPreImplementTest,
  runTestAndRecord,
};
