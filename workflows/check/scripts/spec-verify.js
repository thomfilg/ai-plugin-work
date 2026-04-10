#!/usr/bin/env node
/**
 * spec-verify.js — Deterministic spec verification checklist runner (GH-169)
 *
 * Parses a `## Verification Checklist` section from a spec.md file and runs
 * machine-checkable assertions. Supports FILE_EXISTS, GREP, TEST_COUNT, REUSES.
 *
 * Usage: node spec-verify.js <spec-path> [--json] [--root <worktree-dir>]
 * Exit codes: 0 = pass (or no checklist), 1 = failures, 2 = script error
 *
 * --root overrides automatic worktree detection (used by check-gate.js
 * when spec.md lives outside the git worktree, e.g. in a tasks directory).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Get the git worktree root for path resolution.
 * @param {string} specPath - path to the spec file (used to determine cwd)
 * @returns {string}
 */
function getWorktreeRoot(specPath) {
  const cwd = path.dirname(path.resolve(specPath));
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    // Fallback: use spec file's directory; callers should use --root to override
    return cwd;
  }
} // getWorktreeRoot — overridden by --root CLI flag when called from check-gate

/**
 * Validate a path argument: reject absolute paths and `..` traversal.
 * @param {string} p - the path argument from the marker
 * @returns {{ valid: boolean, reason?: string, resolved?: string }}
 */
function validatePath(p) {
  if (typeof p !== 'string' || p.length === 0) {
    return { valid: false, reason: `Missing or invalid path argument: ${p}` };
  }
  if (path.isAbsolute(p)) {
    return { valid: false, reason: `Absolute path rejected: ${p}` };
  }
  const normalized = path.normalize(p);
  // Check each path segment individually — only reject literal '..' segments,
  // not paths that merely contain '..' as part of a name (e.g., '..cache')
  const segments = normalized.split(path.sep);
  if (segments.some((seg) => seg === '..')) {
    return { valid: false, reason: `Path traversal rejected: ${p}` };
  }
  // path.isAbsolute covers POSIX absolute paths; Windows drive-relative paths (C:foo) are out of scope
  return { valid: true, resolved: normalized };
} // validatePath — segment-based '..' check + POSIX absolute rejection

/** Directories to skip during glob traversal to avoid slow/flaky gate checks */
const GLOB_SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage']);

/**
 * Minimal recursive glob using fs.readdirSync.
 * Supports * and ** glob patterns. Skips common large/irrelevant directories.
 * @param {string} base - root directory
 * @param {string} pattern - glob pattern (e.g. "src/**\/*.test.js")
 * @returns {string[]} matching file paths (absolute)
 */
function miniGlob(base, pattern) {
  const parts = pattern.split(/[/\\]/);
  return matchParts(base, parts);
}

/**
 * @param {string} dir
 * @param {string[]} parts
 * @returns {string[]}
 */
