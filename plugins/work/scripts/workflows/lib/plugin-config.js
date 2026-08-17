/**
 * plugin-config.js — shared resolver for the /work plugin's dirs + config.
 *
 * The /follow-up and /check orchestrators (and their auto-advance hooks) all
 * need the same boilerplate: resolve the plugin root from the /work directory,
 * load `get-config`, and derive WORKTREES_BASE / TASKS_BASE. Centralising it
 * here keeps the call sites in sync and removes the duplicate-block the quality
 * gate flagged across follow-up + check.
 *
 * The WORKTREES_BASE/TASKS_BASE pair itself lives in `resolve-base-dirs.js`,
 * shared with `work/work-next.js` — see that module for why TASKS_BASE is never
 * guessed from WORKTREES_BASE.
 */

'use strict';

const path = require('path');

const { resolveBaseDirs } = require('./resolve-base-dirs');

/**
 * `configError` is a non-null explanation when TASKS_BASE came back empty
 * because it was never configured (as opposed to nothing being configured at
 * all). Callers that render a user-facing "blocked" instruction must surface it.
 *
 * @param {string} fromWorkDir - absolute path to the plugin's `work` directory.
 * @returns {{workDir:string, libDir:string, getConfig:Function, WORKTREES_BASE:string, TASKS_BASE:string, configError:string|null}}
 */
function resolvePluginConfig(fromWorkDir) {
  const { resolvePluginPaths } = require(path.join(fromWorkDir, 'lib', 'resolve-plugin-root'));
  const { workDir, libDir } = resolvePluginPaths(fromWorkDir, 2);
  const getConfig = require(path.join(libDir, 'get-config'));
  const { WORKTREES_BASE, TASKS_BASE, error } = resolveBaseDirs(getConfig);
  return { workDir, libDir, getConfig, WORKTREES_BASE, TASKS_BASE, configError: error };
}

module.exports = { resolvePluginConfig };
