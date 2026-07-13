'use strict';

/**
 * Shared command analysis utilities for the work-workflow hooks.
 *
 * Detects when a Bash command executes a script that may target protected
 * paths — even when the script path itself doesn't reveal the target (e.g.
 * `node /tmp/script.js` where the script internally runs a blocked operation).
 *
 * Used by: enforce-agent-usage.js (script-bypass detection).
 *
 * NOTE: the interpreter regex intentionally mirrors the one in
 * `protect-state-files.js` (same detection surface across the plugin's two
 * script-bypass guards); the surrounding logic here is written in a functional
 * style so the module stays independently readable.
 */

const fs = require('fs');

/**
 * Interpreter invocations that run a script file: `node /path/x.js`,
 * `bash /tmp/run.sh`, etc. Inline eval (`-e`/`-c`) has no capture and is ignored.
 */
const INTERPRETER_PATTERN =
  /\b(?:node|python[23]?|ruby|perl|bash|sh)\s+(?:--?\w[\w-]*(?:=\S+)?\s+)*["']?([/\w._-]+\.(?:js|mjs|cjs|py|rb|pl|sh))["']?/g;

/**
 * Extract script paths from a Bash command that runs an interpreter.
 * @param {string} command
 * @returns {string[]}
 */
function extractScriptPaths(command) {
  if (!command) return [];
  INTERPRETER_PATTERN.lastIndex = 0;
  return [...command.matchAll(INTERPRETER_PATTERN)]
    .map((m) => m[1])
    .filter((scriptPath) => scriptPath && !scriptPath.startsWith('-'));
}

/**
 * Does `content` reference a single protected pattern? Returns the match label
 * (the pattern source) when it hits, else `null`.
 * @param {string} content
 * @param {RegExp|string} pattern
 * @returns {string|null}
 */
function patternMatchLabel(content, pattern) {
  if (pattern instanceof RegExp) {
    return pattern.test(content) ? pattern.toString() : null;
  }
  return content.includes(pattern) ? pattern : null;
}

/**
 * Read a script file and check whether it references any of the given protected
 * patterns (RegExp or string literal).
 * @param {string} scriptPath
 * @param {Array<RegExp|string>} protectedPatterns
 * @returns {{found: boolean, matches: string[]}}
 */
function scriptReferencesProtectedPaths(scriptPath, protectedPatterns) {
  let content;
  try {
    if (!fs.existsSync(scriptPath)) return { found: false, matches: [] };
    content = fs.readFileSync(scriptPath, 'utf8');
  } catch {
    return { found: false, matches: [] };
  }
  const matches = protectedPatterns
    .map((pattern) => patternMatchLabel(content, pattern))
    .filter((label) => label !== null);
  return { found: matches.length > 0, matches };
}

/**
 * Whether a Bash command (including any scripts it runs) accesses protected
 * paths. Main entry point.
 * @param {string} command
 * @param {Array<RegExp|string>} protectedPatterns
 * @returns {{found: boolean, scriptPath: string|null, matches: string[]}}
 */
function commandAccessesProtectedPaths(command, protectedPatterns) {
  const hit = extractScriptPaths(command)
    .map((scriptPath) => ({
      scriptPath,
      ...scriptReferencesProtectedPaths(scriptPath, protectedPatterns),
    }))
    .find((result) => result.found);
  return hit
    ? { found: true, scriptPath: hit.scriptPath, matches: hit.matches }
    : { found: false, scriptPath: null, matches: [] };
}

module.exports = {
  extractScriptPaths,
  scriptReferencesProtectedPaths,
  commandAccessesProtectedPaths,
};
