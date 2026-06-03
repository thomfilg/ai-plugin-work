/**
 * Resolve the plugin root directory from CLAUDE_PLUGIN_ROOT env var.
 *
 * CLAUDE_PLUGIN_ROOT may point to:
 * - The specific marketplace dir (e.g., .../marketplaces/work-workflow) — used by hook resolution
 * - The parent plugins dir (e.g., .../plugins) — set in .envrc
 *
 * Returns the resolved path or null if not found.
 * Falls back to __dirname-based resolution when a callerDir is provided.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * @param {string} [callerDir] - __dirname of the calling module (used for fallback)
 * @param {number} [levelsUp=2] - how many levels up from callerDir to reach the plugin root
 * @returns {string} resolved plugin root path
 */
function resolvePluginRoot(callerDir, levelsUp = 2) {
  const envRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (envRoot) {
    // Direct: already points to the plugin
    if (fs.existsSync(path.join(envRoot, 'workflows', 'work'))) return envRoot;
    // Parent: points to plugins dir — resolve to marketplace subdir
    const mp = path.join(envRoot, 'marketplaces', 'work-workflow');
    if (fs.existsSync(path.join(mp, 'workflows', 'work'))) return mp;
  }
  // Fallback: resolve from caller's __dirname
  if (callerDir) {
    let dir = callerDir;
    for (let i = 0; i < levelsUp; i++) dir = path.join(dir, '..');
    if (fs.existsSync(path.join(dir, 'workflows', 'work'))) return dir;
  }
  return null;
}

/**
 * Like {@link resolvePluginRoot} but honours `CLAUDE_PLUGIN_ROOT` when set:
 *
 *  - env set AND probing matches a known layout → probed path (more specific).
 *  - env set AND probing matches an UNRELATED path (probed didn't derive from
 *    env) → env value verbatim. The user's explicit setting wins over an
 *    incidentally-matching probe elsewhere on disk.
 *  - env set AND probing fails → env value verbatim.
 *  - env unset → identical to {@link resolvePluginRoot}.
 *
 * Use this in contexts where the literal env value carries meaning to the
 * consumer — typically `${CLAUDE_PLUGIN_ROOT}` string substitution in skill
 * prompts and registry entries — and falling through to an unrelated probe
 * would silently rewrite paths to the wrong install.
 *
 * @param {string} [callerDir]
 * @param {number} [levelsUp=2]
 * @returns {string|null}
 */
function resolvePluginRootHonouringEnv(callerDir, levelsUp = 2) {
  const rawEnvRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const envRoot = rawEnvRoot ? path.resolve(rawEnvRoot) : '';
  const probed = resolvePluginRoot(callerDir, levelsUp);
  if (probed) {
    if (envRoot && probed !== envRoot && !probed.startsWith(envRoot + path.sep)) {
      return envRoot;
    }
    return probed;
  }
  return envRoot || null;
}

/**
 * @param {string} [callerDir]
 * @param {number} [levelsUp]
 * @returns {{ workDir: string, libDir: string }}
 */
function resolvePluginPaths(callerDir, levelsUp) {
  const root = resolvePluginRoot(callerDir, levelsUp);
  return {
    workDir: root
      ? path.join(root, 'workflows', 'work')
      : path.join(callerDir, '..', 'work'),
    libDir: root ? path.join(root, 'workflows', 'lib') : path.join(callerDir, '..', 'lib'),
  };
}

module.exports = { resolvePluginRoot, resolvePluginRootHonouringEnv, resolvePluginPaths };
