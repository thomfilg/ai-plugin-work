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
const fs = require('fs');
const { execSync } = require('child_process');

const { findNearestEnvrc, detectMalformedTestCommand } = require(
  path.join(__dirname, 'test-command')
);

const {
  writeTestLog,
  isTddRequired,
  evidencePathFor,
  isE2eCommand,
  shouldSkipTestExecution,
  writeSkipStubEvidence,
  malformedPreTestBlock,
  recordNonTddPreTestStub,
  buildGreenEvidence,
} = require(path.join(__dirname, 'evidence'));

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
 * @returns {{ exitCode: number, output: string, timedOut?: boolean }}
 */
function execTestCommand(cmd, workingDir, env) {
  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
      cwd: workingDir,
      env,
      timeout: 300000,
      stdio: 'pipe',
    });
    return { exitCode: 0, output };
  } catch (err) {
    const output = (err.stdout || '') + (err.stderr || '');
    if (err && err.signal) {
      // timeout / killed — can't tell if test would have failed. Preserve any
      // partial output so the post-implement path can surface it (matches the
      // pre-refactor inline behavior); the pre-implement path early-returns on
      // `timedOut` and ignores both exitCode and output.
      return { exitCode: err.status ?? 1, output, timedOut: true };
    }
    return { exitCode: err.status ?? 1, output };
  }
}

/**
 * Write authentic RED evidence after a failing pre-implement test.
 * Phase is 'red' until the post-implement test passes and runTestAndRecord
 * transitions it to 'green'.
 */
function writeRedEvidence(taskDir, evidencePath, cmd, exitCode, output, now) {
  const redLog = writeTestLog(taskDir, 'red', cmd, exitCode, output, now);
  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          currentPhase: 'red',
          currentCycle: 1,
          cycles: [
            {
              cycle: 1,
              red: {
                testFiles: [],
                testCommand: cmd,
                testExitCode: exitCode,
                timestamp: now,
                capturedByGate: true,
                outputTail: String(output).slice(-2000),
                ...(redLog ? { logPath: redLog.logPath, logBytes: redLog.logBytes } : {}),
              },
            },
          ],
        },
        null,
        2
      )
    );
  } catch {
    /* fail-open */
  }
}

/**
 * Run the test command BEFORE the dev agent is dispatched and write authentic
 * RED evidence (or block, or skip) based on outcome and task type.
 *
 *   - exit non-zero        → write real RED, return { decision: 'dispatch' }
 *   - exit zero, TDD type  → return { decision: 'block', reason }
 *   - exit zero, non-TDD   → write skip-stub RED, return { decision: 'dispatch' }
 *   - timeout/error        → return { decision: 'dispatch', preTestSkipped: true }
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
  // dispatch (or just advance, since the post-test will also skip).
  const skipReason = shouldSkipTestExecution(cmd, env);
  if (skipReason) {
    writeSkipStubEvidence(cmd, safeName, taskNum, gateTasksBase, skipReason);
    return { decision: 'dispatch', preTestSkipped: true, skipReason };
  }

  const { exitCode, output, timedOut } = execTestCommand(cmd, workingDir, env);
  if (timedOut) {
    return { decision: 'dispatch', preTestSkipped: true };
  }

  const evidencePath = evidencePathFor(gateTasksBase, safeName, taskNum);
  const taskDir = path.dirname(evidencePath);
  const now = new Date().toISOString();

  if (exitCode === 0) {
    if (isTddRequired(taskType)) {
      return {
        decision: 'block',
        reason: `Pre-implement test passed for task type "${taskType || 'default'}". TDD requires a failing test before implementation. Update tasks.md or the test command for task ${taskNum}.`,
        command: cmd,
        exitCode: 0,
        outputTail: String(output).slice(-4000),
      };
    }
    return recordNonTddPreTestStub(cmd, taskType, taskDir, evidencePath, now);
  }

  writeRedEvidence(taskDir, evidencePath, cmd, exitCode, output, now);
  return { decision: 'dispatch' };
}

/**
 * Short-circuit the post-implement test for a malformed command or an active
 * skip policy. Returns a terminal result, or null to proceed with execution.
 */
function preflightPostTest(cmd, env, safeName, taskNum, gateTasksBase) {
  // Detect malformed parser output up front — return a structured failure so
  // the gate can surface a clear "fix tasks.md" reason instead of "no GREEN".
  const malformed = detectMalformedTestCommand(cmd);
  if (malformed) {
    return { passed: false, malformed, command: String(cmd || ''), exitCode: null, outputTail: '' };
  }

  // Honor WORK_SKIP_E2E=1 / WORK_SKIP_E2E_TESTS=1 — write skip stub and pass.
  const skipReason = shouldSkipTestExecution(cmd, env);
  if (skipReason && gateTasksBase) {
    writeSkipStubEvidence(cmd, safeName, taskNum, gateTasksBase, skipReason);
    return { passed: true, skipped: skipReason };
  }
  return null;
}

/**
 * Post-implement test: run command, on pass record GREEN evidence.
 *
 * If a RED entry already exists (from runPreImplementTest), append GREEN
 * to the existing cycle. Otherwise refuse (no authentic RED).
 *
 * @returns {boolean} true if test passed and evidence is now complete
 */
function runTestAndRecord(cmd, safeName, taskNum, workingDir, env, gateTasksBase) {
  const early = preflightPostTest(cmd, env, safeName, taskNum, gateTasksBase);
  if (early) return early;

  const { exitCode, output } = execTestCommand(cmd, workingDir, env);

  if (exitCode !== 0)
    return { passed: false, command: cmd, exitCode, outputTail: String(output).slice(-4000) };
  if (!gateTasksBase) return { passed: false, command: cmd, exitCode: 0, outputTail: '' };

  const taskDir = path.join(gateTasksBase, safeName, `task${taskNum}`);
  const evidencePath = path.join(taskDir, 'tdd-phase.json');
  const now = new Date().toISOString();

  // If pre-test wrote a RED entry, preserve it and add GREEN
  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  } catch {
    /* no pre-existing evidence */
  }

  const greenLog = writeTestLog(taskDir, 'green', cmd, 0, output, now);
  const built = buildGreenEvidence(existing, cmd, output, now, greenLog);
  if (built.noRedEvidence) {
    return {
      passed: false,
      command: cmd,
      exitCode: 0,
      outputTail: '',
      noRedEvidence: true,
    };
  }

  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(evidencePath, JSON.stringify(built.evidence, null, 2));
    return { passed: true };
  } catch (err) {
    return {
      passed: false,
      command: cmd,
      exitCode: 0,
      outputTail: `Failed to write tdd-phase.json: ${err && err.message}`,
    };
  }
}

module.exports = {
  withEnvrcVars,
  isE2eCommand,
  shouldSkipTestExecution,
  writeSkipStubEvidence,
  runPreImplementTest,
  runTestAndRecord,
};
