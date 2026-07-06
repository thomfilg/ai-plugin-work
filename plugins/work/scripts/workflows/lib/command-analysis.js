'use strict';

/**
 * Shared command analysis utilities for the work-workflow hooks.
 *
 * Detects when a Bash command executes a script that may target protected
 * paths — even when the script path itself doesn't reveal the target (e.g.
 * `node /tmp/script.js` where the script internally runs a blocked operation).
 *
 * Used by: enforce-agent-usage.js (script-bypass detection).
 */

const fs = require('fs');

/**
 * Extract script paths from a Bash command that runs an interpreter. Matches
 * `node /path/x.js`, `bash /tmp/run.sh`, etc.; ignores inline eval (`-e`/`-c`).
 * @param {string} command
 * @returns {string[]}
 */
function extractScriptPaths(command) {
  if (!command) return [];
  const scripts = [];
  const interpreterPattern =
    /\b(?:node|python[23]?|ruby|perl|bash|sh)\s+(?:--?\w[\w-]*(?:=\S+)?\s+)*["']?([/\w._-]+\.(?:js|mjs|cjs|py|rb|pl|sh))["']?/g;
  let match;
  while ((match = interpreterPattern.exec(command)) !== null) {
    const scriptPath = match[1];
    if (!scriptPath.startsWith('-')) scripts.push(scriptPath);
  }
  return scripts;
}

/**
 * Read a script file and check if it references any of the given protected
 * patterns (RegExp or string literal).
 * @param {string} scriptPath
 * @param {Array<RegExp|string>} protectedPatterns
 * @returns {{found: boolean, matches: string[]}}
 */
function scriptReferencesProtectedPaths(scriptPath, protectedPatterns) {
  try {
    if (!fs.existsSync(scriptPath)) return { found: false, matches: [] };
    const content = fs.readFileSync(scriptPath, 'utf8');
    const matches = [];
    for (const pattern of protectedPatterns) {
      if (pattern instanceof RegExp) {
        if (pattern.test(content)) matches.push(pattern.toString());
      } else if (content.includes(pattern)) {
        matches.push(pattern);
      }
    }
    return { found: matches.length > 0, matches };
  } catch {
    return { found: false, matches: [] };
  }
}

/**
 * Whether a Bash command (including any scripts it runs) accesses protected
 * paths. Main entry point.
 * @param {string} command
 * @param {Array<RegExp|string>} protectedPatterns
 * @returns {{found: boolean, scriptPath: string|null, matches: string[]}}
 */
function commandAccessesProtectedPaths(command, protectedPatterns) {
  for (const scriptPath of extractScriptPaths(command)) {
    const result = scriptReferencesProtectedPaths(scriptPath, protectedPatterns);
    if (result.found) return { found: true, scriptPath, matches: result.matches };
  }
  return { found: false, scriptPath: null, matches: [] };
}

module.exports = {
  extractScriptPaths,
  scriptReferencesProtectedPaths,
  commandAccessesProtectedPaths,
};
