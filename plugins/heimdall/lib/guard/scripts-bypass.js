'use strict';

/**
 * Script-bypass detection: a Bash command that runs a script which itself
 * writes to a protected directory. Only meaningful for directory entries.
 */

const fs = require('node:fs');
const path = require('node:path');
const { commandAccessesProtectedPaths } = require('../command-analysis');

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

const WRITE_OP_LINE =
  /(?:writeFileSync|appendFileSync|writeFile\b|createWriteStream|\bunlink|\brmSync|\brmdir|renameSync|\brename\b|copyFileSync|\bexec|fs\.promises\.(?:writeFile|rm|rename)|fs\.writeFile|fs\.appendFile|>{1,2}\s*['"]|>\|\s*['"]|\btee\s+-a\b|open\([^)]*['"][^'"]*[wax])/;

// Variables assigned a STRING LITERAL that contains a protected marker — a path
// stored for a later write, e.g. `const target = '/repo/.claude/settings.json'`.
// Only bare string literals are tainted, NOT calls: `const d =
// fs.readFileSync('<protected>')` binds file CONTENT, not a path, and writing
// that content elsewhere is a read, not a protected-path write.
function taintedPathVars(content, markerPats) {
  const vars = new Set();
  const assignRe = /([A-Za-z_$][\w$]*)\s*=\s*(['"`])((?:\\.|(?!\2).)*)\2/g;
  let m;
  while ((m = assignRe.exec(content)) !== null) {
    if (markerPats.some((p) => p.test(m[3]))) vars.add(m[1]);
  }
  return vars;
}

/**
 * Correlate the write op to the protected path: block when a statement both
 * performs a write AND references the protected marker (GH-657) — directly, or
 * via a variable that was assigned a marker-bearing path literal (closes the
 * variable-indirection bypass). This stops the false positive where a script
 * merely READS a protected path and writes elsewhere (e.g. to /tmp), or where a
 * test file names a marker as a fixture while writing to temp dirs, without
 * letting `const t = '<protected>/x'; writeFileSync(t, …)` escape.
 */
function scriptWritesToProtected(content, entry) {
  const markerPats = scriptPatternsFor(entry);
  const tainted = taintedPathVars(content, markerPats);
  const taintedRe = tainted.size
    ? new RegExp(`\\b(?:${[...tainted].map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`)
    : null;
  for (const stmt of content.split(/[\n;]/)) {
    if (!WRITE_OP_LINE.test(stmt)) continue;
    if (markerPats.some((p) => p.test(stmt))) return true;
    if (taintedRe && taintedRe.test(stmt)) return true;
  }
  return false;
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
  // Require the write op and the protected-path reference to co-occur in one
  // statement (GH-657). A script that only reads the protected path — or one
  // (e.g. a test file) that names it as a fixture while writing to temp — is not
  // a bypass and must not be blocked.
  return scriptWritesToProtected(content, entry)
    ? { blocked: true, scriptPath: found.scriptPath }
    : { blocked: false };
}

module.exports = { checkScriptBypass };