function matchParts(dir, parts) {
  if (parts.length === 0) return [];

  const [current, ...rest] = parts;
  /** @type {string[]} */
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  if (current === '**') {
    // ** matches zero or more directories
    /** @type {string[]} */
    const results = [];
    // Try matching rest at this level (zero dirs matched)
    results.push(...matchParts(dir, rest));
    // Try matching in subdirectories (matchParts(subdir, parts) recurses with **
    // still active, which internally tries rest at each level — no separate call needed)
    for (const entry of entries) {
      if (entry.isDirectory() && !GLOB_SKIP_DIRS.has(entry.name)) {
        const subdir = path.join(dir, entry.name);
        results.push(...matchParts(subdir, parts));
      }
    }
    return [...new Set(results)];
  } // end ** handler — GLOB_SKIP_DIRS (line 62) filters .git/node_modules/dist/build/coverage

  // Convert glob pattern to regex
  const globRegex = new RegExp(
    '^' + current.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$'
  );

  /** @type {string[]} */
  const results = [];
  for (const entry of entries) {
    if (!globRegex.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (rest.length === 0) {
      if (entry.isFile()) results.push(full);
    } else if (entry.isDirectory() && !GLOB_SKIP_DIRS.has(entry.name)) {
      results.push(...matchParts(full, rest));
    }
  }
  return results;
}

// ─── Checklist Parser ────────────────────────────────────────────────────────

/**
 * Parse the Verification Checklist section from spec content.
 * @param {string} content - full spec.md content
 * @returns {{ hasChecklist: boolean, markers: Array<{ type: string, args: string[] }> }}
 */
function parseChecklist(content) {
  const lines = content.split(/\r?\n/);
  let inChecklist = false;
  /** @type {Array<{ type: string, args: string[] }>} */
  const markers = [];

  for (const line of lines) {
    // Detect start of checklist section
    if (/^##\s+Verification Checklist\s*$/.test(line)) {
      inChecklist = true;
      continue;
    }
    // Stop at next section header
    if (inChecklist && /^##\s+/.test(line)) {
      break;
    }
    if (!inChecklist) continue;

    // Parse marker lines: `- MARKER_TYPE arg1 arg2 [# comment]`
    const trimmed = line.trim();
    if (!trimmed.startsWith('- ')) continue;

    // Strip inline comment (` # `)
    let content2 = trimmed.slice(2);
    const commentIdx = content2.indexOf(' # ');
    if (commentIdx !== -1) {
      content2 = content2.slice(0, commentIdx);
    }
    content2 = content2.trim();
    if (!content2) continue;

    // Parse type and args
    const { type, args } = parseMarkerLine(content2);
    markers.push({ type, args });
  }

  return { hasChecklist: inChecklist, markers };
}

/**
 * Parse a single marker line into type and args.
 * Handles GREP's /regex/ delimiters specially.
 * @param {string} line - e.g. "GREP src/foo.js /export default/i"
 * @returns {{ type: string, args: string[] }}
 */
function parseMarkerLine(line) {
  const spaceIdx = line.indexOf(' ');
  if (spaceIdx === -1) return { type: line, args: [] };

  const type = line.slice(0, spaceIdx);
  const rest = line.slice(spaceIdx + 1).trim();

  if (type === 'GREP') {
    // GREP <path> /regex/[flags]
    const regexStart = rest.indexOf(' /');
    if (regexStart !== -1) {
      const filePath = rest.slice(0, regexStart);
      const regexPart = rest.slice(regexStart + 1);
      return { type, args: [filePath.trim(), regexPart] };
    }
  }

  return { type, args: rest.split(/\s+/) };
}

// ─── Marker Checkers ─────────────────────────────────────────────────────────

/**
 * @typedef {{ type: string, args: string[], passed: boolean, reason?: string, warning?: boolean }} CheckResult
 */

/**
 * Run FILE_EXISTS check.
 * @param {string[]} args
 * @param {string} root - worktree root
 * @returns {CheckResult}
 */
function checkFileExists(args, root) {
  const [filePath] = args;
  if (!filePath) {
    return {
      type: 'FILE_EXISTS',
      args,
      passed: false,
      reason: 'FILE_EXISTS requires one argument: <path>',
    };
  }
  const validation = validatePath(filePath);
  if (!validation.valid) {
    return { type: 'FILE_EXISTS', args, passed: false, reason: validation.reason };
  }
  const full = path.resolve(root, validation.resolved);
  if (fs.existsSync(full)) {
    return { type: 'FILE_EXISTS', args, passed: true };
  }
  return {
    type: 'FILE_EXISTS',
    args,
    passed: false,
    reason: `Expected file ${filePath} to exist — not found`,
  };
}

/**
 * Run GREP check.
 * @param {string[]} args - [filePath, /pattern/flags]
 * @param {string} root
 * @returns {CheckResult}
 */
function checkGrep(args, root) {
  const [filePath, patternStr] = args;
  if (!filePath || !patternStr) {
    return {
      type: 'GREP',
      args,
      passed: false,
      reason: 'GREP requires two arguments: <path> <pattern>',
    };
  }
  const validation = validatePath(filePath);
  if (!validation.valid) {
    return { type: 'GREP', args, passed: false, reason: validation.reason };
  }

  // Parse /regex/flags
  const match = /^\/(.+)\/([gimsuy]*)$/.exec(patternStr);
  if (!match) {
    return {
      type: 'GREP',
      args,
      passed: false,
      reason: `Invalid regex pattern: ${String(patternStr)} — must use /regex/ delimiters`,
    };
  }

  /** @type {RegExp} */
  let regex;
  try {
    regex = new RegExp(match[1], match[2]);
  } catch (err) {
    return { type: 'GREP', args, passed: false, reason: `Invalid regex: ${err.message}` };
  }

  const full = path.resolve(root, validation.resolved);
  /** @type {string} */
  let content;
  try {
    content = fs.readFileSync(full, 'utf-8');
  } catch {
    return { type: 'GREP', args, passed: false, reason: `File ${filePath} not found` };
  }

  if (regex.test(content)) {
    return { type: 'GREP', args, passed: true };
  }
  return {
    type: 'GREP',
    args,
    passed: false,
    reason: `Expected pattern ${patternStr} in ${filePath} — no match found`,
  };
}

/**
 * Run TEST_COUNT check.
 * @param {string[]} args - [globPattern, minimum]
 * @param {string} root
 * @returns {CheckResult}
 */
function checkTestCount(args, root) {
  const [globPattern, minStr] = args;
  if (!globPattern || minStr == null) {
    return {
      type: 'TEST_COUNT',
      args,
      passed: false,
      reason: 'TEST_COUNT requires two arguments: <glob-pattern> <minimum>',
    };
  }
  // Validate the glob pattern prefix (before any wildcards) doesn't contain path traversal.
  // globPattern is guaranteed to be a non-empty string by the guard above.
  const globPrefix = globPattern.split('*')[0] || '.';
  const pathValidation = validatePath(globPrefix);
  if (!pathValidation.valid) {
    return { type: 'TEST_COUNT', args, passed: false, reason: pathValidation.reason };
  }
  const minimum = parseInt(minStr, 10);
  if (isNaN(minimum)) {
    return { type: 'TEST_COUNT', args, passed: false, reason: `Invalid minimum count: ${minStr}` };
  }
  const files = miniGlob(root, globPattern);
  let count = 0;
  const testPattern = /\b(?:it|test)\s*\(/g;

  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const matches = content.match(testPattern);
      if (matches) count += matches.length;
    } catch {
      // Skip unreadable files
    }
  }

  if (count >= minimum) {
    return { type: 'TEST_COUNT', args, passed: true };
  }
  return {
    type: 'TEST_COUNT',
    args,
    passed: false,
    reason: `Expected at least ${minimum} test()/it() calls in ${globPattern} — found ${count}`,
  };
}

