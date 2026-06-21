/**
 * Non-checkpoint TDD evidence flow for the implement gate.
 *
 * Split out of `advance-gate.js` to keep each module within the static-quality
 * budget. Owns the pre-implement RED capture, the post-implement GREEN record,
 * and the final evidence validation for non-checkpoint tasks. The gate
 * orchestration (task-advance, checkpoint handling) stays in `advance-gate.js`.
 */

'use strict';

const path = require('path');
const fs = require('fs');

const { readTaskTestCommand } = require(path.join(__dirname, 'test-command'));
const { withEnvrcVars, runPreImplementTest, runTestAndRecord } = require(
  path.join(__dirname, 'test-runner')
);

/** Working directory for a task's test command. */
function resolveWorkingDir(ctx, ws) {
  return ctx.worktreeDir || (ws.worktreeDir ? ws.worktreeDir : process.cwd());
}

/** Build the env a gate-run test command executes in (TASKS_BASE + `.envrc`). */
function buildRunEnv(gateTasksBase, workingDir) {
  const baseEnv = gateTasksBase ? { ...process.env, TASKS_BASE: gateTasksBase } : process.env;
  return withEnvrcVars(baseEnv, workingDir);
}

/** Read TDD evidence for the active task, preferring the gate-derived base. */
function readEvidence(state) {
  const { gateTasksBase, tddEnforcement, readTddEvidence, safeName, stepName, taskNum } = state;
  return gateTasksBase
    ? tddEnforcement.readTddEvidence(gateTasksBase, safeName, stepName, taskNum)
    : readTddEvidence(safeName, stepName, taskNum);
}

/** True when evidence already holds a usable RED entry in its first cycle. */
function hasUsableRedEvidence(exists, evidence) {
  return Boolean(
    exists &&
      Array.isArray(evidence?.cycles) &&
      evidence.cycles.length > 0 &&
      evidence.cycles[0]?.red
  );
}

/** True when GREEN still needs to be recorded for this evidence. */
function needsGreenEvidence(exists, evidence) {
  return !exists || !Array.isArray(evidence?.cycles) || !evidence.cycles[0]?.green;
}

/** True when a post-implement result should drive a retry (not a clean pass). */
function isRetryableResult(result) {
  return Boolean(result && (result.noRedEvidence || result.malformed || result.passed === false));
}

/**
 * Gate D' — verify every @test file declared in gherkin.feature for this task
 * exists on disk before running the pre-test. Returns a retry reason string
 * when files are missing, or null to proceed. Fail-open on parse errors.
 */
function checkGherkinTestFiles(ctx, taskNum, workingDir) {
  try {
    const gherkinPath = path.join(ctx.tasksDir, 'gherkin.feature');
    if (!fs.existsSync(gherkinPath)) return null;
    const { findMissingTestFiles, collectTaskTestPaths } = require(
      path.join(__dirname, '..', '..', 'gherkin-task-refs.js')
    );
    const gherkinText = fs.readFileSync(gherkinPath, 'utf8');
    const allRefs = collectTaskTestPaths({ gherkinText }, taskNum);
    if (allRefs.length === 0) return null;
    const { missing } = findMissingTestFiles({ gherkinText, worktreeDir: workingDir }, taskNum);
    if (missing.length === 0) return null;
    return {
      reason: `Task ${taskNum} cannot enter RED — gherkin.feature declares @test files that do not exist on disk: ${missing.join(', ')}. Create the failing test file(s) first, then re-run the gate.`,
      outputTail: missing.join('\n'),
    };
  } catch {
    /* fail-open — gherkin parse failure shouldn't deadlock the gate */
    return null;
  }
}

/**
 * PRE-IMPLEMENT: gate-driven authentic RED capture, run once per task before
 * the first dispatch. Returns { handled: true } when the gate must return null
 * on this pass (a pre-test ran, blocked, or a gherkin check failed), or
 * { handled: false } to fall through to the post-implement path.
 */
function runPreImplementPhase(state) {
  const { ws, ctx, safeName, taskNum, taskType, gateTasksBase, recordRetry, saveWorkState } = state;
  const workingDir = resolveWorkingDir(ctx, ws);
  const testCmd = readTaskTestCommand(ctx.tasksDir, taskNum, workingDir);
  if (!testCmd) return { handled: false };

  const gherkinFail = checkGherkinTestFiles(ctx, taskNum, workingDir);
  if (gherkinFail) {
    recordRetry(gherkinFail.reason, {
      command: testCmd,
      exitCode: null,
      outputTail: gherkinFail.outputTail,
    });
    return { handled: true };
  }

  const runEnv = buildRunEnv(gateTasksBase, workingDir);
  const pre = runPreImplementTest(
    testCmd,
    safeName,
    taskNum,
    workingDir,
    runEnv,
    gateTasksBase,
    taskType
  );
  ws._preTestForTask = `${taskNum}`;
  saveWorkState(safeName, ws);

  if (pre.decision === 'block') {
    recordRetry(pre.reason, {
      command: pre.command || testCmd,
      exitCode: pre.exitCode,
      outputTail: pre.outputTail,
    });
  }
  // The pre-test just ran on this gate pass. Return now — DO NOT fall through
  // to the post-implement test on the same call. Otherwise the gate would
  // record GREEN immediately (especially for tasks whose pre-test passes, e.g.
  // non-TDD types) and auto-advance the task without ever dispatching the
  // implementation agent. The next gate pass (after the agent has run) will
  // skip this branch (preTestDone is now true) and run the post-implement test.
  return { handled: true };
}

