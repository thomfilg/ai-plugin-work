/**
 * protect-script-bypass.js
 *
 * Vectors 3 and 4 of the file-protection factory (see protect-state-files):
 *
 *   Vector 3 — script bypass: a Bash command runs a node/python/ruby/perl
 *   script whose source contains write operations AND references a protected
 *   file name.
 *
 *   Vector 4 — inline interpreter bypass: python3 -c / ruby -e / perl -e
 *   one-liners that write to protected files (including base64 evasion).
 *
 * `createBypassCheckers` binds the caller's isProtected/isExempt/fmt context
 * once and returns the two checker functions the protector exposes.
 */

const fs = require('fs');
const path = require('path');

// ─── Constants ──────────────────────────────────────────────────────────────

/** Filesystem write operations in any language (for script content scanning) */
const SCRIPT_WRITE_OPS =
  /\b(?:writeFileSync|appendFileSync|writeFile|createWriteStream|unlink|unlinkSync|rmSync|renameSync|copyFileSync|fs\.promises\.writeFile|fs\.promises\.rm)\b|>{1,2}\s*['"]|\btee\s+-a\b|open\(.*['"]w/;

/** Interpreter patterns to extract script paths from Bash commands */
const INTERPRETER_PATTERN =
  /\b(?:node|python[23]?|ruby|perl|bash|sh)\s+(?:--?\w[\w-]*(?:=\S+)?\s+)*["']?([/\w._-]+\.(?:js|mjs|cjs|py|rb|pl|sh))["']?/g;

/** Inline interpreter invocations: python3 -c, ruby -e, perl -e (with optional /usr/bin/env prefix) */
const INLINE_INTERPRETER_PATTERN =
  /(?:\/usr\/bin\/env\s+)?\b(?:python[23]?)\s+-c\b|(?:\/usr\/bin\/env\s+)?\b(?:ruby|perl)\s+-e\b/;

/** Write operations in inline interpreter code (w/a/x/r+/rb+ modes, File.write, os.rename, etc.)
 *  open() pattern uses (?:[^()]*|\([^()]*\))* to allow one level of nested parens (e.g. b64decode())
 *  without matching across statement boundaries like open(...).read(); print('w'). */
const INLINE_INTERPRETER_WRITES =
  /open\((?:[^()]*|\([^()]*\))*['"](?:[wWaAxX>]|[wWaAxX][bB]?[+]?|[bB][wWaAxX]|[rR][bB]?[+])|\bFile\.write\b|\bIO\.write\b|\bos\.rename\b|\bshutil\.copy\b|\bshutil\.move\b/;

/** Base64 evasion patterns (case-insensitive to catch MIME::Base64, Base64.decode64, etc.) */
const BASE64_EVASION_PATTERN = /\bbase64\b|\bb64decode\b|\bb64encode\b|\batob\b|\bbtoa\b/i;

// ─── Shared token helpers ───────────────────────────────────────────────────

/**
 * Extract tokens from a string, splitting on whitespace, quotes, shell operators,
 * redirect operators, and '=' (for dd of=path patterns).
 * @param {string} str
 * @returns {string[]}
 */
function extractTokens(str) {
  const rawTokens = str.match(/[^\s"'|;&()]+/g) || [];
  return rawTokens.flatMap((t) => {
    const redirectSplit = t.split(/>{1,2}|</);
    return redirectSplit.flatMap((part) => part.split('=')).filter(Boolean);
  });
}

/**
 * Extract script paths from a Bash command (node script.js, python script.py, etc.)
 * @param {string} cmd
 * @returns {string[]}
 */
function extractScriptPaths(cmd) {
  const scripts = [];
  // Reset lastIndex since INTERPRETER_PATTERN has /g flag
  INTERPRETER_PATTERN.lastIndex = 0;
  let m;
  while ((m = INTERPRETER_PATTERN.exec(cmd)) !== null) {
    if (m[1] && !m[1].startsWith('-')) scripts.push(m[1]);
  }
  return scripts;
}

// ─── Trust checks ───────────────────────────────────────────────────────────

// Cache repo root (lazy init) to avoid calling git rev-parse on every invocation
let _cachedRepoRoot;
function getRepoRoot() {
  if (_cachedRepoRoot !== undefined) return _cachedRepoRoot;
  try {
    _cachedRepoRoot = require('child_process')
      .execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
      .trim();
  } catch {
    _cachedRepoRoot = process.cwd();
  }
  return _cachedRepoRoot;
}

/**
 * Check if a script path is a trusted test/mock file (GH-191).
 * Only trusts scripts under __tests__/ or __mocks__/ directories,
 * and verifies the path resolves within the current repo/worktree root.
 * Suffix-based patterns (.test.js, .spec.js) are intentionally excluded
 * as they could be exploited by placing malicious scripts with test suffixes.
 *
 * @param {string} scriptPath
 * @returns {boolean}
 */
function isTrustedTestScript(scriptPath) {
  // Resolve symlinks for safety — if realpathSync fails (file doesn't exist), untrusted
  let resolved;
  try {
    resolved = fs.realpathSync(scriptPath);
  } catch {
    return false;
  }
  // Script must resolve within the repo root
  const repoRoot = getRepoRoot();
  const rel = path.relative(repoRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  // Check that __tests__ or __mocks__ appears as a path segment
  const segments = rel.split(path.sep);
  if (!segments.includes('__tests__') && !segments.includes('__mocks__')) return false;
  // Only trust git-tracked files — newly-created/untracked scripts are not exempt
  try {
    require('child_process').execFileSync('git', ['ls-files', '--error-unmatch', '--', rel], {
      encoding: 'utf8',
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false; // Not tracked by git — untrusted
  }
}

/**
 * Resolve trusted script roots once. Scripts whose realpath is inside any of
 * these roots skip Vector 3 — this is how a hook tells the protector "these
 * scripts are mine; they're the legitimate writers of the protected files".
 */
function resolveTrustedRoots(trustedScriptRoots) {
  return trustedScriptRoots
    .map((r) => {
      try {
        return fs.realpathSync(r);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function isUnderTrustedRoot(resolvedTrustedRoots, scriptPath) {
  if (resolvedTrustedRoots.length === 0) return false;
  let resolved;
  try {
    resolved = fs.realpathSync(scriptPath);
  } catch {
    return false;
  }
  for (const root of resolvedTrustedRoots) {
    const rel = path.relative(root, resolved);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return true;
  }
  return false;
}

// ─── Vector 3: script bypass ────────────────────────────────────────────────

/** Read a script's source, or null when it is missing/unreadable (fail-open). */
function readScriptSource(scriptPath) {
  try {
    if (!fs.existsSync(scriptPath)) return null;
    return fs.readFileSync(scriptPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Scan a script's source for any token that isProtected matches. Returns the
 * block result, or null when no protected file is referenced.
 */
function scanScriptForProtectedRef(ctx, content, scriptPath, toolInput, hookData) {
  const tokens = content.match(/[^\s"'`|;&(){}[\],]+/g) || [];
  for (const token of tokens) {
    const match = ctx.isProtected(token);
    if (match && !ctx.isExempt('Bash', toolInput, hookData)) {
      return {
        blocked: true,
        match,
        vector: 'Bash(script)',
        message: ctx.fmt(match, `Bash(script: ${path.basename(scriptPath)})`),
        skipRemainingChecks: false,
      };
    }
  }
  return null;
}

/**
 * Vector 3: Script bypass detection.
 * Checks if a Bash command runs a script that contains write operations
 * AND references protected file names in its source.
 */
function checkScriptBypass(ctx, cmd, toolInput, hookData) {
  for (const scriptPath of extractScriptPaths(cmd)) {
    // Skip Vector 3 for trusted in-repo test/mock files (GH-191 + GH-141),
    // scoped to __tests__/__mocks__ dirs within repo root; symlink-safe.
    if (isTrustedTestScript(scriptPath)) continue;
    // Skip Vector 3 for scripts inside an explicitly trusted root (e.g. the
    // plugin's own orchestrator scripts).
    if (isUnderTrustedRoot(ctx.resolvedTrustedRoots, scriptPath)) continue;

    const content = readScriptSource(scriptPath);
    if (content === null) continue;

    // Only check scripts that have write operations
    if (!SCRIPT_WRITE_OPS.test(content)) continue;

    const hit = scanScriptForProtectedRef(ctx, content, scriptPath, toolInput, hookData);
    if (hit) return hit;
  }
  return { blocked: false, skipRemainingChecks: false };
}

// ─── Vector 4: inline interpreter bypass ────────────────────────────────────

function extractInlineCode(cmd, interpreterMatch) {
  const flagIdx = interpreterMatch.index;
  const afterFlag = cmd.slice(flagIdx);
  const quotedMatch = afterFlag.match(/\s-[ce]\s+(["'])([\s\S]*?)\1/);
  const unquotedMatch =
    !quotedMatch && afterFlag.match(/\s-[ce]\s+(.*?)(?:\s*(?:\||;|&&|\|\|)\s|$)/s);
  return quotedMatch ? quotedMatch[2] : unquotedMatch ? unquotedMatch[1] : cmd;
}

function checkInlineMatch(ctx, inlineCode, bareInterpreter, toolInput, hookData) {
  const tokens = extractTokens(inlineCode);
  const hasWriteOp = INLINE_INTERPRETER_WRITES.test(inlineCode);
  for (const token of tokens) {
    const match = ctx.isProtected(token);
    if (match && hasWriteOp && !ctx.isExempt('Bash', toolInput, hookData)) {
      return {
        blocked: true,
        match,
        vector: `Bash(${bareInterpreter})`,
        message: ctx.fmt(match, `Bash(${bareInterpreter})`),
        skipRemainingChecks: false,
      };
    }
  }
  if (
    BASE64_EVASION_PATTERN.test(inlineCode) &&
    hasWriteOp &&
    !ctx.isExempt('Bash', toolInput, hookData)
  ) {
    return {
      blocked: true,
      match: '(base64-encoded)',
      vector: `Bash(${bareInterpreter} base64)`,
      message: ctx.fmt('(base64-encoded)', `Bash(${bareInterpreter} base64)`),
      skipRemainingChecks: false,
    };
  }
  return null;
}

/**
 * Vector 4: Inline interpreter bypass detection.
 * Checks if a Bash command uses an inline interpreter (python3 -c, ruby -e,
 * perl -e) to write to protected files.
 */
function checkInlineInterpreterBypass(ctx, cmd, toolInput, hookData) {
  const globalPattern = new RegExp(INLINE_INTERPRETER_PATTERN.source, 'g');
  const allMatches = [...cmd.matchAll(globalPattern)];
  if (allMatches.length === 0) return { blocked: false, skipRemainingChecks: false };

  for (const interpreterMatch of allMatches) {
    const bareInterpreter = interpreterMatch[0].trim().replace(/^\/usr\/bin\/env\s+/, '');
    const inlineCode = extractInlineCode(cmd, interpreterMatch);
    const result = checkInlineMatch(ctx, inlineCode, bareInterpreter, toolInput, hookData);
    if (result) return result;
  }
  return { blocked: false, skipRemainingChecks: false };
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Bind the protector's context once and return the two bypass checkers.
 *
 * @param {object} opts
 * @param {(filePath: string) => string|null} opts.isProtected
 * @param {(toolName: string, toolInput: object, hookData?: object) => boolean} opts.isExempt
 * @param {(match: string, vector: string) => string} opts.fmt
 * @param {string[]} [opts.trustedScriptRoots]
 */
function createBypassCheckers(opts) {
  const ctx = {
    isProtected: opts.isProtected,
    isExempt: opts.isExempt,
    fmt: opts.fmt,
    resolvedTrustedRoots: resolveTrustedRoots(opts.trustedScriptRoots || []),
  };
  return {
    checkScriptBypass: (cmd, toolInput, hookData) =>
      checkScriptBypass(ctx, cmd, toolInput, hookData),
    checkInlineInterpreterBypass: (cmd, toolInput, hookData) =>
      checkInlineInterpreterBypass(ctx, cmd, toolInput, hookData),
  };
}

module.exports = {
  SCRIPT_WRITE_OPS,
  INLINE_INTERPRETER_PATTERN,
  INLINE_INTERPRETER_WRITES,
  BASE64_EVASION_PATTERN,
  extractTokens,
  createBypassCheckers,
};
