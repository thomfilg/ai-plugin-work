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
 * TDD-exemption taxonomy — single source of truth is the planner's closed
 * `### Type` enum in skills/split-in-tasks/lib/task-types.js (TDD_EXEMPT =
 * tests-only, docs, config, ci, mechanical-refactor, file-move, checkpoint).
 * The gate must apply the SAME contract the planner declared; a local copy
 * here previously diverged (only `checkpoint` was exempt), wedging docs/
 * config/ci tasks whose verifier passes before implementation.
 *
 * Unknown / freeform Type values stay TDD-required (fail closed) — agents
 * must not be able to self-exempt by inventing a Type, matching
 * gateContractFor()'s strictest-contract fallback.
 */
const { isTddExempt } = require(
  path.join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    'skills',
    'split-in-tasks',
    'lib',
    'task-types'
  )
);

function isTddRequired(taskType) {
  return !isTddExempt(taskType);
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
 *
 * Bypass review (W11 follow-up): this is an OPERATOR env choice, so it is
 * read from the orchestrator's own `process.env` ONLY — never from the
 * `.envrc`-merged run env (`buildRunEnv` folds the agent-writable worktree
 * `.envrc` in with `.envrc` values winning, so an agent exporting
 * WORK_SKIP_E2E there could otherwise convert every e2e task into a
 * fabricated full-cycle skip stub).
 */
function shouldSkipTestExecution(cmd) {
  const e = process.env;
  const skipE2e = e.WORK_SKIP_E2E === '1' || e.WORK_SKIP_E2E_TESTS === '1';
  if (skipE2e && isE2eCommand(cmd)) return 'e2e-disabled';
  return null;
}

// W11 — the ONE gate evidence writer (atomic writes; recorder-parity traps;
// the WORK_SKIP_E2E stub is audit-logged as `tdd-e2e-skip-stub`).
const { writeGateStub } = require(
  path.join(__dirname, '..', '..', '..', '..', 'work-implement', 'tdd-phase-state', 'gate-writer')
);

/**
 * Write a skip-stub TDD evidence file when test execution is bypassed
 * (operator env choice: WORK_SKIP_E2E=1). Records a complete FABRICATED
 * cycle so the gate can advance — written via the shared gate writer, which
 * appends a `tdd-e2e-skip-stub` audit row to `.work-actions.json` so the
 * fabrication is visible, not silent.
 */
function writeSkipStubEvidence(cmd, safeName, taskNum, gateTasksBase, reason) {
  const evidencePath = evidencePathFor(gateTasksBase, safeName, taskNum);
  try {
    writeGateStub({
      stubKind: 'e2e-skip',
      tasksBase: gateTasksBase,
      ticketId: safeName,
      taskNum,
      evidencePath,
      cmd,
      reason,
      now: new Date().toISOString(),
    });
  } catch {
    /* fail-open */
  }
}

/**
 * W3 — shared planner-defect reason for a malformed `### Test Strategy`
 * command, used by both the pre-implement (this module) and post-implement
 * (test-runner.js preflight) paths so the policy message stays identical:
 * name the defect, state tasks.md is planner-owned and locked, instruct
 * STOP + BLOCKED report — never suggest changing tasks.md.
 */
function malformedStrategyReason(cmd, taskNum, malformed) {
  return (
    `Test command for task ${taskNum} is malformed ` +
    `(parser returned: ${JSON.stringify(String(cmd || '').slice(0, 120))}, ` +
    `category: ${malformed}). The \`### Test Strategy\` block cannot produce ` +
    'a runnable command — a planner defect. tasks.md is planner-owned and ' +
    'LOCKED during implement — do NOT edit it. STOP and report ' +
    `\`BLOCKED (planner-defect): malformed Test Strategy for task ${taskNum}\` ` +
    'back to the orchestrator.'
  );
}

/**
 * Build the block result for a malformed pre-implement test command.
 * Planner defect: `preTestIncomplete` keeps the pre-test marker unset so the
 * pre-test re-runs once the operator has corrected the strategy (W3 hold).
 */
function malformedPreTestBlock(cmd, taskNum, malformed) {
  return {
    decision: 'block',
    plannerDefect: true,
    // Statically re-checkable — planner-hold re-probes this predicate on
    // every gate pass and clears the hold when it stops reproducing.
    defectKind: 'malformed-strategy',
    preTestIncomplete: true,
    reason: malformedStrategyReason(cmd, taskNum, malformed),
    command: String(cmd || ''),
    exitCode: null,
    outputTail: '',
  };
}

/**
 * Record a skip-stub RED for a non-TDD task type whose pre-implement test
 * already passed, then allow dispatch. Written via the shared gate writer
 * (W11 — atomic, consistent shape).
 */
function recordNonTddPreTestStub(cmd, taskType, evidencePath, now) {
  try {
    writeGateStub({ stubKind: 'non-tdd-pre-test', evidencePath, cmd, taskType, now });
  } catch {
    /* fail-open */
  }
  return { decision: 'dispatch', preTestSkipped: true };
}

/**
 * Pre-implement command exited 0. For TDD-required types that is a block —
 * a failing test must exist before implementation. For TDD-exempt types the
 * gate records the non-TDD skip stub and dispatches (W2).
 */
function preTestPassOutcome({ cmd, taskNum, taskType, output, evidencePath, now }) {
  if (isTddRequired(taskType)) {
    return {
      decision: 'block',
      reason:
        `Pre-implement test for task ${taskNum} already passes (exit 0), but ` +
        `task type "${taskType || 'default'}" requires TDD — a failing test must ` +
        'exist before implementation. Author a failing test for the new behavior ' +
        'inside the task scope. If the work is already implemented and committed, ' +
        'run task-next.js with --resume-completed (machine-verified). If the ' +
        '`### Test Strategy` cannot exercise the new behavior, that is a planner ' +
        'defect: tasks.md is planner-owned and LOCKED during implement — do NOT ' +
        'edit it. STOP and report `BLOCKED (planner-defect): pre-implement test ' +
        `passes for TDD-required task ${taskNum}\` back to the orchestrator.`,
      command: cmd,
      exitCode: 0,
      outputTail: String(output).slice(-4000),
    };
  }
  return recordNonTddPreTestStub(cmd, taskType, evidencePath, now);
}

/**
 * W6 / GH-466 — block builders for an `eval "$VAR"` envelope command whose
 * var is unset/empty in the exact env the gate would run it with. `eval ""`
 * exits 0 instantly with zero output, so executing it would fabricate GREEN
 * evidence with no test run. W3 message policy: name the defect, state that
 * tasks.md is planner-owned and locked, instruct STOP + BLOCKED report —
 * never suggest editing tasks.md.
 */
function unsetEnvelopeReason(taskNum, varName) {
  return (
    `Test command for task ${taskNum} expands \`eval "$${varName}"\`, but ` +
    `$${varName} is unset or empty in the gate's run environment (no worktree ` +
    '`.envrc` value resolved). Executing it would no-op to exit 0 and record a ' +
    'false GREEN with zero output (GH-466), so the gate refuses to run it. ' +
    'This is a planner/environment defect: the `### Test Strategy` needs a ' +
    'runnable envelope, or the worktree `.envrc` must export the variable. ' +
    'tasks.md is planner-owned and LOCKED during implement — do NOT edit it. ' +
    'STOP and report `BLOCKED (planner-defect): test envelope $' +
    varName +
    ' unset in gate env` back to the orchestrator.'
  );
}

function unsetEnvelopeBlock(cmd, taskNum, varName) {
  return {
    decision: 'block',
    plannerDefect: true,
    // Statically re-checkable — the advertised remediation ("the worktree
    // `.envrc` must export the variable") lives OUTSIDE tasks.md, so the
    // tasks.md section hash alone could never clear this hold. planner-hold
    // re-runs detectUnsetEnvelopeCommand against the current run env on each
    // gate pass and clears the hold once the var resolves.
    defectKind: 'unset-envelope',
    preTestIncomplete: true,
    reason: unsetEnvelopeReason(taskNum, varName),
    command: String(cmd || ''),
    exitCode: null,
    outputTail: '',
  };
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
  malformedStrategyReason,
  malformedPreTestBlock,
  unsetEnvelopeReason,
  unsetEnvelopeBlock,
  recordNonTddPreTestStub,
  preTestPassOutcome,
  buildGreenEvidence,
};
