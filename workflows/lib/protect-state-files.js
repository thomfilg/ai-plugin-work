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
const SCRIPT_WRITE_OPS = /\b(?:writeFileSync|appendFileSync|writeFile|createWriteStream|unlink|unlinkSync|rmSync|renameSync|copyFileSync|fs\.promises\.writeFile|fs\.promises\.rm)\b|>{1,2}\s*['"]|\btee\s+-a\b|open\(.*['"]w/;

/** Interpreter patterns to extract script paths from Bash commands */
const INTERPRETER_PATTERN = /\b(?:node|python[23]?|ruby|perl|bash|sh)\s+(?:--?\w[\w-]*(?:=\S+)?\s+)*["']?([/\w._-]+\.(?:js|mjs|cjs|py|rb|pl|sh))["']?/g;

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
    ...workflows.map(wf => path.basename(wf.stateFile)),
    ...workflows.map(wf => path.basename(wf.evidenceFile)),
    ...extraFiles.map(f => path.basename(f)),
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
        const rawTokens = cmd.match(/[^\s"'|;&()]+/g) || [];
        const tokens = rawTokens.flatMap(t => {
          // Split on redirect operators (keeping what's after them)
          // "x>>.state.json" → ["x", ".state.json"]
          // ">>.state.json" → [".state.json"]
          const redirectSplit = t.split(/>{1,2}|</);
          // Split on = for dd of=path patterns
          return redirectSplit.flatMap(part => part.split('=')).filter(Boolean);
        });
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
  function checkScriptBypass(cmd, toolInput, hookData) {
    const scripts = extractScriptPaths(cmd);
    for (const scriptPath of scripts) {
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

  return { check, checkScriptBypass };
}

module.exports = {
  FILE_WRITE_TOOLS,
  BASH_WRITE_OPS,
  NODE_FS_WRITES,
  SCRIPT_WRITE_OPS,
  buildProtectedBasenames,
  basenameProtector,
  createFileProtector,
};
