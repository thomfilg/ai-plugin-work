/**
 * TDD-evidence + run-log helpers for the implement gate.
 *
 * Pure-ish IO helpers split out of `test-runner.js` to keep each module within
 * the static-quality budget: run-log persistence/retention, skip-stub and
 * non-TDD-stub evidence writers, the GREEN-evidence builder, and small command
 * classifiers (E2E detection, skip policy, malformed-command block builder).
 */

'use strict';

const path = require('path');
const fs = require('fs');

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

    pruneOldLogs(logsDir);

    return {
      logPath: path.join('logs', filename),
      logBytes: Buffer.byteLength(header) + Buffer.byteLength(body),
    };
  } catch {
    return null;
  }
}

/** Prune oldest log entries (by lexicographic name; ISO stamps sort correctly). */
function pruneOldLogs(logsDir) {
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
  const stub = {
    testCommand: cmd,
    testExitCode: 0,
    timestamp: now,
    capturedByGate: true,
    skippedByGate: true,
    note,
  };
  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          currentPhase: 'refactor',
          currentCycle: 1,
          cycles: [{ cycle: 1, red: { ...stub }, green: { ...stub } }],
        },
        null,
        2
      )
    );
  } catch {
    /* fail-open */
  }
}

/** Build the block result for a malformed pre-implement test command. */
function malformedPreTestBlock(cmd, taskNum, malformed) {
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

/**
 * Record a skip-stub RED for a non-TDD task type whose pre-implement test
 * already passed, then allow dispatch.
 */
function recordNonTddPreTestStub(cmd, taskType, taskDir, evidencePath, now) {
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

/**
 * Build the GREEN-augmented evidence object from existing RED evidence, or
 * return { noRedEvidence: true } when no authentic RED was captured.
 */
function buildGreenEvidence(existing, cmd, output, now, greenLog) {
  if (!(existing && Array.isArray(existing.cycles) && existing.cycles[0]?.red)) {
    // No prior RED evidence. The pre-implement test path is the ONLY way to
    // produce authentic RED — synthesizing a fake RED+GREEN at the same
    // timestamp would let any passing post-test approve a task that was
    // never test-driven (the bug that produced ECHO-4612/task2,
    // ECHO-4614/task3, ECHO-4614/task4 evidence). Refuse the GREEN and
    // surface the gap so the orchestrator routes back through pre-test.
    return { noRedEvidence: true };
  }
  return {
    evidence: {
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
    },
  };
}

module.exports = {
  writeTestLog,
  isTddRequired,
  evidencePathFor,
  isE2eCommand,
  shouldSkipTestExecution,
  writeSkipStubEvidence,
  malformedPreTestBlock,
  recordNonTddPreTestStub,
  buildGreenEvidence,
};
