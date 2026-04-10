/**
 * protect-state-files.js
 *
 * Generic, reusable file protection for Claude Code hooks.
 * Blocks AI from writing to protected files via any vector:
 *   - Edit / Write / MultiEdit (file_path basename)
 *   - Bash shell operators (>, >>, tee, cp, mv, dd of=)
 *   - Node.js fs calls in Bash (writeFileSync, appendFileSync, etc.)
 *
 * Usage:
 *   const { createFileProtector, basenameProtector } = require('./lib/protect-state-files');
 *
 *   const protector = createFileProtector({
 *     isProtected: basenameProtector(new Set(['.secret.json', '.state.json'])),
 *     isExempt: (toolName, toolInput, hookData) => hookData?.isAdmin === true,
 *     formatMessage: (match, vector) => `BLOCKED: ${vector} to ${match}\n`,
 *   });
 *
 *   // In your hook handler:
 *   const result = protector.check(toolName, toolInput, hookData);
 *   if (result.blocked) {
 *     process.stderr.write(result.message);
 *     process.exit(2);
 *   }
 *   if (result.skipRemainingChecks) return; // file tool with no match — no further checks needed
 */

const fs = require('fs');
const path = require('path');

// ─── Constants ──────────────────────────────────────────────────────────────

/** Tools that write via file_path */
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

/** Shell write operators — redirects, tee, cp, mv, dd */
const BASH_WRITE_OPS = /(?:>{1,2}|\btee\b|\bcp\b|\bmv\b|\bdd\b.*\bof=)/;

/** Node.js fs write calls executed via Bash (node -e, inline scripts) */
const NODE_FS_WRITES = /\b(?:writeFileSync|appendFileSync|writeFile|createWriteStream)\b/;

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

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a Set of basenames from workflow definitions + extras.
 * Applies path.basename() defensively so callers can pass full paths or bare names.
 *
 * @param {Array<{stateFile: string, evidenceFile: string}>} workflows
 * @param {string[]} [extraFiles]
 * @returns {Set<string>}
 */
function buildProtectedBasenames(workflows, extraFiles = []) {
  return new Set([
    ...workflows.map((wf) => path.basename(wf.stateFile)),
    ...workflows.map((wf) => path.basename(wf.evidenceFile)),
    ...extraFiles.map((f) => path.basename(f)),
  ]);
}

/**
 * Create a basename-based isProtected function from a Set.
 * @param {Set<string>} basenames
 * @returns {(filePath: string) => string|null} — returns matched basename or null
 */