/** Build the retry block for a post-implement result that is not a clean pass. */
function postResultRetry(result, taskNum, ws, recordRetry, saveWorkState, safeName) {
  if (result.noRedEvidence) {
    // GREEN ran cleanly but no authentic RED was captured. Clear the pre-test
    // marker so the next gate pass runs the pre-implement test again.
    delete ws._preTestForTask;
    saveWorkState(safeName, ws);
    recordRetry(
      `No authentic RED evidence for task ${taskNum}. The gate refuses to synthesize a TDD cycle — write a failing test FIRST, commit the failure (gate will capture it), then implement.`,
      { command: result.command, exitCode: result.exitCode ?? 0, outputTail: '' }
    );
    return;
  }
  if (result.malformed) {
    recordRetry(
      `Test command for task ${taskNum} is malformed in tasks.md ` +
        `(parser returned: ${JSON.stringify(String(result.command || '').slice(0, 120))}, ` +
        `category: ${result.malformed}). ` +
        `Open tasks.md and fix the \`### Test Command\` section under "## Task ${taskNum}".`,
      { command: result.command, exitCode: null, outputTail: '' }
    );
    return;
  }
  // Post-test ran and failed — capture the command + exit + tail.
  recordRetry(
    `Post-implement test for task ${taskNum} failed (exit ${result.exitCode}). Fix the source so the command below passes.`,
    { command: result.command, exitCode: result.exitCode, outputTail: result.outputTail }
  );
}

/**
 * POST-IMPLEMENT: after the agent has run, re-run the test command and on pass
 * record GREEN. Returns { handled: true } when the gate must return null, or
 * { handled: false, exists, evidence } with possibly-refreshed evidence.
 */
function runPostImplementPhase(state, evidenceState) {
  const { ws, ctx, safeName, taskNum, gateTasksBase, recordRetry, saveWorkState } = state;
  const { exists, evidence } = evidenceState;

  const workingDir = resolveWorkingDir(ctx, ws);
  const testCmd = readTaskTestCommand(ctx.tasksDir, taskNum, workingDir);
  if (!testCmd || !needsGreenEvidence(exists, evidence)) {
    return { handled: false, exists, evidence };
  }

  const runEnv = buildRunEnv(gateTasksBase, workingDir);
  const result = runTestAndRecord(testCmd, safeName, taskNum, workingDir, runEnv, gateTasksBase);

  if (result && result.passed) {
    const reread = readEvidence(state);
    return { handled: false, exists: reread.exists, evidence: reread.evidence };
  }
  if (isRetryableResult(result)) {
    postResultRetry(result, taskNum, ws, recordRetry, saveWorkState, safeName);
    return { handled: true };
  }
  return { handled: false, exists, evidence };
}

/** Evidence acceptable for a `test`-type task: any cycle, or exception evidence. */
function testTaskEvidenceOk(evidence) {
  const hasAnyCycle = Array.isArray(evidence?.cycles) && evidence.cycles.length > 0;
  const hasException = evidence?.currentPhase === 'exception' && evidence?.exception;
  return Boolean(hasAnyCycle || hasException);
}

/**
 * Validate evidence for a non-checkpoint task. Returns a retry reason string
 * when evidence is missing/invalid, or null when it is acceptable.
 */
function validateNonCheckpointEvidence(exists, evidence, taskType, taskNum, validateTddEvidence) {
  if (!exists) {
    return `No TDD evidence found at task${taskNum}/tdd-phase.json. The gate will record evidence by running the task's \`### Test Command\` — if you keep seeing this, the test command is missing or unrunnable in tasks.md under "## Task ${taskNum}".`;
  }

  if (taskType === 'test') {
    // Accept any evidence (even RED-only) for test tasks, or exception evidence.
    return testTaskEvidenceOk(evidence)
      ? null
      : `TDD evidence exists but has no cycles or exception. Gate will retry by running the task's \`### Test Command\`.`;
  }

  const validation = validateTddEvidence(evidence);
  return validation.valid ? null : `TDD evidence invalid: ${validation.reason}`;
}

/**
 * Non-checkpoint flow: pre-implement RED capture, post-implement GREEN record,
 * then evidence validation. Returns { handled: true } when the gate must
 * return null, or { handled: false } when evidence is valid and the caller
 * should proceed to advance the task pointer.
 */
function runNonCheckpointFlow(state) {
  const { ws, ctx, taskNum, recordRetry, taskType, validateTddEvidence } = state;

  let { exists, evidence } = readEvidence(state);

  // PRE-IMPLEMENT (run once per task, before first dispatch).
  const preTestDone = ws._preTestForTask === `${taskNum}`;
  if (!hasUsableRedEvidence(exists, evidence) && !preTestDone && ctx.tasksDir) {
    const pre = runPreImplementPhase(state);
    if (pre.handled) return { handled: true };
  }

  // POST-IMPLEMENT.
  if (ctx.tasksDir) {
    const post = runPostImplementPhase(state, { exists, evidence });
    if (post.handled) return { handled: true };
    exists = post.exists;
    evidence = post.evidence;
  }

  const retry = validateNonCheckpointEvidence(
    exists,
    evidence,
    taskType,
    taskNum,
    validateTddEvidence
  );
  if (retry) {
    recordRetry(retry, {});
    return { handled: true };
  }
  return { handled: false };
}

module.exports = { runNonCheckpointFlow };
