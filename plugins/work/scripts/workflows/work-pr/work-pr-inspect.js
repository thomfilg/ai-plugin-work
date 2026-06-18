/**
 * work-pr-inspect.js
 *
 * Filesystem/git inspection helpers for work-pr.workflow.js — screenshot
 * hashing and the per-instance `inspect()` data gathering. Extracted from the
 * workflow file to keep it under the size/complexity limits; pure helpers, no
 * workflow state.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const SCREENSHOT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
// sha256 of empty input — `find … | sha256sum` yields this when nothing matches.
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function safeExec(cmd, options = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', ...options }).trim();
  } catch {
    return '';
  }
}

// Read a recorded SHA file, trimmed; '' when missing or unreadable.
function readShaFile(filePath) {
  if (!fs.existsSync(filePath)) return '';
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

// Recursively collect screenshot file paths (relative to root), unsorted.
// Manual traversal — avoids reliance on { recursive: true } (Node 18.17+).
function collectScreenshotFiles(dir, base) {
  let results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write(`[work-pr] computeScreenshotHash: cannot read ${dir}: ${err.message}\n`);
    }
    return results;
  }
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results = results.concat(collectScreenshotFiles(path.join(dir, entry.name), rel));
    } else if (
      entry.isFile() &&
      SCREENSHOT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    ) {
      results.push(rel);
    }
  }
  return results;
}

// Stream a file in 64KB chunks → sha256 hex; null if not a regular file,
// oversized (>50MB), or unreadable.
function hashFile(fullPath) {
  try {
    const stat = fs.statSync(fullPath);
    if (!stat.isFile() || stat.size > 50 * 1024 * 1024) return null;
    const fd = fs.openSync(fullPath, 'r');
    try {
      const fileHash = crypto.createHash('sha256');
      const buf = Buffer.alloc(65536);
      let bytesRead;
      while ((bytesRead = fs.readSync(fd, buf, 0, buf.length)) > 0) {
        fileHash.update(buf.subarray(0, bytesRead));
      }
      return fileHash.digest('hex');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Compute a deterministic hash of screenshot files in a directory.
 * Uses Node.js crypto to avoid shell injection risks entirely.
 * @param {string} screenshotDir - Absolute path to screenshots directory
 * @returns {string} SHA256 hash or 'none' if no screenshots
 */
function computeScreenshotHash(screenshotDir) {
  if (!fs.existsSync(screenshotDir)) return 'none';
  const files = collectScreenshotFiles(screenshotDir, '').sort();
  if (files.length === 0) return 'none';
  const hash = crypto.createHash('sha256');
  let filesHashed = 0;
  for (const file of files) {
    const hex = hashFile(path.join(screenshotDir, file));
    if (hex === null) continue;
    hash.update(`${hex}  ${file}\n`);
    filesHashed++;
  }
  return filesHashed === 0 ? 'none' : hash.digest('hex');
}

// Resolve the base branch for diffs/guards from the shared config helper,
// defaulting to origin/main when unavailable.
function resolveBaseBranch(worktreeDir) {
  try {
    return require(path.join(__dirname, '..', 'lib', 'config')).getBaseBranch({ cwd: worktreeDir });
  } catch {
    return 'origin/main';
  }
}

// Rebase guard: how many commits the worktree is behind base (opt-in via
// REBASE_GUARD_ENABLED=1). Returns { commitsBehindMain } and, when actually
// measured, { commitsBehindMainCapped }.
function computeRebaseGuard(worktreeDir, baseBranch, worktreeExists) {
  if (!worktreeExists || process.env.REBASE_GUARD_ENABLED !== '1') {
    return { commitsBehindMain: 0 };
  }
  const parts = baseBranch.split('/');
  const remote = parts.length > 1 ? parts[0] : 'origin';
  const branch = parts.length > 1 ? parts.slice(1).join('/') : parts[0];
  // Validate remote/branch to prevent command injection
  const validRef = /^[a-zA-Z0-9_\-./]+$/.test(remote) && /^[a-zA-Z0-9_\-./]+$/.test(branch);
  if (!validRef) {
    process.stderr.write(`[work-pr] rebase guard: invalid baseBranch "${baseBranch}" — skipping\n`);
    return { commitsBehindMain: 0 };
  }
  const guardThreshold = parseInt(process.env.REBASE_GUARD_THRESHOLD || '0', 10);
  const fetchDepth = Math.max((Number.isFinite(guardThreshold) ? guardThreshold : 0) + 2, 2);
  safeExec(`git fetch ${remote} ${branch} --quiet --depth=${fetchDepth} --no-tags`, {
    cwd: worktreeDir,
    timeout: 5000,
  });
  const fetchedRef = `${remote}/${branch}`;
  const behind = safeExec(`git rev-list --count --max-count=${fetchDepth} HEAD..${fetchedRef}`, {
    cwd: worktreeDir,
  });
  const commitsBehindMain = parseInt(behind || '0', 10); // capped by fetchDepth
  return { commitsBehindMain, commitsBehindMainCapped: commitsBehindMain >= fetchDepth };
}

