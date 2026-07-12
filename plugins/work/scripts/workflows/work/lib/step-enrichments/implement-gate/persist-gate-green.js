/**
 * persist-gate-green.js
 *
 * GREEN persistence for the implement gate, extracted from test-runner.js
 * (file-size burndown, GH-694). Builds + atomically writes the gate GREEN
 * for a passing post-implement run, preserving the pre-test RED entry
 * (refusing when none exists) and applying the shared writer's
 * recorder-parity traps: hang rejection, the RC-D empty-output rejection per
 * gateContractFor(taskType).rcdEmptyTrap, and (GH-694) the tests-only
 * changed-test-files rule — fed by the task's `### Files in scope` resolved
 * here via the shared task parser.
 */

'use strict';

const path = require('path');
const fs = require('fs');

const { writeTestLog, buildGreenEvidence } = require(path.join(__dirname, 'evidence'));

// W11 — the ONE gate evidence writer (atomic writes + recorder-parity traps).
const { writeGateGreen } = require(
  path.join(__dirname, '..', '..', '..', '..', 'work-implement', 'tdd-phase-state', 'gate-writer')
);

/**
 * GH-694: resolve the task's `### Files in scope` entries for the gate's
 * tests-only GREEN trap.
 *
 * PR #717: read/parse failures must NOT degrade to an empty scope — the
 * shared changed-test-files rule treats `[]` as "any changed test file
 * counts", so an unreadable/unparseable tasks.md would WIDEN the gate for a
 * tests-only task. Returns `{ scope }` only when tasks.md parsed AND the
 * task block exists (a parsed task with no declared scope keeps the
 * recorder's legacy empty-scope semantics); every failure shape returns
 * `{ error }` so writeGateGreen rejects tests-only GREENs fail-closed.
 */
function resolveTaskScope(gateTasksBase, safeName, taskNum) {
  try {
    const { parseTasks } = require(path.join(__dirname, '..', '..', 'task-parser'));
    const tasks = parseTasks(path.join(gateTasksBase, safeName));
    const task = Array.isArray(tasks) ? tasks.find((t) => t && t.num === Number(taskNum)) : null;
    if (!task) {
      return { error: `tasks.md is missing/unparseable or has no \`## Task ${taskNum}\` block` };
    }
    return { scope: Array.isArray(task.filesInScope) ? task.filesInScope : [] };
  } catch (err) {
    return { error: `tasks.md could not be read/parsed: ${(err && err.message) || err}` };
  }
}

/**
 * Build + persist gate GREEN for a passing post-implement run.
 *
 * @param {object} p - { cmd, output, safeName, taskNum, gateTasksBase,
 *                       taskType, workingDir }
 * @returns {object} result — { passed: true } or a structured failure
 */
function persistGateGreen(p) {
  const { cmd, output, safeName, taskNum, gateTasksBase, taskType, workingDir } = p;
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
    return { passed: false, command: cmd, exitCode: 0, outputTail: '', noRedEvidence: true };
  }

  try {
    // W11 — atomic write via the shared gate writer (no raw writeFileSync).
    // GH-694: workingDir + scope feed the writer's tests-only changed-files
    // trap (recorder-parity rule from lib/changed-test-files). PR #717: an
    // unresolvable scope is passed as null (+ scopeError) so the writer
    // rejects tests-only GREENs fail-closed instead of widening.
    const resolvedScope = resolveTaskScope(gateTasksBase, safeName, taskNum);
    const wr = writeGateGreen({
      tasksBase: gateTasksBase,
      ticketId: safeName,
      taskNum,
      evidencePath,
      evidence: built.evidence,
      cmd,
      output,
      taskType,
      workingDir,
      scope: resolvedScope.error ? null : resolvedScope.scope,
      scopeError: resolvedScope.error || undefined,
    });
    if (wr.rejected) {
      return {
        passed: false,
        plannerDefect: Boolean(wr.plannerDefect),
        reason: wr.reason,
        command: cmd,
        exitCode: 0,
        outputTail: String(output).slice(-4000),
      };
    }
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

module.exports = { persistGateGreen };
