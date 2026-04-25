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

  // Check for import or require containing the pattern.
  // First try line-by-line (avoids cross-line false positives), then fall back
  // to full-content matching for formatters that split require() across lines.
  const escaped = escapeRegex(importPattern);
  const importRegex = new RegExp(
    `(import\\s.*${escaped}|${escaped}.*require\\s*\\(|require\\s*\\(.*${escaped})`
  );
  // Strip comments while preserving string literal content. A simple state
  // machine avoids false stripping of // inside strings (e.g. URLs).
  const stripped = stripComments(content);
  const lines = stripped.split(/\r?\n/);
  if (lines.some((line) => {
    const m = importRegex.exec(line);
    return m && !isInsideString(line, m.index);
  })) {
    return { type: 'REUSES', args, passed: true };
  }
  // Fallback: check full content for require('...pattern...') split across lines by formatters.
  const multilineRegex = new RegExp(`require\\s*\\(\\s*['"][^'"]*${escaped}[^'"]*['"]`, 'sg');
  let match;
  while ((match = multilineRegex.exec(stripped)) !== null) {
    if (!isInsideString(stripped, match.index)) {
      return { type: 'REUSES', args, passed: true };
    }
  }
  return {
    type: 'REUSES',
    args,
    passed: false,
    reason: `Expected import matching "${importPattern}" in ${filePath} — not found`,
  };
}

/**
 * Strip JS comments while respecting string and regex literals.
 * Tracks quote/regex state so // and /* inside strings/regex are preserved.
 * Block comments are replaced with equivalent newlines to prevent line concatenation.
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    // String literals — preserve content (needed for require() arguments)
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] || '');
          i += 2;
        } else {
          out += src[i];
          i++;
        }
      }
      if (i < src.length) {
        out += src[i]; // closing quote
        i++;
      }
    // Regex literal — a / after certain tokens starts a regex, not a comment.
    // Heuristic: / preceded by =, (, [, !, &, |, ?, :, ,, ;, {, }, newline, or line start.
    } else if (ch === '/' && src[i + 1] !== '/' && src[i + 1] !== '*' && isRegexContext(out)) {
      out += ch;
      i++;
      while (i < src.length && src[i] !== '/' && src[i] !== '\n') {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] || '');
          i += 2;
        } else if (src[i] === '[') {
          // Character class — skip to ]
          out += src[i];
          i++;
          while (i < src.length && src[i] !== ']' && src[i] !== '\n') {
            if (src[i] === '\\') {
              out += src[i] + (src[i + 1] || '');
              i += 2;
            } else {
              out += src[i];
              i++;
            }
          }
        } else {
          out += src[i];
          i++;
        }
      }
      if (i < src.length && src[i] === '/') {
        out += src[i]; // closing /
        i++;
        // Skip regex flags
        while (i < src.length && /[gimsuy]/.test(src[i])) {
          out += src[i];
          i++;
        }
      }
    // Single-line comment — skip to end of line
    } else if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    // Block comment — replace with newlines to preserve line structure.
    // If no newline was emitted, insert a space to prevent token concatenation.
    } else if (ch === '/' && src[i + 1] === '*') {
      let emittedNewline = false;
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') {
          out += '\n';
          emittedNewline = true;
        }
        i++;
      }
      if (!emittedNewline) out += ' ';
      if (i < src.length) i += 2; // skip */
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/**
 * Check if a position in source text is inside a string literal.
 * Walks from the start tracking quote state.
 * @param {string} src - source text (already comment-stripped)
 * @param {number} pos - character index to check
 * @returns {boolean}
 */
function isInsideString(src, pos) {
  let inString = false;
  let quote = '';
  let braceDepth = 0; // tracks ${...} nesting in template literals
  for (let i = 0; i < pos && i < src.length; i++) {
    const ch = src[i];
    if (inString && quote === '`' && braceDepth > 0) {
      // Inside ${...} interpolation — treat as code
      if (ch === '{') {
        braceDepth++;
      } else if (ch === '}') {
        braceDepth--;
      } else if (ch === "'" || ch === '"') {
        // Skip strings inside interpolation
        const q = ch;
        i++;
        while (i < src.length && src[i] !== q) {
          if (src[i] === '\\') i++;
          i++;
        }
      }
    } else if (inString) {
      if (ch === '\\') {
        i++; // skip escaped char
      } else if (quote === '`' && ch === '$' && src[i + 1] === '{') {
        braceDepth = 1;
        i++; // skip {
      } else if (ch === quote) {
        inString = false;
      }
    } else if (ch === "'" || ch === '"' || ch === '`') {
      inString = true;
      quote = ch;
    } else if (ch === '/' && isRegexContext(src.slice(0, i))) {
      // Skip regex literal to avoid treating quotes inside regex as string starts
      i++;
      while (i < src.length && src[i] !== '/' && src[i] !== '\n') {
        if (src[i] === '\\') i++;
        i++;
      }
    }
  }
  return inString && !(quote === '`' && braceDepth > 0);
}

/**
 * Check if the last non-whitespace character in output suggests a regex follows.
 * A / is a regex start after: = ( [ ! & | ? : , ; { } ~ ^ + - * % < > newline or start of string.
 * A / is division after: ) ] identifier digit.
 * @param {string} output - text emitted so far
 * @returns {boolean}
 */
function isRegexContext(output) {
  const trimmed = output.replace(/\s+$/, '');
  if (trimmed.length === 0) return true;
  const last = trimmed[trimmed.length - 1];
  // Include ) for keyword contexts like if(x)/regex/ and return(x)/regex/
  return '=([)!&|?:,;{}~^+-*%<>\n'.includes(last);
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
