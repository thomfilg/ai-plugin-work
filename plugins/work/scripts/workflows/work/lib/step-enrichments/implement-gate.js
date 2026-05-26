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
const { parseTasks } = require(path.join(__dirname, '..', 'task-graph'));

/**
 * Reconcile `ws.tasksMeta` against the current tasks.md.
 *
 * When tasks.md is edited mid-workflow (e.g. tasks_gate repair drops a task),
 * `tasksMeta.tasks` keeps the stale entries and the gate then demands TDD
 * evidence for a task that no longer exists. Truncate the tail to match the
 * file when — AND ONLY WHEN — all dropped entries are still pending (never
 * silently drop completed work).
 *
 * Returns true when state was mutated and saved.
 */
function reconcileTasksMetaWithFile(ws, tasksDir, saveWorkState, safeName, log) {
  if (!tasksDir) return false;
  if (!ws?.tasksMeta || !Array.isArray(ws.tasksMeta.tasks)) return false;

  let parsed;
  try {
    parsed = parseTasks(tasksDir);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return false;

  const fileCount = parsed.length;
  const stateCount = ws.tasksMeta.tasks.length;
  if (fileCount >= stateCount) return false;

  // Only truncate when EVERY tail entry past fileCount is non-completed.
  // Dropping completed entries would lose evidence of done work.
  const tail = ws.tasksMeta.tasks.slice(fileCount);
  const allTailPending = tail.every((t) => t && t.status !== 'completed');
  if (!allTailPending) return false;

  ws.tasksMeta.tasks = ws.tasksMeta.tasks.slice(0, fileCount);
  if (typeof ws.tasksMeta.totalTasks === 'number') {
    ws.tasksMeta.totalTasks = fileCount;
  }
  if ((ws.tasksMeta.currentTaskIndex ?? 0) > fileCount) {
    ws.tasksMeta.currentTaskIndex = fileCount;
  }

  // Clear stale retry state that pointed at a now-missing task.
  if (typeof ws._tddRetryTask === 'number' && ws._tddRetryTask > fileCount) {
    delete ws._tddRetryReason;
    delete ws._tddRetryCount;
    delete ws._tddRetryCommand;
    delete ws._tddRetryExitCode;
    delete ws._tddRetryOutputTail;
    delete ws._tddRetryTask;
  }
  if (ws._preTestForTask !== undefined && ws._preTestForTask !== null) {
    const preTestNum = Number(ws._preTestForTask);
    if (Number.isFinite(preTestNum) && preTestNum > fileCount) {
      delete ws._preTestForTask;
    }
  }

  try {
    saveWorkState(safeName, ws);
  } catch {
    return false;
  }
  if (typeof log === 'function') {
    try {
      log(
        `tasksMeta reconciled with tasks.md: ${stateCount} → ${fileCount} (dropped ${stateCount - fileCount} pending tail entr${stateCount - fileCount === 1 ? 'y' : 'ies'})`
      );
    } catch {
      /* fail-open */
    }
  }
  return true;
}

/**
 * Persist the full stdout+stderr of a test run alongside its tdd-phase.json.
 *
 * Writes `task<N>/logs/<phase>-<timestamp>.log` with a small header (command,
 * exit code, timestamp) so the file is self-describing if opened directly.
 * The JSON evidence only carries `outputTail` (small slice) plus a pointer
 * to this file via `logPath` / `logBytes`, keeping tdd-phase.json compact.
 *
 * Retention: keep at most LOG_RETENTION_COUNT files per `logs/` dir. Older
 * files are deleted on each write — bounded growth even on long retry loops.
 *
 * Fail-open: any IO error returns null and the caller proceeds with only
 * the in-JSON outputTail, matching the rest of this module's policy.
 *
 * @param {string} taskDir - Absolute path to `tasks/<TICKET>/task<N>/`
 * @param {string} phase - 'red' | 'green'
 * @param {string} cmd - The test command that ran
 * @param {number|null} exitCode
 * @param {string} output - Combined stdout+stderr
 * @param {string} nowIso - ISO timestamp matching evidence timestamp
 * @returns {{ logPath: string, logBytes: number } | null}
 *   logPath is relative to taskDir, e.g. `logs/red-2026-05-14T11-22-33-000Z.log`
 */
const LOG_RETENTION_COUNT = 6;
function writeTestLog(taskDir, phase, cmd, exitCode, output, nowIso) {
  try {
    if (!taskDir || !phase || output == null) return null;
    const logsDir = path.join(taskDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    // Filename-safe timestamp (colons break on Windows).
    const stamp = String(nowIso).replace(/[:.]/g, '-');
    const filename = `${phase}-${stamp}.log`;
    const fullPath = path.join(logsDir, filename);
    const header =
      `# command: ${cmd}\n` +
      `# exitCode: ${exitCode == null ? 'null' : exitCode}\n` +
      `# timestamp: ${nowIso}\n` +
      `# phase: ${phase}\n` +
      `${'-'.repeat(72)}\n`;
    const body = String(output);
    fs.writeFileSync(fullPath, header + body);

    // Prune oldest entries (by lexicographic name; ISO stamps sort correctly).
    try {
      const entries = fs
        .readdirSync(logsDir)
        .filter((f) => f.endsWith('.log'))
        .sort();
      const excess = entries.length - LOG_RETENTION_COUNT;
      for (let i = 0; i < excess; i++) {
        try {
          fs.unlinkSync(path.join(logsDir, entries[i]));
        } catch {
          /* fail-open */
        }
      }
    } catch {
      /* fail-open */
    }

    return {
      logPath: path.join('logs', filename),
      logBytes: Buffer.byteLength(header) + Buffer.byteLength(body),
    };
  } catch {
    return null;
  }
}

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
      ''
    );
    const sectionMatch = content.match(sectionRe);
    if (!sectionMatch) return null;
    return extractTestCommandFromSection(sectionMatch[0]);
  } catch {
    return null;
  }
}

