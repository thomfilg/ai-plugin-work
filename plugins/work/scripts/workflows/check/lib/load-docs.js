'use strict';

/**
 * check/lib/load-docs.js — READ_DOCS_ON_* loader for /check setup
 * (extracted from hooks/check-setup.js, which re-exports the public pieces).
 *
 * Loads project-specific docs from comma-separated relative paths with a
 * defense-in-depth guard chain: DOCS_DENYLIST + .env regex + boundary check +
 * realpathSync + isFile + 256KB cap + git-ls-files (repo files only).
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Denylist of filename patterns that should never be injected into agent prompts
const DOCS_DENYLIST = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.staging',
  'id_rsa',
  'id_ed25519',
  'credentials.json',
  'service-account.json',
  '.secrets',
  '.tokens',
];

const MAX_DOC_BYTES = 256 * 1024; // 256 KB cap — prevent injecting huge files into agent prompts

/** Secret/sensitive files by name (denylist + pattern match). */
function isSensitiveDocName(basename) {
  return (
    DOCS_DENYLIST.includes(basename) ||
    /^\.env(\.|$)/i.test(basename) ||
    /\.(pem|key|pfx|p12|secrets?|tokens?|credentials)$/i.test(basename)
  );
}

/**
 * When WORKTREES_BASE is set, allow paths within it (enables shared docs
 * across worktrees). Validates it exists and is a directory to prevent misuse.
 */
function resolveWorktreesBase() {
  const rawWorktreesBase = process.env.WORKTREES_BASE;
  if (!rawWorktreesBase) return null;
  const resolved = path.resolve(rawWorktreesBase);
  try {
    if (fs.statSync(resolved).isDirectory()) {
      return fs.realpathSync(resolved);
    }
  } catch {
    // WORKTREES_BASE does not exist or is inaccessible — ignore
  }
  return null;
}

function withinBoundary(candidate, boundary) {
  return Boolean(boundary) && (candidate.startsWith(boundary + path.sep) || candidate === boundary);
}

/** Files inside the repo must be git-tracked (untracked/gitignored are rejected). */
function isGitTracked(resolvedRoot, realPath) {
  const repoRelPath = path.relative(resolvedRoot, realPath);
  try {
    execSync(
      `git -C ${JSON.stringify(resolvedRoot)} ls-files --error-unmatch -- ${JSON.stringify(repoRelPath)}`,
      { stdio: 'ignore' }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve symlinks to prevent symlink-based path traversal, re-check
 * boundaries, and validate file type/size/tracking. Returns the real path to
 * read, or null (after warning) when any guard rejects the doc.
 */
function resolveDocRealPath(ctx, relPath, absPath) {
  const { envVarName, resolvedRoot, worktreesBase } = ctx;
  const realPath = fs.realpathSync(absPath);
  const realWithinRepo = realPath.startsWith(resolvedRoot + path.sep);
  if (!realWithinRepo && !withinBoundary(realPath, worktreesBase)) {
    console.error(`Warning: ${envVarName} symlink escapes allowed boundary: ${relPath}`);
    return null;
  }
  const stat = fs.statSync(realPath);
  if (!stat.isFile()) {
    console.error(`Warning: ${envVarName} path is not a file: ${relPath}`);
    return null;
  }
  if (stat.size > MAX_DOC_BYTES) {
    console.error(
      `Warning: ${envVarName} file too large (${stat.size} bytes, max ${MAX_DOC_BYTES}): ${relPath}`
    );
    return null;
  }
  // Only run git ls-files check for files within the repo root.
  // Files outside the repo (shared docs in WORKTREES_BASE) are not git-tracked.
  if (realWithinRepo && !isGitTracked(resolvedRoot, realPath)) {
    console.error(`Warning: ${envVarName} rejects untracked/gitignored file: ${relPath}`);
    return null;
  }
  return realPath;
}

/** Load one doc path with the full guard chain; returns its section or ''. */
function loadOneDoc(ctx, relPath) {
  const { envVarName, resolvedRoot, worktreesBase } = ctx;
  // Reject absolute paths
  if (path.isAbsolute(relPath)) {
    console.error(`Warning: ${envVarName} rejects absolute path: ${relPath}`);
    return '';
  }
  if (isSensitiveDocName(path.basename(relPath))) {
    console.error(`Warning: ${envVarName} rejects sensitive file: ${relPath}`);
    return '';
  }
  // Resolve and check path boundaries
  const absPath = path.resolve(resolvedRoot, relPath);
  const withinRepo = absPath.startsWith(resolvedRoot + path.sep) || absPath === resolvedRoot;
  if (!withinRepo && !withinBoundary(absPath, worktreesBase)) {
    console.error(`Warning: ${envVarName} path escapes allowed boundary: ${relPath}`);
    return '';
  }
  try {
    const realPath = resolveDocRealPath(ctx, relPath, absPath);
    if (!realPath) return '';
    return `\n--- ${relPath} ---\n${fs.readFileSync(realPath, 'utf8')}\n`;
  } catch (readErr) {
    const reason = readErr.code || readErr.message;
    console.error(`Warning: ${envVarName} skipped (${reason}): ${relPath}`);
    return '';
  }
}

/**
 * Load project-specific docs from a comma-separated env var.
 * @param {string} envVarName - Name of the env var (for warning messages)
 * @param {string} csvPaths - Comma-separated relative paths
 * @param {string} repoRoot - Absolute path to repo root
 * @returns {string} Concatenated file contents with headers, or empty string
 */
function loadDocsFromPaths(envVarName, csvPaths, repoRoot) {
  const docPaths = (csvPaths || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (docPaths.length === 0) return '';

  const ctx = {
    envVarName,
    resolvedRoot: path.resolve(repoRoot),
    worktreesBase: resolveWorktreesBase(),
  };
  let docs = '';
  for (const relPath of docPaths) {
    docs += loadOneDoc(ctx, relPath);
  }
  return docs;
}

module.exports = { loadDocsFromPaths, DOCS_DENYLIST };
