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

const createWorkflowDefinition = require(path.join(__dirname, 'workflow-definition'));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function listFiles(dir, pattern) {
  if (!fileExists(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => (pattern instanceof RegExp ? pattern.test(f) : f.includes(pattern)))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

// ─── Artifact Patterns ──────────────────────────────────────────────────────

// Artifact patterns per step — authoritative config lives in workflow-definition.js
// under `workflow.archivalPatterns` (GH-206 Task 12). This module re-exports the
// resolved config for consumers that historically imported STEP_ARTIFACTS directly.
//
// Note: `complete` has no entry because complete->complete is a self-transition,
// which does not trigger archival. Recovery archival for `complete` is handled
// by unstick-complete.js directly.
const STEP_ARTIFACTS = (() => {
  // Instantiate workflow definition with no-op deps — we only read static config.
  // If this throws, it's a configuration bug that should surface loudly.
  const { workflow } = createWorkflowDefinition({
    TASKS_BASE: '',
    safeTicketPath: (id) => id,
    resolveGitHead: () => '',
  });
  return workflow.archivalPatterns || {};
})();

// ─── Archival Logic ─────────────────────────────────────────────────────────

function archiveStepArtifacts(tasksDir, stepsToArchive) {
  if (!fileExists(tasksDir)) return null;

  // Determine next run number
  const runsDir = path.join(tasksDir, 'runs');
  let runNum = 1;
  if (fileExists(runsDir)) {
    try {
      const existing = fs
        .readdirSync(runsDir)
        .filter((d) => /^run\d+$/.test(d))
        .map((d) => parseInt(d.replace('run', ''), 10))
        .filter((n) => !isNaN(n));
      if (existing.length > 0) runNum = Math.max(...existing) + 1;
    } catch {
      /* ignore */
    }
  }

  let archived = false;
  const runDir = path.join(runsDir, `run${runNum}`);

  for (const step of stepsToArchive) {
    const patterns = STEP_ARTIFACTS[step];
    if (!patterns) continue;

    // Dedupe paths across patterns — multiple regex/substring patterns can
    // match the same file, which would otherwise cause fs.renameSync to fail
    // on the second attempt (file already moved) and log a spurious warning.
    const files = [...new Set(patterns.flatMap((p) => listFiles(tasksDir, p)))];
    if (files.length === 0) continue;

    if (!archived) {
      fs.mkdirSync(runDir, { recursive: true });
      archived = true;
    }

    for (const filePath of files) {
      const dest = path.join(runDir, path.basename(filePath));
      try {
        fs.renameSync(filePath, dest);
      } catch (e) {
        process.stderr.write(
          `work-orchestrator: failed to archive ${path.basename(filePath)}: ${e?.message || e}\n`
        );
      }
    }
  }

  return archived ? `runs/run${runNum}` : null;
}

module.exports = { STEP_ARTIFACTS, archiveStepArtifacts };