/**
 * Run REUSES check.
 * @param {string[]} args - [filePath, importPattern]
 * @param {string} root
 * @returns {CheckResult}
 */
function checkReuses(args, root) {
  const [filePath, importPattern] = args;
  if (!filePath || !importPattern) {
    return {
      type: 'REUSES',
      args,
      passed: false,
      reason: 'REUSES requires two arguments: <path> <import-pattern>',
    };
  }
  const validation = validatePath(filePath);
  if (!validation.valid) {
    return { type: 'REUSES', args, passed: false, reason: validation.reason };
  }

  const full = path.resolve(root, validation.resolved);
  /** @type {string} */
  let content;
  try {
    content = fs.readFileSync(full, 'utf-8');
  } catch {
    return { type: 'REUSES', args, passed: false, reason: `File ${filePath} not found` };
  }

  // Check for import or require containing the pattern (line-by-line to avoid cross-line false positives)
  const escaped = escapeRegex(importPattern);
  const importRegex = new RegExp(
    `(import\\s.*${escaped}|${escaped}.*require\\s*\\(|require\\s*\\(.*${escaped})`
  );
  const lines = content.split(/\r?\n/);
  if (lines.some((line) => importRegex.test(line))) {
    return { type: 'REUSES', args, passed: true };
  }
  return {
    type: 'REUSES',
    args,
    passed: false,
    reason: `Expected import matching "${importPattern}" in ${filePath} — not found`,
  };
}