function basenameProtector(basenames) {
  return (filePath) => {
    const bn = path.basename(filePath);
    return basenames.has(bn) ? bn : null;
  };
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a file protector instance.
 *
 * @param {object} opts
 * @param {(filePath: string) => string|null} opts.isProtected
 *   Returns a label (e.g. matched basename) if the file is protected, null otherwise.
 *   Called with the resolved file path from tool_input.
 *
 * @param {(toolName: string, toolInput: object, hookData?: object) => boolean} [opts.isExempt]
 *   Returns true if this specific call should be allowed despite targeting a protected file.
 *   Called before blocking. Defaults to () => false.
 *
 * @param {(match: string, vector: string) => string} [opts.formatMessage]
 *   Custom block message formatter. Receives the matched label and vector ('Edit'|'Bash'|etc).
 *   Defaults to a generic message.
 *
 * @returns {{ check: (toolName: string, toolInput: object, hookData?: object) => CheckResult }}
 *
 * @typedef {object} CheckResult
 * @property {boolean} blocked — true if the operation should be blocked
 * @property {string} [match] — the label from isProtected (e.g. basename)
 * @property {string} [vector] — the attack vector ('Edit'|'Write'|'MultiEdit'|'Bash')
 * @property {string} [message] — formatted block message
 * @property {boolean} skipRemainingChecks — true for file tools (Edit/Write/MultiEdit) whether blocked or not
 */
function createFileProtector(opts) {
  const { isProtected, isExempt = () => false, formatMessage } = opts;

  const defaultMessage = (match, vector) =>
    `BLOCKED: Direct ${vector} to ${match} is not allowed.\n` +
    `Protected files must only be modified through their designated scripts.\n`;

  const fmt = formatMessage || defaultMessage;

  function check(toolName, toolInput, hookData) {
    // ── Vector 1: Edit / Write / MultiEdit ────────────────────────────────
    if (FILE_WRITE_TOOLS.has(toolName)) {
      const filePath = toolInput?.file_path || '';
      if (!filePath) return { blocked: false, skipRemainingChecks: true };

      const match = isProtected(filePath);
      if (match && !isExempt(toolName, toolInput, hookData)) {
        return {
          blocked: true,
          match,
          vector: toolName,
          message: fmt(match, toolName),
          skipRemainingChecks: true,
        };
      }
      return { blocked: false, skipRemainingChecks: true };
    }

    // ── Vector 2: Bash shell writes ───────────────────────────────────────
    if (toolName === 'Bash') {
      const cmd = String(toolInput?.command || '');
      const hasShellWrite = BASH_WRITE_OPS.test(cmd);
      const hasNodeWrite = NODE_FS_WRITES.test(cmd);

      if (hasShellWrite || hasNodeWrite) {
        // Extract tokens, then normalize by stripping operator prefixes
        // Handles: ">>.state.json", "of=.state.json", ">.state.json", "x>>.state.json"
        const tokens = extractTokens(cmd);
        for (const token of tokens) {
          const match = isProtected(token);
          if (match && !isExempt(toolName, toolInput, hookData)) {
            return {
              blocked: true,
              match,
              vector: 'Bash',
              message: fmt(match, 'Bash'),
              skipRemainingChecks: false,
            };
          }
        }
      }

      // ── Vector 3: Script bypass — node/python/etc script with write ops ──
      const scriptResult = checkScriptBypass(cmd, toolInput, hookData);
      if (scriptResult.blocked) return scriptResult;

      // ── Vector 4: Inline interpreter bypass — python3 -c, ruby -e, perl -e ──
      const inlineResult = checkInlineInterpreterBypass(cmd, toolInput, hookData);
      if (inlineResult.blocked) return inlineResult;
    }

    return { blocked: false, skipRemainingChecks: false };
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

  /**
   * Vector 3: Script bypass detection.
   * Checks if a Bash command runs a script that contains write operations
   * AND references protected file names in its source.
   *
   * @param {string} cmd — Bash command string
   * @param {object} toolInput
   * @param {object} [hookData]
   * @returns {CheckResult}
   */
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

  function checkScriptBypass(cmd, toolInput, hookData) {
    const scripts = extractScriptPaths(cmd);
    for (const scriptPath of scripts) {
      // Skip Vector 3 for trusted in-repo test/mock files (GH-191 + GH-141).
      // Scoped to __tests__/__mocks__ dirs within repo root; symlink-safe via realpathSync.
      // Resolves the GH-141 false positive: `node --test workflow-state.test.js` is no longer
      // blocked because the test file is in __tests__/, within the repo root, and git-tracked.
      if (isTrustedTestScript(scriptPath)) continue;

      let content;
      try {
        if (!fs.existsSync(scriptPath)) continue;
        content = fs.readFileSync(scriptPath, 'utf8');
      } catch {
        continue; // Can't read script → fail-open
      }

      // Only check scripts that have write operations
      if (!SCRIPT_WRITE_OPS.test(content)) continue;

      // Check if script content references any protected file
      // We scan the script source for any token that isProtected matches
      const tokens = content.match(/[^\s"'`|;&(){}[\],]+/g) || [];
      for (const token of tokens) {
        const match = isProtected(token);
        if (match && !isExempt('Bash', toolInput, hookData)) {
          return {
            blocked: true,
            match,
            vector: 'Bash(script)',
            message: fmt(match, `Bash(script: ${path.basename(scriptPath)})`),
            skipRemainingChecks: false,
          };
        }
      }
    }
    return { blocked: false, skipRemainingChecks: false };
  }

  /**
   * Vector 4: Inline interpreter bypass detection.
   * Checks if a Bash command uses an inline interpreter (python3 -c, ruby -e, perl -e)
   * to write to protected files.
   *
   * @param {string} cmd — Bash command string
   * @param {object} toolInput
   * @param {object} [hookData]
   * @returns {CheckResult}
   */
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

  function checkInlineInterpreterBypass(cmd, toolInput, hookData) {
    // Use global scan to check ALL inline interpreter occurrences in compound commands
    // (e.g. `python3 -c "print(1)"; python3 -c "open('.state.json','w')..."`)
    const globalPattern = new RegExp(INLINE_INTERPRETER_PATTERN.source, 'g');
    const allMatches = [...cmd.matchAll(globalPattern)];
    if (allMatches.length === 0) return { blocked: false, skipRemainingChecks: false };

    for (const interpreterMatch of allMatches) {
      // Extract the interpreter name and flag from the match (e.g. "python3 -c", "ruby -e")
      const matchStr = interpreterMatch[0].trim();
      // Remove /usr/bin/env prefix if present to get bare interpreter + flag
      const bareInterpreter = matchStr.replace(/^\/usr\/bin\/env\s+/, '');

      // Extract the inline code portion (everything after -c/-e flag).
      // This scopes filename and base64 checks to only the interpreter code,
      // avoiding false positives when protected filenames or base64 appear
      // in other command segments (e.g. `echo .state.json; python3 -c "..."`)
      // or in pipeline stages (e.g. `python3 -c "print('hello')" | base64`).
      const flagIdx = interpreterMatch.index;
      const afterFlag = cmd.slice(flagIdx);
      // Try to extract the quoted code argument first (respects quotes around inline code).
      // If unquoted, capture up to the first unquoted shell operator (|, ;, &&, ||).
      const quotedMatch = afterFlag.match(/\s-[ce]\s+(["'])([\s\S]*?)\1/);
      const unquotedMatch =
        !quotedMatch && afterFlag.match(/\s-[ce]\s+(.*?)(?:\s*(?:\||;|&&|\|\|)\s|$)/s);
      const inlineCode = quotedMatch ? quotedMatch[2] : unquotedMatch ? unquotedMatch[1] : cmd; // fallback to full cmd

      // Check tokens from inline code only (not full cmd)
      const tokens = extractTokens(inlineCode);

      // Check for direct protected filename reference + write operation (scoped to inline code)
      const hasWriteOp = INLINE_INTERPRETER_WRITES.test(inlineCode);
      for (const token of tokens) {
        const match = isProtected(token);
        if (match && hasWriteOp && !isExempt('Bash', toolInput, hookData)) {
          return {
            blocked: true,
            match,
            vector: `Bash(${bareInterpreter})`,
            message: fmt(match, `Bash(${bareInterpreter})`),
            skipRemainingChecks: false,
          };
        }
      }

      // Base64 evasion: block when all three signals present (interpreter + base64 keyword + write op)
      // even without a visible protected filename, since the filename may be base64-encoded.
      // This is an intentional over-blocking tradeoff — see GH-107 spec "Open Questions" section.
      // False positives on non-protected file writes are accepted to prevent evasion.
      // Scoped to inline code only — base64 CLI usage outside the -c/-e code is not flagged.
      if (BASE64_EVASION_PATTERN.test(inlineCode) && hasWriteOp) {
        if (!isExempt('Bash', toolInput, hookData)) {
          return {
            blocked: true,
            match: '(base64-encoded)',
            vector: `Bash(${bareInterpreter} base64)`,
            message: fmt('(base64-encoded)', `Bash(${bareInterpreter} base64)`),
            skipRemainingChecks: false,
          };
        }
      } // end base64 evasion check
    } // end for each interpreter match

    return { blocked: false, skipRemainingChecks: false };
  }

  return { check, checkScriptBypass, checkInlineInterpreterBypass };
}

module.exports = {
  FILE_WRITE_TOOLS,
  BASH_WRITE_OPS,
  NODE_FS_WRITES,
  SCRIPT_WRITE_OPS,
  INLINE_INTERPRETER_PATTERN,
  INLINE_INTERPRETER_WRITES,
  BASE64_EVASION_PATTERN,
  buildProtectedBasenames,
  basenameProtector,
  createFileProtector,
};
