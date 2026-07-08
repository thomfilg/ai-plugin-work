'use strict';

/**
 * Shared command analysis utilities (vendored into heimdall so the plugin is
 * self-contained — originally from ~/.claude/hooks/lib/command-analysis.js).
 *
 * Detects when a Bash command executes a script that may target protected
 * paths even when the script path itself doesn't reveal the target (e.g.
 * `node /tmp/script.js` where the script internally writes to a locked dir).
 */

const fs = require('node:fs');

/**
 * Extract interpreter script paths from a Bash command.
 * Matches `node /tmp/x.js`, `python3 /tmp/x.py`, `bash /tmp/x.sh`, etc.
 * Does NOT match inline eval (`node -e`, `python -c`) — handled elsewhere.
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

/** Read a script and report whether it references any protected pattern. */
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

/** Main entry: does the command (or any script it runs) touch a protected path? */
function commandAccessesProtectedPaths(command, protectedPatterns) {
  const scripts = extractScriptPaths(command);
  for (const scriptPath of scripts) {
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
