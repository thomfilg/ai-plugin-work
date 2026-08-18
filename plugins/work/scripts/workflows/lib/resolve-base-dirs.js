/**
 * resolve-base-dirs.js — single source of truth for WORKTREES_BASE + TASKS_BASE.
 *
 * Both `lib/plugin-config.js` and `work/work-next.js` used to carry an
 * identical block:
 *
 *   const TASKS_BASE =
 *     getConfig('TASKS_BASE') || (WORKTREES_BASE ? path.join(WORKTREES_BASE, 'tasks') : '');
 *
 * That `||` is a silent guess. `getConfig` resolves `process.env[key] ||
 * config[key]` and never reads `.envrc`, and `lib/config.js` USED TO derive its
 * own `TASKS_BASE` the same way — so a process that starts without the
 * environment loaded got a path that looks valid and is wrong. Worse,
 * `lib/config.js` ALSO guesses `WORKTREES_BASE` as
 * `path.dirname(git rev-parse --show-toplevel)` when the env is missing, so the
 * two guesses compounded: one process resolved `<worktrees>/tasks/<TICKET>`
 * while another resolved `<repo-parent>/tasks/<TICKET>`. Reports got written to
 * one and read from the other, and the gates reported
 * "Missing report: tests.check.md" for files that exist.
 *
 * `lib/config.js` no longer derives TASKS_BASE at all — it is `process.env
 * .TASKS_BASE || null`. The `!== derived` check in `configuredTasksBase` below
 * therefore has nothing left to catch from that direction; it stays as a guard
 * against the derivation coming back, and costs one comparison.
 *
 * A wrong-but-plausible path is worse than no path, so this module never
 * guesses. When WORKTREES_BASE resolves but TASKS_BASE was never configured it
 * returns an EMPTY TASKS_BASE plus an `error` string naming both values.
 *
 * Empty-and-explained rather than thrown, because every caller already has a
 * "not configured" branch and those branches carry the contract: the
 * orchestrators (`work-next.js`, `check-next.js`, `follow-up-next.js`) must
 * always emit a structured `*_instruction` JSON, and the PostToolUse hooks must
 * always fail open. Callers surface `error` in that branch — see the call sites
 * — so the failure is loud without breaking either contract.
 */

'use strict';

const path = require('path');

/**
 * Explain why TASKS_BASE was refused, naming both values.
 *
 * @param {string} worktreesBase - the WORKTREES_BASE that WAS resolved.
 * @param {string} guessed - the `<WORKTREES_BASE>/tasks` path being refused.
 * @returns {string}
 */
function tasksBaseNotConfigured(worktreesBase, guessed) {
  return (
    `TASKS_BASE is not configured (WORKTREES_BASE=${worktreesBase}). ` +
    `Refusing to guess ${guessed} — a wrong-but-plausible tasks dir splits report writers ` +
    `from report readers and surfaces as "Missing report: <name>.check.md" for files that exist. ` +
    `Set TASKS_BASE explicitly (e.g. in .envrc: export TASKS_BASE=${guessed}) and make sure the ` +
    `environment is loaded in this process.`
  );
}

/**
 * TASKS_BASE from a source that actually configured it, '' otherwise.
 *
 * Two sources qualify: an explicit `env.TASKS_BASE`, always trusted; and
 * `getConfig('TASKS_BASE')` when it differs from `derived`, i.e. when something
 * other than the `<WORKTREES_BASE>/tasks` derivation supplied it. Since
 * `lib/config.js` stopped deriving, the second branch only ever sees configured
 * values — it is kept so a reintroduced derivation is refused here too.
 *
 * @param {Function} getConfig - `lib/get-config` accessor.
 * @param {object} env - Environment to read the explicit setting from.
 * @param {string} derived - The `<WORKTREES_BASE>/tasks` path to refuse.
 * @returns {string}
 */
function configuredTasksBase(getConfig, env, derived) {
  const fromEnv = (env && env.TASKS_BASE) || '';
  if (fromEnv) return fromEnv;
  const fromConfig = getConfig('TASKS_BASE') || '';
  return fromConfig && fromConfig !== derived ? fromConfig : '';
}

/**
 * Resolve the plugin's two base directories.
 *
 * Nothing configured TASKS_BASE and WORKTREES_BASE known → `{TASKS_BASE: '', error}`.
 * Nothing configured TASKS_BASE and WORKTREES_BASE unknown → both empty, `error`
 * null: the caller's existing "nothing is configured" branch already covers it.
 *
 * @param {Function} getConfig - `lib/get-config` accessor.
 * @param {object} [env=process.env] - Environment to read the explicit setting from.
 * @returns {{WORKTREES_BASE: string, TASKS_BASE: string, error: string|null}}
 */
function resolveBaseDirs(getConfig, env = process.env) {
  const WORKTREES_BASE = getConfig('WORKTREES_BASE') || '';
  const derived = WORKTREES_BASE ? path.join(WORKTREES_BASE, 'tasks') : '';
  const TASKS_BASE = configuredTasksBase(getConfig, env, derived);

  if (TASKS_BASE) return { WORKTREES_BASE, TASKS_BASE, error: null };
  if (!WORKTREES_BASE) return { WORKTREES_BASE: '', TASKS_BASE: '', error: null };
  return {
    WORKTREES_BASE,
    TASKS_BASE: '',
    error: tasksBaseNotConfigured(WORKTREES_BASE, derived),
  };
}

module.exports = { resolveBaseDirs, tasksBaseNotConfigured };
