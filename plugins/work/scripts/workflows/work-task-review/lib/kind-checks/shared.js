/**
 * Shared helpers for task-review kind-check modules.
 *
 * task_review reviews YOUR OWN most-recent task only — not the whole branch.
 * The diff source is `task-review-context.json` written by diff_audit phase,
 * which uses the SHA range from `task-review-gate.computeTaskDiff()`.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const specShared = require('../../../work-spec/lib/kind-checks/shared');

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function readTaskReviewContext(tasksDir) {
  const p = path.join(tasksDir, 'task-review-context.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readChangedFiles(ctx) {
  const j = readTaskReviewContext(ctx.tasksDir);
  if (j && Array.isArray(j.files)) return j.files.slice();
  return [];
}

function readFileFromWorktree(ctx, relPath) {
  const root = ctx.worktreeRoot || process.cwd();
  return readFile(path.join(root, relPath));
}

function hasCompanionTest(ctx, srcFile) {
  // Same-dir `__tests__` or sibling `<base>.test.<ext>` / `<base>.spec.<ext>`.
  const base = srcFile.replace(/\.(?:[mc]?[jt]sx?)$/, '');
  const ext = (srcFile.match(/\.([mc]?[jt]sx?)$/) || [, 'ts'])[1];
  const candidates = [
    `${base}.test.${ext}`,
    `${base}.spec.${ext}`,
    `${base}.test.ts`,
    `${base}.spec.ts`,
  ];
  const dir = path.dirname(srcFile);
  const file = path.basename(srcFile, path.extname(srcFile));
  candidates.push(path.join(dir, '__tests__', `${file}.test.${ext}`));
  candidates.push(path.join(dir, '__tests__', `${file}.spec.${ext}`));
  const root = ctx.worktreeRoot || process.cwd();
  return candidates.some((c) => {
    try {
      return fs.existsSync(path.join(root, c));
    } catch {
      return false;
    }
  });
}

module.exports = {
  readFile,
  readTaskReviewContext,
  readChangedFiles,
  readFileFromWorktree,
  hasCompanionTest,
  // Re-exports from spec-side shared:
  readBrief: specShared.readBrief,
  readSpec: specShared.readSpec,
  readTasks: specShared.readTasks,
  sliceSection: specShared.sliceSection,
  detectKinds: specShared.detectKinds,
  MalformedTasksError: specShared.MalformedTasksError,
  preflightTasksManifest: specShared.preflightTasksManifest,
  briefForbidsBackend: specShared.briefForbidsBackend,
  isBackendFile: specShared.isBackendFile,
  isFrontendFile: specShared.isFrontendFile,
  isE2eFile: specShared.isE2eFile,
  isDevopsFile: specShared.isDevopsFile,
  KIND_NAMES: specShared.KIND_NAMES,
};
