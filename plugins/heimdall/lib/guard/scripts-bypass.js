'use strict';

/**
 * Script-bypass detection: a Bash command that runs a script which itself
 * writes to a protected directory. Only meaningful for directory entries.
 */

const fs = require('node:fs');
const path = require('node:path');
const { commandAccessesProtectedPaths } = require('../command-analysis');

const WRITE_OPS_IN_SCRIPT =
  /\b(?:writeFileSync|appendFileSync|writeFile|createWriteStream|unlink|unlinkSync|rmSync|renameSync|rename|rmdir|rmdirSync|copyFileSync|exec|execSync|fs\.promises\.writeFile|fs\.promises\.rm|fs\.promises\.rename|fs\.writeFile|fs\.appendFile)\b/;

function isTrustedScript(scriptPath, entries) {
  for (const entry of entries) {
    for (const subdir of entry.trustedSubdirs || []) {
      if (scriptPath.includes(path.join(entry.dir, subdir) + '/')) return true;
    }
  }
  return false;
}

function scriptPatternsFor(entry) {
  const patterns = [];
  for (const marker of entry.markers) {
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    patterns.push(new RegExp(`\\/${escaped}\\/`, 'i'));
    patterns.push(new RegExp(`${escaped}\\/`, 'i'));
  }
  return patterns;
}

function scriptHasWriteOps(content) {
  return (
    WRITE_OPS_IN_SCRIPT.test(content) ||
    />{1,2}\s*['"]/.test(content) ||
    />\|\s*['"]/.test(content) ||
    /\btee\s+-a\b/.test(content) ||
    /open\(.*['"]w/.test(content)
  );
}

/**
 * Inspect a command for script-driven writes to a protected dir entry.
 *
 * Fires for ANY non-trusted script the command runs whose content references
 * the protected path AND performs a write — regardless of where the script
 * lives. The whole point is to catch an EXTERNAL script (e.g. `node
 * /tmp/eviL.js` or `node scripts/deploy.js`) that writes into a protected dir,
 * so location-based gates (under-the-dir / temp-path) are intentionally NOT
 * applied here; only `trustedSubdirs` scripts are exempt.
 * @returns {{ blocked: true, error?: string } | { blocked: false }}
 */
function checkScriptBypass(collapsedCmd, entry, entries) {
  const found = commandAccessesProtectedPaths(collapsedCmd, scriptPatternsFor(entry));
  if (!found.found || isTrustedScript(found.scriptPath, entries)) {
    return { blocked: false };
  }
  let content;
  try {
    content = fs.readFileSync(found.scriptPath, 'utf8');
  } catch (err) {
    return { blocked: true, error: `Cannot read script "${found.scriptPath}": ${err.message}` };
  }
  return scriptHasWriteOps(content)
    ? { blocked: true, scriptPath: found.scriptPath }
    : { blocked: false };
}

module.exports = { checkScriptBypass };
