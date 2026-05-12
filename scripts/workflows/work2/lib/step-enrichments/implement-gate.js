/**
 * Implement multi-task gate.
 *
 * Handles task-advance when the current task's TDD evidence is valid
 * and more tasks remain. Returns { recurse: true } to re-dispatch
 * the next task, or null to let work-next.js handle re-dispatch.
 *
 * This gate works WITH the multi-task guard in transition-step.js:
 *   - transition-step.js BLOCKS implement→commit when tasks remain
 *   - This gate ADVANCES the task pointer when evidence is valid
 *
 * When evidence is missing or invalid, returns null so work-next.js
 * falls through and re-dispatches the full implementation prompt
 * (which already includes TDD evidence instructions).
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync, execSync } = require('child_process');
const { markProgress } = require(path.join(__dirname, '..', 'mark-task-progress'));

const { resolveTaskType } = require(path.join(__dirname, '..', 'resolve-task-type'));

/**
 * Read the `### Test Command` for a specific task from tasks.md.
 *
 * @param {string} tasksDir
 * @param {number} taskNum - 1-indexed task number
 * @returns {string|null}
 */
function readTaskTestCommand(tasksDir, taskNum) {
  if (!tasksDir) return null;
  const tasksMdPath = path.join(tasksDir, 'tasks.md');
  if (!fs.existsSync(tasksMdPath)) return null;
  try {
    const content = fs.readFileSync(tasksMdPath, 'utf8');
    const sectionRe = new RegExp(
      `## Task ${taskNum}\\b[\\s\\S]*?(?=\\n## Task \\d|\\n## (?!Task )|$)`,
      'm'
    );
    const sectionMatch = content.match(sectionRe);
    if (!sectionMatch) return null;
    const cmdMatch = sectionMatch[0].match(/### Test Command[^\n]*\n([^\n]+)/);
    return cmdMatch ? cmdMatch[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Task types that REQUIRE authentic RED before dispatch (pre-test must fail).
 * Other types skip RED enforcement and allow dispatch on a passing pre-test.
 */
const TDD_REQUIRED_TYPES = new Set(['implementation', 'feature', 'fix', 'test']);

function isTddRequired(taskType) {
  if (!taskType) return true; // default = TDD required
  return TDD_REQUIRED_TYPES.has(String(taskType).toLowerCase());
}

function evidencePathFor(gateTasksBase, safeName, taskNum) {
  return path.join(gateTasksBase, safeName, `task${taskNum}`, 'tdd-phase.json');
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

  let exitCode = 0;
  let output = '';
  try {
    output = execSync(cmd, {
      encoding: 'utf-8',
      cwd: workingDir,
      env,
      timeout: 300000,
      stdio: 'pipe',
    });
  } catch (err) {
    if (err && err.signal) {
      // timeout / killed — can't tell if test would have failed
      return { decision: 'dispatch', preTestSkipped: true };
    }
    exitCode = err.status ?? 1;
    output = (err.stdout || '') + (err.stderr || '');
  }

  const taskDir = path.dirname(evidencePathFor(gateTasksBase, safeName, taskNum));
  const evidencePath = evidencePathFor(gateTasksBase, safeName, taskNum);
  const now = new Date().toISOString();

  if (exitCode === 0) {
    if (isTddRequired(taskType)) {
      return {
        decision: 'block',
        reason: `Pre-implement test passed for task type "${taskType || 'default'}". TDD requires a failing test before implementation. Update tasks.md or the test command for task ${taskNum}.`,
      };
    }
    // Non-TDD type — record skip stub and allow dispatch
    try {
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(
        evidencePath,
        JSON.stringify(
          {
            currentPhase: 'green',
            currentCycle: 1,
            cycles: [
              {
                cycle: 1,
                red: {
                  testCommand: cmd,
                  testExitCode: 0,
                  timestamp: now,
                  capturedByGate: true,
                  note: `RED skipped: task type "${taskType}" does not require TDD.`,
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
    return { decision: 'dispatch', preTestSkipped: true };
  }

  // Pre-test FAILED — authentic RED
  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          currentPhase: 'green',
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
  return { decision: 'dispatch' };
}

/**
 * Post-implement test: run command, on pass record GREEN evidence.
 *
 * If a RED entry already exists (from runPreImplementTest), append GREEN
 * to the existing cycle. Otherwise synthesize a full RED+GREEN cycle.
 *
 * @returns {boolean} true if test passed and evidence is now complete
 */
function runTestAndRecord(cmd, safeName, taskNum, workingDir, env, gateTasksBase) {
  let exitCode = 0;
  try {
    execSync(cmd, {
      encoding: 'utf-8',
      cwd: workingDir,
      env,
      timeout: 300000,
      stdio: 'pipe',
    });
  } catch (err) {
    exitCode = err.status ?? 1;
  }

  if (exitCode !== 0) return false;
  if (!gateTasksBase) return false;

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

  let evidence;
  if (existing && Array.isArray(existing.cycles) && existing.cycles[0]?.red) {
    evidence = {
      ...existing,
      currentPhase: 'refactor',
      cycles: existing.cycles.map((c, i) =>
        i === 0
          ? {
              ...c,
              green: {
                testCommand: cmd,
                testExitCode: 0,
                timestamp: now,
                capturedByGate: true,
              },
            }
          : c
      ),
    };
  } else {
    // No prior RED — synthesize the full cycle
    evidence = {
      currentPhase: 'refactor',
      currentCycle: 1,
      cycles: [
        {
          cycle: 1,
          red: {
            testFiles: [],
            testCommand: cmd,
            testExitCode: 1,
            timestamp: now,
            synthesizedByGate: true,
          },
          green: {
            testCommand: cmd,
            testExitCode: 0,
            timestamp: now,
            synthesizedByGate: true,
          },
        },
      ],
    };
  }

  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Dispatch-advance gate for the implement step.
 *
 * @param {string} safeName - Sanitized ticket ID
 * @param {object} ctx - Context from work-next.js
 * @param {object} deps - Dependencies injected from work-next.js
 * @returns {null | { recurse: true }} - null=no action (re-dispatch), recurse=re-run orchestrator
 */
function dispatchAdvanceGate(safeName, ctx, deps) {
  const {
    loadWorkState,
    saveWorkState,
    readTddEvidence,
    validateTddEvidence,
    stepName,
    workDir,
    log,
    recursionDepth,
  } = deps;

  const ws = loadWorkState(safeName);
  if (!ws?.tasksMeta || !Array.isArray(ws.tasksMeta.tasks)) {
    return null;
  }

  const currentIdx = ws.tasksMeta.currentTaskIndex ?? 0;
  const totalTasks = ws.tasksMeta.tasks.length;
  const taskNum = currentIdx + 1; // 1-indexed

  // Check task type BEFORE evidence — checkpoint tasks are exempt from TDD entirely
  const taskType = resolveTaskType(ctx.tasksDir, taskNum);
  if (taskType === 'checkpoint') {
    // Checkpoints don't need TDD evidence — skip directly to advance
    // (checkpoint tasks verify, they don't implement)
  } else {
    // Non-checkpoint: check evidence exists AND is valid
    // Use ctx.tasksDir-derived TASKS_BASE (not the global one which points to plugin dir)
    const gateTasksBase = ctx.tasksDir ? path.dirname(ctx.tasksDir) : null;
    const tddEnforcement = require(
      path.join(__dirname, '..', '..', '..', 'work', 'tdd-enforcement')
    );
    let { exists, evidence } = gateTasksBase
      ? tddEnforcement.readTddEvidence(gateTasksBase, safeName, stepName, taskNum)
      : readTddEvidence(safeName, stepName, taskNum);

    // PRE-IMPLEMENT (gate-driven authentic RED capture).
    // Run once per task, before the first dispatch attempt. The marker
    // _preTestForTask prevents re-running the pre-test on every gate pass.
    const preTestMarker = `${taskNum}`;
    const preTestDone = ws._preTestForTask === preTestMarker;
    if (!exists && !preTestDone && ctx.tasksDir) {
      const testCmd = readTaskTestCommand(ctx.tasksDir, taskNum);
      if (testCmd) {
        const workingDir = ctx.worktreeDir || (ws.worktreeDir ? ws.worktreeDir : process.cwd());
        const runEnv = gateTasksBase ? { ...process.env, TASKS_BASE: gateTasksBase } : process.env;
        const pre = runPreImplementTest(
          testCmd,
          safeName,
          taskNum,
          workingDir,
          runEnv,
          gateTasksBase,
          taskType
        );
        ws._preTestForTask = preTestMarker;
        saveWorkState(safeName, ws);

        if (pre.decision === 'block') {
          ws._tddRetryReason = pre.reason;
          ws._tddRetryCount = (ws._tddRetryCount || 0) + 1;
          saveWorkState(safeName, ws);
          return null;
        }
        // dispatch — re-read evidence (RED may have just been written)
        const reread = gateTasksBase
          ? tddEnforcement.readTddEvidence(gateTasksBase, safeName, stepName, taskNum)
          : readTddEvidence(safeName, stepName, taskNum);
        exists = reread.exists;
        evidence = reread.evidence;
      }
    }

    // POST-IMPLEMENT: after agent has run, re-run the test command. On pass,
    // append GREEN to the existing cycle (or synthesize one if pre-test was
    // skipped). Stop hooks don't fire for plugin subagents (Anthropic bug
    // #29767), so the gate is the only reliable place to record GREEN.
    if (ctx.tasksDir) {
      const testCmd = readTaskTestCommand(ctx.tasksDir, taskNum);
      const needsGreen = !exists || !Array.isArray(evidence?.cycles) || !evidence.cycles[0]?.green;
      if (testCmd && needsGreen) {
        const workingDir = ctx.worktreeDir || (ws.worktreeDir ? ws.worktreeDir : process.cwd());
        const runEnv = gateTasksBase ? { ...process.env, TASKS_BASE: gateTasksBase } : process.env;
        const passed = runTestAndRecord(
          testCmd,
          safeName,
          taskNum,
          workingDir,
          runEnv,
          gateTasksBase
        );
        if (passed) {
          const reread = gateTasksBase
            ? tddEnforcement.readTddEvidence(gateTasksBase, safeName, stepName, taskNum)
            : readTddEvidence(safeName, stepName, taskNum);
          exists = reread.exists;
          evidence = reread.evidence;
        }
      }
    }

    if (!exists) {
      ws._tddRetryReason = `No TDD evidence found at task${taskNum}/tdd-phase.json. You MUST run the TDD phase commands before this task can advance.`;
      ws._tddRetryCount = (ws._tddRetryCount || 0) + 1;
      saveWorkState(safeName, ws);
      return null;
    }

    const isTestOnly = taskType === 'test';

    if (isTestOnly) {
      // Accept any evidence (even RED-only) for test tasks.
      // Also accept exception evidence (e.g., config-only, mechanical-refactor).
      const hasAnyCycle = Array.isArray(evidence?.cycles) && evidence.cycles.length > 0;
      const hasException = evidence?.currentPhase === 'exception' && evidence?.exception;
      if (!hasAnyCycle && !hasException) {
        ws._tddRetryReason = `TDD evidence exists but has no cycles or exception. Record at least one RED phase or use exception mode.`;
        ws._tddRetryCount = (ws._tddRetryCount || 0) + 1;
        saveWorkState(safeName, ws);
        return null;
      }
    } else {
      const validation = validateTddEvidence(evidence);
      if (!validation.valid) {
        ws._tddRetryReason = `TDD evidence invalid: ${validation.reason}`;
        ws._tddRetryCount = (ws._tddRetryCount || 0) + 1;
        saveWorkState(safeName, ws);
        return null;
      }
    }
  }

  // Evidence valid — clear retry state
  delete ws._tddRetryReason;
  delete ws._tddRetryCount;
  saveWorkState(safeName, ws);

  // Derive TASKS_BASE from ctx.tasksDir for subprocess calls.
  // The gate runs in the plugin's process context, but the ticket's tasks
  // may be in a different project (e.g., worktree). ctx.tasksDir is the
  // correct path — extract TASKS_BASE by removing the ticket subfolder.
  const gateTASKS_BASE = ctx.tasksDir ? path.dirname(ctx.tasksDir) : process.env.TASKS_BASE;
  const gateExecEnv = gateTASKS_BASE ? { ...process.env, TASKS_BASE: gateTASKS_BASE } : process.env;

  // Evidence valid — check if more tasks remain
  if (currentIdx < totalTasks - 1) {
    try {
      execFileSync(
        process.execPath,
        [path.join(workDir, 'work-state.js'), 'task-advance', safeName],
        { encoding: 'utf-8', timeout: 5000, stdio: 'pipe', env: gateExecEnv }
      );
      // Clear dispatched marker so the new task gets dispatched fresh
      const ws2 = loadWorkState(safeName);
      if (ws2) {
        delete ws2._work2Dispatched;
        delete ws2._work2DispatchedAction;
        delete ws2._preTestForTask;
        saveWorkState(safeName, ws2);
      }
      // Update tasks.md checkboxes
      if (ctx.tasksDir) {
        try {
          markProgress(ctx.tasksDir);
        } catch {
          /* fail-open */
        }
      }
      if (log) {
        log.recurse(recursionDepth, `task-advance ${currentIdx + 1} → ${currentIdx + 2}`);
      }
      return { recurse: true };
    } catch {
      return null;
    }
  }

  // All tasks done with valid evidence — mark last task completed and update checkboxes.
  // Without this, the last task stays with status !== 'completed' in tasksMeta because
  // task-advance only runs for non-last tasks (currentIdx < totalTasks - 1 branch above).
  // The complete step's guard at work-state.js:278 correctly blocks if any task isn't
  // marked completed — so we must record the bookkeeping here.
  try {
    execFileSync(
      process.execPath,
      [path.join(workDir, 'work-state.js'), 'task-advance', safeName],
      { encoding: 'utf-8', timeout: 5000, stdio: 'pipe', env: gateExecEnv }
    );
  } catch {
    /* fail-open — task-advance returns { done: true } for last task, which is fine */
  }
  if (ctx.tasksDir) {
    try {
      markProgress(ctx.tasksDir);
    } catch {
      /* fail-open */
    }
  }
  return null;
}

module.exports = { dispatchAdvanceGate, runPreImplementTest, runTestAndRecord };
