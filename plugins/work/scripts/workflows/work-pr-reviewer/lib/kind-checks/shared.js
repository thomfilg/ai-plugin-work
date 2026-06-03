/**
 * Shared helpers for pr-reviewer kind-check modules.
 *
 * Reads `pr-context.json` (snapshot of `gh pr diff` files) so all kind
 * validators see the same view of the PR. Falls back to local git diff
 * if pr-context.json is not yet produced.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const specShared = require('../../../work-spec/lib/kind-checks/shared');

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function readPrContext(tasksDir) {
  const p = path.join(tasksDir, 'pr-review-context.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readChangedFiles(ctx) {
  const j = readPrContext(ctx.tasksDir);
  if (j && Array.isArray(j.files)) return j.files.slice();
  // Fallback: local git diff (when running locally without a real PR).
  // Use the centralized config.getBaseBranch() resolution (env → git
  // symbolic-ref → probe → fallback) instead of a hardcoded list, so
  // repos using `dev`/`master`/non-standard default branches work.
  const root = ctx.worktreeRoot || process.cwd();
  const candidates = resolveBaseCandidates(root);
  for (const base of candidates) {
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
 * Build ordered diff-base candidates from `config.getBaseBranch()`. The
 * helper returns refs like `origin/main` — we also probe the bare name so
 * environments without a fetched remote still work. Deduped + ordered.
 */
function resolveBaseCandidates(cwd) {
  let base = '';
  try {
    const config = require('../../../lib/config');
    if (config && typeof config.getBaseBranch === 'function') {
      base = config.getBaseBranch({ cwd }) || '';
    }
  } catch {
    /* fall through */
  }
  const bare = String(base || 'main').replace(/^origin\//, '');
  return [...new Set([`origin/${bare}`, bare])];
}

function readFileFromWorktree(ctx, relPath) {
  const root = ctx.worktreeRoot || process.cwd();
  return readFile(path.join(root, relPath));
}

const TS_VIOLATIONS = [
  { name: 'as any', re: /\bas\s+any\b/ },
  { name: 'as unknown as', re: /\bas\s+unknown\s+as\b/ },
  { name: '@ts-ignore', re: /@ts-ignore/ },
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

module.exports = {
  readFile,
  readPrContext,
  readChangedFiles,
  resolveBaseCandidates,
  readFileFromWorktree,
  scanTypeScriptViolations,
  TS_VIOLATIONS,
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
  isAppSourceFile: specShared.isAppSourceFile,
  KIND_NAMES: specShared.KIND_NAMES,
};
