/**
 * artifact-archival.js
 *
 * Manages archival of step artifacts on backward workflow transitions.
 * When the workflow loops back (e.g. check->implement), stale artifacts
 * are moved to runs/runN/ so DEFER re-evaluation sees fresh state.
 *
 * Extracted from work.workflow.js (GH-206) for independent testability.
 */

const fs = require('fs');
const path = require('path');

const createWorkflowDefinition = require(path.join(__dirname, '..', 'workflow-definition'));
// Verbatim copies of these two lived here; work-helpers is the shared home.
const { fileExists, listFiles } = require(path.join(__dirname, 'work-helpers'));

// ─── Artifact Patterns ──────────────────────────────────────────────────────

// Artifact patterns per step — authoritative config lives in workflow-definition.js
// under `workflow.archivalPatterns` (GH-206 Task 12). This module re-exports the
// resolved config for consumers that historically imported STEP_ARTIFACTS directly.
//
// Note: `complete` has no entry because complete->complete is a self-transition,
// which does not trigger archival. Recovery archival for `complete` is handled
// by unstick-complete.js directly.
//
// echo-6842: the ticket-root patterns exclude the step's own gate evidence
// (see workflow-definition.js `archivalPattern`) — archival must never move a
// file verifyCheck / validateCheckGate reads. The taskN/ sweep (GH-259) keeps
// the unguarded patterns: no gate reads taskN/*.check.md, only
// taskN/tdd-phase.json, so nothing there is evidence to destroy.
const { STEP_ARTIFACTS, PER_TASK_STEP_ARTIFACTS, PRESERVED_STEP_ARTIFACTS } = (() => {
  // Instantiate workflow definition with no-op deps — we only read static config.
  // If this throws, it's a configuration bug that should surface loudly.
  const { workflow } = createWorkflowDefinition({
    TASKS_BASE: '',
    safeTicketPath: (id) => id,
    resolveGitHead: () => '',
  });
  return {
    STEP_ARTIFACTS: workflow.archivalPatterns || {},
    PER_TASK_STEP_ARTIFACTS: workflow.perTaskArchivalPatterns || {},
    PRESERVED_STEP_ARTIFACTS: workflow.preservedArchivalPatterns || {},
  };
})();

// ─── Archival Logic ─────────────────────────────────────────────────────────

function copyFile(src, dest) {
  fs.copyFileSync(src, dest);
}

/**
 * Put `files` into `runDir` with `place` (rename to move, copy to preserve),
 * creating the run dir on first use. Per-file failures are reported and
 * skipped — one unreadable artifact must not abort the archival.
 */
function stashFiles(state, runDir, files, place) {
  if (files.length === 0) return;
  if (!state.archived) {
    fs.mkdirSync(state.runDir, { recursive: true });
    state.archived = true;
  }
  fs.mkdirSync(runDir, { recursive: true });
  for (const filePath of files) {
    try {
      place(filePath, path.join(runDir, path.basename(filePath)));
    } catch (e) {
      process.stderr.write(
        `work-orchestrator: failed to archive ${path.basename(filePath)}: ${e?.message || e}\n`
      );
    }
  }
}

/** Highest existing runN + 1, or 1 when runs/ is absent or unreadable. */
function nextRunNumber(runsDir) {
  if (!fileExists(runsDir)) return 1;
  try {
    const existing = fs
      .readdirSync(runsDir)
      .filter((d) => /^run\d+$/.test(d))
      .map((d) => parseInt(d.replace('run', ''), 10))
      .filter((n) => !isNaN(n));
    return existing.length > 0 ? Math.max(...existing) + 1 : 1;
  } catch {
    return 1;
  }
}

/** Files a step's patterns match in `dir`, deduped across patterns. */
function matching(patternsByStep, step, dir) {
  // Dedupe paths across patterns — multiple regex/substring patterns can
  // match the same file, which would otherwise cause fs.renameSync to fail
  // on the second attempt (file already moved) and log a spurious warning.
  return [...new Set((patternsByStep[step] || []).flatMap((p) => listFiles(dir, p)))];
}

/** taskN/ subdirectories of a multi-task ticket dir. */
function taskSubdirs(tasksDir) {
  if (!fileExists(path.join(tasksDir, 'tasks.md'))) return []; // GH-259: multi-task mode only
  try {
    return fs
      .readdirSync(tasksDir)
      .filter((d) => /^task\d+$/.test(d))
      .filter((d) => {
        try {
          return fs.statSync(path.join(tasksDir, d)).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return []; // ignore readdir failures
  }
}

function archiveStepArtifacts(tasksDir, stepsToArchive) {
  if (!fileExists(tasksDir)) return null;

  const runsDir = path.join(tasksDir, 'runs');
  const runNum = nextRunNumber(runsDir);
  const runDir = path.join(runsDir, `run${runNum}`);
  const state = { archived: false, runDir };

  for (const step of stepsToArchive) {
    stashFiles(state, runDir, matching(STEP_ARTIFACTS, step, tasksDir), fs.renameSync);
    stashFiles(state, runDir, matching(PRESERVED_STEP_ARTIFACTS, step, tasksDir), copyFile);
  }

  // Scan taskN/ subdirectories for matching artifacts (GH-259)
  for (const taskDir of taskSubdirs(tasksDir)) {
    const taskPath = path.join(tasksDir, taskDir);
    for (const step of stepsToArchive) {
      const files = matching(PER_TASK_STEP_ARTIFACTS, step, taskPath);
      stashFiles(state, path.join(runDir, taskDir), files, fs.renameSync);
    }
  }

  return state.archived ? `runs/run${runNum}` : null;
}

module.exports = {
  STEP_ARTIFACTS,
  PER_TASK_STEP_ARTIFACTS,
  PRESERVED_STEP_ARTIFACTS,
  archiveStepArtifacts,
};