/**
 * Extract the actual test command from a `### Test Command` section.
 *
 * Handles three common authoring styles:
 *   - bare line:        `pnpm test foo.spec.ts`
 *   - inline code:      `` `pnpm test foo.spec.ts` ``
 *   - fenced block:     ``` ```bash\npnpm test foo.spec.ts\n``` ```
 *
 * Strips backticks/code-fence markers, skips empty lines and shell comments,
 * and concatenates multi-line commands joined by trailing `\` continuations.
 *
 * @param {string} section - The full task section text containing `### Test Command`.
 * @returns {string|null}
 */
function extractTestCommandFromSection(section) {
  const headingIdx = section.search(/### Test Command[^\n]*\n/);
  if (headingIdx < 0) return null;
  const afterHeading = section.slice(headingIdx).split('\n').slice(1); // drop the heading line itself
  const cmdLines = [];
  let inFence = false;
  for (const raw of afterHeading) {
    // Stop at the next subsection / horizontal rule / new task heading
    if (/^### /.test(raw) || /^## /.test(raw) || /^---\s*$/.test(raw)) break;
    const line = raw.trimEnd();
    // Toggle fenced code blocks
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue; // shell comment / markdown comment
    // Strip surrounding inline-code backticks: `cmd` → cmd
    const stripped = trimmed.replace(/^`+|`+$/g, '').trim();
    if (!stripped) continue;
    // Skip parser artefacts that would silently `execSync` to garbage.
    if (/^(?:bash|sh|zsh|fish|node|python|python3)\s*$/i.test(stripped)) continue;
    if (/^[`]+$/.test(stripped)) continue;
    cmdLines.push(stripped);
    // Stop on the first non-continuation line (no trailing backslash)
    if (!stripped.endsWith('\\')) break;
  }
  if (cmdLines.length === 0) return null;
  return cmdLines.map((l) => l.replace(/\\$/, '').trim()).join(' ');
}

/**
 * TDD is required for every task type EXCEPT the exemption list below. The
 * previous design (`TDD_REQUIRED_TYPES` allowlist) let agents self-exempt
 * via the `### Type` field in tasks.md — labelling a task "frontend" or
 * "infrastructure" caused the gate to record a skip stub and let the task
 * pass without an authentic RED. Inverting the list closes that bypass.
 *
 * `checkpoint` is the only legitimate exemption: checkpoint tasks verify
 * the work of other tasks and have no implementation of their own.
 */
const TDD_EXEMPT_TYPES = new Set(['checkpoint']);

function isTddRequired(taskType) {
  if (!taskType) return true;
  return !TDD_EXEMPT_TYPES.has(String(taskType).toLowerCase());
}

/**
 * Detect a `### Test Command` value that the parser leaked from markdown
 * formatting (fenced-block fragment, bare shell name, unmatched backtick).
 * These would `execSync` silently and starve the gate of a real exit code,
 * causing infinite re-dispatch — return a clear block reason instead.
 *
 * @param {string} cmd
 * @returns {string|null} reason if malformed, null if usable
 */
function detectMalformedTestCommand(cmd) {
  const raw = String(cmd || '').trim();
  if (!raw) return 'empty';
  // Bare shell launchers with no arguments — the parser dropped the body
  if (/^(?:bash|sh|zsh|fish|node|python|python3)\s*$/i.test(raw)) return 'bare-interpreter';
  // Pure backtick / fence remnants
  if (/^[`]+$/.test(raw)) return 'backticks-only';
  // Markdown fence opener that survived (must come before the broader
  // stray-backtick check, which would otherwise match first and label
  // ```bash as a "stray-backtick").
  if (/^```/.test(raw)) return 'fence-opener';
  // Starts/ends with a stray backtick (parser failed to strip a partial fence)
  if (/^`/.test(raw) || /`$/.test(raw)) return 'stray-backtick';
  return null;
}

function evidencePathFor(gateTasksBase, safeName, taskNum) {
  return path.join(gateTasksBase, safeName, `task${taskNum}`, 'tdd-phase.json');
}

/**
 * Detect whether a test command targets E2E (Playwright) tests.
 * Used by the WORK_SKIP_E2E env var to bypass slow E2E runs in pre/post-test.
 */
function isE2eCommand(cmd) {
  if (!cmd) return false;
  return /\bTEST_E2E_COMMAND\b|\bpnpm\s+(?:run\s+)?(?:test:)?e2e\b|\bplaywright\b|\bpw\s+test\b/i.test(
    cmd
  );
}

/**
 * Should the gate skip executing this test command?
 * Currently: WORK_SKIP_E2E=1 (or WORK_SKIP_E2E_TESTS=1) skips E2E commands.
 */
function shouldSkipTestExecution(cmd, env) {
  const e = env || process.env;
  const skipE2e = e.WORK_SKIP_E2E === '1' || e.WORK_SKIP_E2E_TESTS === '1';
  if (skipE2e && isE2eCommand(cmd)) return 'e2e-disabled';
  return null;
}

/**
 * Write a skip-stub TDD evidence file when test execution is bypassed.
 * Records a complete cycle so the gate can advance — note explains why.
 */
function writeSkipStubEvidence(cmd, safeName, taskNum, gateTasksBase, reason) {
  const evidencePath = evidencePathFor(gateTasksBase, safeName, taskNum);
  const taskDir = path.dirname(evidencePath);
  const now = new Date().toISOString();
  const note = `Test execution skipped by gate (reason: ${reason}).`;
  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          currentPhase: 'refactor',
          currentCycle: 1,
          cycles: [
            {
              cycle: 1,
              red: {
                testCommand: cmd,
                testExitCode: 0,
                timestamp: now,
                capturedByGate: true,
                skippedByGate: true,
                note,
              },
              green: {
                testCommand: cmd,
                testExitCode: 0,
                timestamp: now,
                capturedByGate: true,
                skippedByGate: true,
                note,
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
    return {
      decision: 'block',
      reason:
        `Test command for task ${taskNum} is malformed in tasks.md ` +
        `(parser returned: ${JSON.stringify(String(cmd || '').slice(0, 120))}, ` +
        `category: ${malformed}). ` +
        `Open tasks.md and fix the \`### Test Command\` section under "## Task ${taskNum}". ` +
        `Use a single shell command on its own line, optionally inside a fenced \`\`\`bash\`\`\` block.`,
      command: String(cmd || ''),
      exitCode: null,
      outputTail: '',
    };
  }

  // Honor WORK_SKIP_E2E=1 / WORK_SKIP_E2E_TESTS=1 — record a skip stub and
  // dispatch (or just advance, since the post-test will also skip).
  const skipReason = shouldSkipTestExecution(cmd, env);
  if (skipReason) {
    writeSkipStubEvidence(cmd, safeName, taskNum, gateTasksBase, skipReason);
    return { decision: 'dispatch', preTestSkipped: true, skipReason };
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
        command: cmd,
        exitCode: 0,
        outputTail: String(output).slice(-4000),
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

  // Pre-test FAILED — authentic RED. Phase is 'red' until the post-implement
  // test passes and runTestAndRecord transitions it to 'green'.
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
  // Detect malformed parser output up front — return a structured failure so
  // the gate can surface a clear "fix tasks.md" reason instead of "no GREEN".
  const malformed = detectMalformedTestCommand(cmd);
  if (malformed) {
    return {
      passed: false,
      malformed,
      command: String(cmd || ''),
      exitCode: null,
      outputTail: '',
    };
  }

  // Honor WORK_SKIP_E2E=1 / WORK_SKIP_E2E_TESTS=1 — write skip stub and pass.
  const skipReason = shouldSkipTestExecution(cmd, env);
  if (skipReason && gateTasksBase) {
    writeSkipStubEvidence(cmd, safeName, taskNum, gateTasksBase, skipReason);
    return { passed: true, skipped: skipReason };
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
    exitCode = err.status ?? 1;
    output = (err.stdout || '') + (err.stderr || '');
  }

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
                outputTail: String(output).slice(-2000),
                ...(greenLog ? { logPath: greenLog.logPath, logBytes: greenLog.logBytes } : {}),
              },
            }
          : c
      ),
    };
  } else {
    // No prior RED evidence. The pre-implement test path is the ONLY way to
    // produce authentic RED — synthesizing a fake RED+GREEN at the same
    // timestamp would let any passing post-test approve a task that was
    // never test-driven (the bug that produced ECHO-4612/task2,
    // ECHO-4614/task3, ECHO-4614/task4 evidence). Refuse the GREEN and
    // surface the gap so the orchestrator routes back through pre-test.
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
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
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

  // Reconcile tasksMeta with tasks.md before reading currentIdx/totalTasks.
  // Mid-workflow tasks.md edits (e.g. tasks_gate repair shrinks the task list)
  // would otherwise leave stale pending entries and the gate would loop asking
  // for TDD evidence of a task that no longer exists in tasks.md.
  reconcileTasksMetaWithFile(ws, ctx && ctx.tasksDir, saveWorkState, safeName, log);

  const currentIdx = ws.tasksMeta.currentTaskIndex ?? 0;
  const totalTasks = ws.tasksMeta.tasks.length;
  const taskNum = currentIdx + 1; // 1-indexed

  // Guard: when all tasks are done, currentIdx may be incremented past the
  // last task by the final task-advance below. On subsequent gate passes
  // (e.g. when the workflow has moved to the commit step), don't validate
  // an out-of-bounds task — that would generate bogus "--task <total+1>"
  // retry instructions. Clear any stale retry state and exit.
  if (currentIdx >= totalTasks) {
    if (ws._tddRetryReason || ws._tddRetryCount || ws._preTestForTask) {
      delete ws._tddRetryReason;
      delete ws._tddRetryCount;
      delete ws._tddRetryCommand;
      delete ws._tddRetryExitCode;
      delete ws._tddRetryOutputTail;
      delete ws._tddRetryTask;
      delete ws._preTestForTask;
      saveWorkState(safeName, ws);
    }
    return null;
  }

  // Helper: persist retry-failure context so the next dispatch prompt can
  // surface the exact command, exit code, and output to the agent. The
  // _tddRetryTask field scopes the retry block to a specific task number;
  // parallel-dispatch delegates check this to avoid showing one task's
  // failure to other tasks' agents.
  const recordRetry = (reason, extras) => {
    ws._tddRetryReason = reason;
    ws._tddRetryCount = (ws._tddRetryCount || 0) + 1;
    ws._tddRetryCommand = extras?.command || null;
    ws._tddRetryExitCode = extras?.exitCode ?? null;
    ws._tddRetryOutputTail = extras?.outputTail || '';
    ws._tddRetryTask = taskNum;
    saveWorkState(safeName, ws);
  };

  // Check task type BEFORE evidence — checkpoint tasks are exempt from TDD entirely
  const taskType = resolveTaskType(ctx.tasksDir, taskNum);
  if (taskType === 'checkpoint') {
    // Checkpoint tasks verify, they don't implement — advance immediately.
    // Falling through to the shared "evidence valid → maybe-recurse" path is
    // unreliable for checkpoints because the gate's recursion can be cut
    // short between the upstream task's advance (which clears the dispatched
    // marker) and the checkpoint task's own gate pass. Result: implement
    // step transitions to commit while the checkpoint task is still
    // status:'pending', then `completeWork` blocks the terminal step (see
    // ECHO-4581). Advancing here, in this gate pass, short-circuits the
    // race and keeps tasksMeta consistent with the workflow's forward
    // progress.
    const gateTASKS_BASE = ctx.tasksDir ? path.dirname(ctx.tasksDir) : process.env.TASKS_BASE;
    const gateExecEnv = gateTASKS_BASE
      ? { ...process.env, TASKS_BASE: gateTASKS_BASE }
      : process.env;
    try {
      execFileSync(
        process.execPath,
        [path.join(workDir, 'work-state.js'), 'task-advance', safeName],
        { encoding: 'utf-8', timeout: 5000, stdio: 'pipe', env: gateExecEnv }
      );
    } catch {
      /* fail-open — surfaced via completeWork's terminal guard if it really failed */
    }
    // Clear dispatch markers so the next pass dispatches fresh (mirrors the
    // non-last-task branch below).
    const ws2 = loadWorkState(safeName);
    if (ws2) {
      delete ws2._work2Dispatched;
      delete ws2._work2DispatchedAction;
      delete ws2._preTestForTask;
      saveWorkState(safeName, ws2);
    }
    if (ctx.tasksDir) {
      try {
        markProgress(ctx.tasksDir);
      } catch {
        /* fail-open */
      }
    }
    if (log) {
      log.recurse(recursionDepth, `checkpoint advance ${currentIdx + 1} (skipped TDD evidence)`);
    }
    // If checkpoint was the last task, return null so work-next.js can
    // transition implement → commit. Otherwise return recurse so the next
    // task gets dispatched.
    if (currentIdx >= totalTasks - 1) return null;
    return { recurse: true };
  } else {
    // Non-checkpoint: check evidence exists AND is valid
    // Use ctx.tasksDir-derived TASKS_BASE (not the global one which points to plugin dir)
    const gateTasksBase = ctx.tasksDir ? path.dirname(ctx.tasksDir) : null;
    const tddEnforcement = require(
      path.join(__dirname, '..', '..', '..', 'work', 'lib', 'tdd-enforcement')
    );
    let { exists, evidence } = gateTasksBase
      ? tddEnforcement.readTddEvidence(gateTasksBase, safeName, stepName, taskNum)
      : readTddEvidence(safeName, stepName, taskNum);

    // PRE-IMPLEMENT (gate-driven authentic RED capture).
    // Run once per task, before the first dispatch attempt. The marker
    // _preTestForTask prevents re-running the pre-test on every gate pass.
    const preTestMarker = `${taskNum}`;
    const preTestDone = ws._preTestForTask === preTestMarker;
    // "Has usable RED" = evidence file exists AND has a cycle with red entry.
    // An empty/init-only tdd-phase.json (cycles: []) does NOT count — the gate
    // must run the pre-test to capture authentic RED instead of getting stuck.
    const hasUsableRed =
      exists &&
      Array.isArray(evidence?.cycles) &&
      evidence.cycles.length > 0 &&
      evidence.cycles[0]?.red;
    if (!hasUsableRed && !preTestDone && ctx.tasksDir) {
      const testCmd = readTaskTestCommand(ctx.tasksDir, taskNum);
      if (testCmd) {
        const workingDir = ctx.worktreeDir || (ws.worktreeDir ? ws.worktreeDir : process.cwd());
        // Gate D' — gherkin @test:<path> existence check.
        // Before running the test command, verify that every test file
        // declared in gherkin.feature for this task actually exists on
        // disk. This catches the "agent renames source out then in" /
        // "tests/<path>.tsx never existed" patterns that previously
        // produced testFiles:[] + synthesizedByGate evidence. The check
        // is opt-in: tickets whose gherkin.feature has no @test tags
        // (legacy or trivial) skip silently.
        try {
          const gherkinPath = path.join(ctx.tasksDir, 'gherkin.feature');
          if (fs.existsSync(gherkinPath)) {
            const { findMissingTestFiles, collectTaskTestPaths } = require(
              path.join(__dirname, '..', 'gherkin-task-refs.js')
            );
            const gherkinText = fs.readFileSync(gherkinPath, 'utf8');
            const allRefs = collectTaskTestPaths({ gherkinText }, taskNum);
            if (allRefs.length > 0) {
              const { missing } = findMissingTestFiles(
                { gherkinText, worktreeDir: workingDir },
                taskNum
              );
              if (missing.length > 0) {
                recordRetry(
                  `Task ${taskNum} cannot enter RED — gherkin.feature declares @test files that do not exist on disk: ${missing.join(', ')}. Create the failing test file(s) first, then re-run the gate.`,
                  { command: testCmd, exitCode: null, outputTail: missing.join('\n') }
                );
                return null;
              }
            }
          }
        } catch {
          /* fail-open — gherkin parse failure shouldn't deadlock the gate */
        }
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
          recordRetry(pre.reason, {
            command: pre.command || testCmd,
            exitCode: pre.exitCode,
            outputTail: pre.outputTail,
          });
          return null;
        }
        // The pre-test just ran on this gate pass. Return now — DO NOT fall
        // through to the post-implement test on the same call. Otherwise the
        // gate would record GREEN immediately (especially for tasks whose
        // pre-test passes, e.g. non-TDD types) and auto-advance the task
        // without ever dispatching the implementation agent. The next gate
        // pass (after the agent has run) will skip this branch (preTestDone
        // is now true) and run the post-implement test.
        return null;
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
        const result = runTestAndRecord(
          testCmd,
          safeName,
          taskNum,
          workingDir,
          runEnv,
          gateTasksBase
        );
        if (result && result.passed) {
          const reread = gateTasksBase
            ? tddEnforcement.readTddEvidence(gateTasksBase, safeName, stepName, taskNum)
            : readTddEvidence(safeName, stepName, taskNum);
          exists = reread.exists;
          evidence = reread.evidence;
        } else if (result && result.noRedEvidence) {
          // GREEN ran cleanly but no authentic RED was captured. Clear the
          // pre-test marker so the next gate pass runs the pre-implement
          // test again — if the agent already modified source, that pre-test
          // will pass and the gate will block with "test passed; write a
          // failing test first," forcing a real RED cycle.
          delete ws._preTestForTask;
          saveWorkState(safeName, ws);
          recordRetry(
            `No authentic RED evidence for task ${taskNum}. The gate refuses to synthesize a TDD cycle — write a failing test FIRST, commit the failure (gate will capture it), then implement.`,
            { command: result.command, exitCode: result.exitCode ?? 0, outputTail: '' }
          );
          return null;
        } else if (result && result.malformed) {
          recordRetry(
            `Test command for task ${taskNum} is malformed in tasks.md ` +
              `(parser returned: ${JSON.stringify(String(result.command || '').slice(0, 120))}, ` +
              `category: ${result.malformed}). ` +
              `Open tasks.md and fix the \`### Test Command\` section under "## Task ${taskNum}".`,
            { command: result.command, exitCode: null, outputTail: '' }
          );
          return null;
        } else if (result && result.passed === false) {
          // Post-test ran and failed — capture the command + exit + tail so
          // the next dispatch prompt can show the agent EXACTLY what broke.
          recordRetry(
            `Post-implement test for task ${taskNum} failed (exit ${result.exitCode}). Fix the source so the command below passes.`,
            {
              command: result.command,
              exitCode: result.exitCode,
              outputTail: result.outputTail,
            }
          );
          return null;
        }
      }
    }

    if (!exists) {
      recordRetry(
        `No TDD evidence found at task${taskNum}/tdd-phase.json. The gate will record evidence by running the task's \`### Test Command\` — if you keep seeing this, the test command is missing or unrunnable in tasks.md under "## Task ${taskNum}".`,
        {}
      );
      return null;
    }

    const isTestOnly = taskType === 'test';

    if (isTestOnly) {
      // Accept any evidence (even RED-only) for test tasks.
      // Also accept exception evidence (e.g., config-only, mechanical-refactor).
      const hasAnyCycle = Array.isArray(evidence?.cycles) && evidence.cycles.length > 0;
      const hasException = evidence?.currentPhase === 'exception' && evidence?.exception;
      if (!hasAnyCycle && !hasException) {
        recordRetry(
          `TDD evidence exists but has no cycles or exception. Gate will retry by running the task's \`### Test Command\`.`,
          {}
        );
        return null;
      }
    } else {
      const validation = validateTddEvidence(evidence);
      if (!validation.valid) {
        recordRetry(`TDD evidence invalid: ${validation.reason}`, {});
        return null;
      }
    }
  }

  // Evidence valid — clear retry state
  delete ws._tddRetryReason;
  delete ws._tddRetryCount;
  delete ws._tddRetryCommand;
  delete ws._tddRetryExitCode;
  delete ws._tddRetryOutputTail;
  delete ws._tddRetryTask;
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

module.exports = {
  dispatchAdvanceGate,
  runPreImplementTest,
  runTestAndRecord,
  isE2eCommand,
  shouldSkipTestExecution,
  writeSkipStubEvidence,
};
