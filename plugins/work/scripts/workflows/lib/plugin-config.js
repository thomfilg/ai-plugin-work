/**
 * plugin-config.js — shared resolver for the /work plugin's dirs + config.
 *
 * The /follow-up and /check orchestrators (and their auto-advance hooks) all
 * need the same boilerplate: resolve the plugin root from the /work directory,
 * load `get-config`, and derive WORKTREES_BASE / TASKS_BASE. Centralising it
 * here keeps the call sites in sync and removes the duplicate-block the quality
 * gate flagged across follow-up + check.
 */

'use strict';

const path = require('path');

/**
 * @param {string} fromWorkDir - absolute path to the plugin's `work` directory.
 * @returns {{workDir:string, libDir:string, getConfig:Function, WORKTREES_BASE:string, TASKS_BASE:string}}
 */
function resolvePluginConfig(fromWorkDir) {
  const { resolvePluginPaths } = require(path.join(fromWorkDir, 'lib', 'resolve-plugin-root'));
  const { workDir, libDir } = resolvePluginPaths(fromWorkDir, 2);
  const getConfig = require(path.join(libDir, 'get-config'));
  const WORKTREES_BASE = getConfig('WORKTREES_BASE') || '';
  const TASKS_BASE =
    getConfig('TASKS_BASE') || (WORKTREES_BASE ? path.join(WORKTREES_BASE, 'tasks') : '');
  return { workDir, libDir, getConfig, WORKTREES_BASE, TASKS_BASE };
}

module.exports = { resolvePluginConfig };
