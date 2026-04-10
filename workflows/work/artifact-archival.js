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

const { STEPS } = require(path.join(__dirname, 'step-registry'));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fileExists(p) { try { return fs.existsSync(p); } catch { return false; } }

function listFiles(dir, pattern) {
  if (!fileExists(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter(f => pattern instanceof RegExp ? pattern.test(f) : f.includes(pattern))
      .map(f => path.join(dir, f));
  } catch { return []; }
}

// ─── Artifact Patterns ──────────────────────────────────────────────────────

// Artifact patterns per step — used by archiveStepArtifacts() on backward transitions.
// Note: complete has no entry here because complete->complete is a self-transition (same index),
// which does not trigger archival. Recovery archival is handled by unstick-complete.js directly.
const STEP_ARTIFACTS = {
  [STEPS.check]: [/^.*\.check\.md$/],
  [STEPS.pr]:    [/^\.pr-update-sha$/, /^\.post-pr-update-sha$/],
};

// ─── Archival Logic ─────────────────────────────────────────────────────────

function archiveStepArtifacts(tasksDir, stepsToArchive) {
  if (!fileExists(tasksDir)) return null;

  // Determine next run number
  const runsDir = path.join(tasksDir, 'runs');
  let runNum = 1;
  if (fileExists(runsDir)) {
    try {
      const existing = fs.readdirSync(runsDir)
        .filter(d => /^run\d+$/.test(d))
        .map(d => parseInt(d.replace('run', ''), 10))
        .filter(n => !isNaN(n));
      if (existing.length > 0) runNum = Math.max(...existing) + 1;
    } catch { /* ignore */ }
  }

  let archived = false;
  const runDir = path.join(runsDir, `run${runNum}`);

  for (const step of stepsToArchive) {
    const patterns = STEP_ARTIFACTS[step];
    if (!patterns) continue;

    const files = patterns.flatMap(p => listFiles(tasksDir, p));
    if (files.length === 0) continue;

    if (!archived) {
      fs.mkdirSync(runDir, { recursive: true });
      archived = true;
    }

    for (const filePath of files) {
      const dest = path.join(runDir, path.basename(filePath));
      try { fs.renameSync(filePath, dest); } catch (e) {
        process.stderr.write(`work-orchestrator: failed to archive ${path.basename(filePath)}: ${e?.message || e}\n`);
      }
    }
  }

  return archived ? `runs/run${runNum}` : null;
}

module.exports = { STEP_ARTIFACTS, archiveStepArtifacts };