/**
 * Escape special regex characters in a string.
 * @param {string} str
 * @returns {string}
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @type {Record<string, (args: string[], root: string) => CheckResult>} */
const CHECKERS = {
  FILE_EXISTS: checkFileExists,
  GREP: checkGrep,
  TEST_COUNT: checkTestCount,
  REUSES: checkReuses,
};

// ─── Runner ──────────────────────────────────────────────────────────────────

/**
 * Run all checks from a parsed checklist.
 * @param {Array<{ type: string, args: string[] }>} markers
 * @param {string} root - worktree root
 * @returns {CheckResult[]}
 */
function runChecks(markers, root) {
  return markers.map(({ type, args }) => {
    const checker = CHECKERS[type];
    if (!checker) {
      return {
        type,
        args,
        passed: false,
        reason: `Unknown marker type "${type}" — supported types: ${Object.keys(CHECKERS).join(', ')}`,
      };
    }
    return checker(args, root);
  });
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const rootIdx = args.indexOf('--root');
  const explicitRoot = rootIdx !== -1 ? args[rootIdx + 1] : null;
  const skipIndices = new Set(rootIdx !== -1 ? [rootIdx, rootIdx + 1] : []);
  const specPath = args.find((a, i) => !skipIndices.has(i) && a !== '--json');

  if (!specPath) {
    process.stderr.write('Usage: node spec-verify.js <spec-path> [--json] [--root <dir>]\n');
    process.exit(2);
  }

  /** @type {string} */
  let content;
  try {
    content = fs.readFileSync(specPath, 'utf-8');
  } catch (err) {
    process.stderr.write(`Error: cannot read spec file: ${specPath}\n`);
    process.exit(2);
  }

  const root = explicitRoot ? path.resolve(explicitRoot) : getWorktreeRoot(specPath);
  const { hasChecklist, markers } = parseChecklist(content);

  // No checklist header at all → fail-open for legacy specs without verification
  if (!hasChecklist) {
    const noChecklistResult = {
      hasChecklist: false,
      checks: [],
      passed: 0,
      failed: 0,
      total: 0,
      success: true,
    };
    if (jsonMode) {
      console.log(JSON.stringify(noChecklistResult));
    } else {
      console.log('No Verification Checklist found — passing (fail-open).');
    }
    process.exit(0);
  }

  // Checklist header present but empty → authoring error, require at least one marker
  if (markers.length === 0) {
    const emptyChecklistResult = {
      hasChecklist: true,
      checks: [
        {
          type: 'EMPTY_CHECKLIST',
          args: [],
          passed: false,
          reason: 'Verification Checklist header found but contains no markers',
        },
      ],
      passed: 0,
      failed: 1,
      total: 1,
      success: false,
    };
    if (jsonMode) {
      console.log(JSON.stringify(emptyChecklistResult));
    } else {
      console.log('Verification Checklist header found but contains no markers — failing.'); // tested in spec-verify.test.js
    }
    process.exit(1);
  }

  const checks = runChecks(markers, root);
  const passed = checks.filter((c) => c.passed).length;
  const failed = checks.filter((c) => !c.passed).length;
  const total = checks.length;
  const success = failed === 0;

  if (jsonMode) {
    console.log(JSON.stringify({ hasChecklist: true, checks, passed, failed, total, success }));
  } else {
    for (const check of checks) {
      const status = check.passed ? '[PASS]' : '[FAIL]';
      console.log(`${status} ${check.type} ${check.args.join(' ')}`);
      if (!check.passed && check.reason) {
        console.log(`  ${check.reason}`);
      }
      if (check.warning) {
        console.log(`  Warning: unknown marker type`);
      }
    }
    console.log(
      `\nResult: ${passed}/${total} checks passed${failed > 0 ? `, ${failed} failed` : ''}`
    );
  }

  process.exit(success ? 0 : 1);
}

main();
