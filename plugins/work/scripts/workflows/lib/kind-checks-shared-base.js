'use strict';

/**
 * kind-checks-shared-base.js — helpers common to the per-subsystem
 * kind-check `shared.js` modules (work-completion-checker, work-code-checker).
 *
 * Both subsystems previously carried byte-identical copies of
 * `readFile` / `readChangedFiles` and the work-spec re-export tail; the
 * copies drifted into jscpd duplicate-block debt. One definition here, both
 * sides require it.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const config = require('./config');

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Get the changed-file list. Prefer the snapshot pr-context.json (written
 * by pr-next.js diff_audit) so checkers see the same diff the PR phase
 * locked in. Fall back to git diff if absent.
 */
function readChangedFiles(ctx) {
  const ctxPath = path.join(ctx.tasksDir, 'pr-context.json');
  if (fs.existsSync(ctxPath)) {
    try {
      const j = JSON.parse(fs.readFileSync(ctxPath, 'utf8'));
      if (Array.isArray(j.files)) return j.files.slice();
    } catch {
      /* fall through */
    }
  }
  const root = ctx.worktreeRoot || process.cwd();
  // Honor BASE_BRANCH / symbolic-ref so dev-based repos don't fall back to
  // origin/main (which is behind merges and surfaces phantom files).
  for (const base of config.getDiffBaseCandidates({ cwd: root })) {
    const r = spawnSync('git', ['diff', '--name-only', `${base}...HEAD`], {
      cwd: root,
      encoding: 'utf8',
    });
    if (r.status === 0) {
      return r.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return [];
}

/**
 * The work-spec kind-checks helpers every consumer re-exports verbatim.
 * Spread the result into the consumer's module.exports.
 */
function specSharedReexports(specShared) {
  return {
    readBrief: specShared.readBrief,
    readSpec: specShared.readSpec,
    readTasks: specShared.readTasks,
    sliceSection: specShared.sliceSection,
    filesInFilesToModify: specShared.filesInFilesToModify,
    detectKinds: specShared.detectKinds,
    MalformedTasksError: specShared.MalformedTasksError,
    preflightTasksManifest: specShared.preflightTasksManifest,
    briefForbidsBackend: specShared.briefForbidsBackend,
    isBackendFile: specShared.isBackendFile,
    isFrontendFile: specShared.isFrontendFile,
    isE2eFile: specShared.isE2eFile,
    isDevopsFile: specShared.isDevopsFile,
    isAppSourceFile: specShared.isAppSourceFile,
    KIND_NAMES: specShared.KIND_NAMES,
  };
}

module.exports = { readFile, readChangedFiles, specSharedReexports };
