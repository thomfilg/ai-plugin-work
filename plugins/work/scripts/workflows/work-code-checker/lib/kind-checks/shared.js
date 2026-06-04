/**
 * Shared helpers for code-checker kind-check modules.
 *
 * Adds code-content scanning (reads each changed file and greps for
 * TypeScript safety violations, console.log, magic strings, etc).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const specShared = require('../../../work-spec/lib/kind-checks/shared');
const config = require('../../../lib/config');

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

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

function readFileFromWorktree(ctx, relPath) {
  const root = ctx.worktreeRoot || process.cwd();
  return readFile(path.join(root, relPath));
}

/**
 * TypeScript safety patterns the code-checker should always flag.
 * Returns array of { file, line, pattern, snippet }.
 */
const TS_VIOLATIONS = [
  { name: 'as any', re: /\bas\s+any\b/ },
  { name: 'as unknown as', re: /\bas\s+unknown\s+as\b/ },
  { name: '@ts-ignore', re: /@ts-ignore/ },
  { name: '@ts-expect-error (no comment)', re: /@ts-expect-error\s*$/ },
  { name: ': any (param/return)', re: /:\s*any(?![A-Za-z0-9_])/ },
];

function scanTypeScriptViolations(ctx, files) {
  const out = [];
  for (const f of files) {
    if (!/\.(ts|tsx)$/.test(f)) continue;
    const text = readFileFromWorktree(ctx, f);
    if (!text) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const v of TS_VIOLATIONS) {
        if (v.re.test(lines[i])) {
          out.push({ file: f, line: i + 1, pattern: v.name, snippet: lines[i].trim() });
        }
      }
    }
  }
  return out;
}

/**
 * Test-coverage check: returns whether any source file in `files` has a
 * companion `*.test.*` or `*.spec.*` in `files` OR alongside it in worktree.
 */
function hasCompanionTest(ctx, sourceFile) {
  const root = ctx.worktreeRoot || process.cwd();
  const base = sourceFile.replace(/\.(ts|tsx|js|jsx)$/, '');
  const candidates = [
    `${base}.test.ts`,
    `${base}.test.tsx`,
    `${base}.test.js`,
    `${base}.spec.ts`,
    `${base}.spec.tsx`,
    `${base}.spec.js`,
  ];
  return candidates.some((c) => fs.existsSync(path.join(root, c)));
}

module.exports = {
  readFile,
  readChangedFiles,
  readFileFromWorktree,
  scanTypeScriptViolations,
  hasCompanionTest,
  TS_VIOLATIONS,
  // Re-exports from spec-side shared:
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