// Count screenshot files via find (best-effort; 0 on any failure).
function countScreenshots(screenshotDir) {
  if (!fs.existsSync(screenshotDir)) return 0;
  try {
    const files = safeExec(
      `find "${screenshotDir}" -type f \\( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' -o -name '*.gif' -o -name '*.webp' \\) 2>/dev/null`
    );
    return files ? files.split('\n').filter(Boolean).length : 0;
  } catch {
    return 0;
  }
}

// Content SHA for post-pr gating: all top-level *.check.md + every screenshot.
function computeContentSha(tasksDir) {
  return safeExec(
    `(
        find "${tasksDir}" -maxdepth 1 -name '*.check.md' -print0 2>/dev/null | sort -z | xargs -0 sha256sum 2>/dev/null
        find "${tasksDir}/screenshots" -type f -print0 2>/dev/null | sort -z | xargs -0 sha256sum 2>/dev/null
      ) | sha256sum | cut -d' ' -f1`
  );
}

/**
 * Gather all inspection data for an instance from its tasks + worktree dirs.
 * @param {string} tasksDir
 * @param {string} worktreeDir
 * @returns {object} inspection data
 */
function buildInspectData(tasksDir, worktreeDir) {
  const data = {
    tasksDir,
    tasksDirExists: fs.existsSync(tasksDir),
    worktreeDir,
    worktreeExists: fs.existsSync(worktreeDir),
  };

  // Current HEAD SHA (from ticket worktree)
  data.headSha = safeExec('git rev-parse HEAD', { cwd: worktreeDir });

  // .pr-update-sha (stores compound key: HEAD_SHA|SCREENSHOT_HASH)
  data.prShaFile = path.join(tasksDir, '.pr-update-sha');
  data.lastPrSha = readShaFile(data.prShaFile);

  // TSX/JSX changes vs base (from ticket worktree)
  const baseBranch = resolveBaseBranch(worktreeDir);
  data.tsxChanged = safeExec(`git diff --name-only ${baseBranch}...HEAD -- '*.tsx' '*.jsx'`, {
    cwd: worktreeDir,
  });
  data.hasTsxChanges = data.tsxChanged.length > 0;

  // Rebase guard
  data.baseBranch = baseBranch;
  const guard = computeRebaseGuard(worktreeDir, baseBranch, data.worktreeExists);
  data.commitsBehindMain = guard.commitsBehindMain;
  if (guard.commitsBehindMainCapped !== undefined) {
    data.commitsBehindMainCapped = guard.commitsBehindMainCapped;
  }

  // Screenshots
  const screenshotDir = path.join(tasksDir, 'screenshots');
  data.screenshotDir = screenshotDir;
  data.screenshotCount = countScreenshots(screenshotDir);
  data.screenshotsExist = data.screenshotCount > 0;
  data.screenshotHash = computeScreenshotHash(screenshotDir);

  // Compound pr-gen gating key: HEAD_SHA|SCREENSHOT_HASH
  data.prKey = `${data.headSha}|${data.screenshotHash}`;
  data.prUpToDate = !!(data.prKey && data.prKey === data.lastPrSha);

  // Content SHA for post-pr (all *.check.md + screenshots)
  data.contentSha = computeContentSha(tasksDir);
  data.postPrShaFile = path.join(tasksDir, '.post-pr-update-sha');
  data.lastPostPrSha = readShaFile(data.postPrShaFile);
  data.postPrUpToDate = !!(data.contentSha && data.contentSha === data.lastPostPrSha);

  // SKIP 5_post_pr_gen if no content to post
  data.hasContent = !!(data.contentSha && data.contentSha !== EMPTY_SHA256);

  return data;
}

module.exports = {
  safeExec,
  computeScreenshotHash,
  buildInspectData,
};
