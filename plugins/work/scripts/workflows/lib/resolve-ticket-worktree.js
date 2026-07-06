'use strict';

/**
 * resolve-ticket-worktree.js — cwd-independent ticket → worktree resolution
 * (ECHO-5322 issue 2).
 *
 * Problem: `*-next.js` phase runners historically resolved the target
 * worktree via `git rev-parse --show-toplevel` from the CALLER's cwd. When
 * the orchestrator (or a dispatched checker agent) runs them from the tasks
 * dir (`<WORKTREES_BASE>/tasks/<TICKET>`, non-git) they fail or false-block,
 * and when run from the plugin source checkout they silently target the
 * WRONG repo (the plugin itself). Every agent had to rediscover this and
 * prepend `cd <worktree> && ...`.
 *
 * Fix: resolve the worktree from the ticket id + env config first — the same
 * `WORKTREES_BASE/<REPO_NAME>-<safeTicket>` convention work-next.js and the
 * step-enrichments use (centralized in lib/config.js `config.worktreeDir`).
 * Cwd git-detection remains as a fallback, but only when it points at a
 * checkout whose toplevel differs from the plugin checkout itself (so a
 * parent session sitting in the plugin source tree can never masquerade as
 * the ticket worktree).
 *
 * Resolution order:
 *   1. `config.worktreeDir(config.safeTicketId(<bare ticket>))` — used when
 *      the directory exists on disk.
 *   2. `git rev-parse --show-toplevel` from `opts.cwd || process.cwd()` —
 *      used only when it resolves AND its realpath differs from the plugin
 *      checkout's toplevel realpath (when the plugin lives in a git repo).
 *   3. null — callers keep their own last-resort fallback
 *      (`path.dirname(tasksBase)`).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** `git rev-parse --show-toplevel` from a directory; null when not a repo. */
function gitToplevel(cwd) {
  try {
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p ? path.resolve(p) : p;
  }
}

// Toplevel of the checkout the plugin code itself lives in. Null when the
// plugin runs from a non-git location (e.g. marketplace cache). Cached —
// __dirname never changes within a process.
let _pluginToplevel;
let _pluginToplevelLoaded = false;
function pluginCheckoutToplevel() {
  if (!_pluginToplevelLoaded) {
    _pluginToplevelLoaded = true;
    _pluginToplevel = gitToplevel(__dirname);
  }
  return _pluginToplevel;
}

/**
 * Ticket-config candidate: `WORKTREES_BASE/<REPO_NAME>-<safeTicket>`.
 * Returns the path (without checking existence) or null when config is
 * unavailable. Suffix ticket ids ("PROJ-1/phase1") resolve their base.
 *
 * @param {string} ticketId
 * @param {{ config?: object }} [deps] - injectable for tests
 * @returns {string|null}
 */
function configuredWorktreeDir(ticketId, deps = {}) {
  const bare = String(ticketId || '')
    .split('/')[0]
    .trim();
  if (!bare) return null;
  try {
    const config = deps.config || require('./config');
    const safe = typeof config.safeTicketId === 'function' ? config.safeTicketId(bare) : bare;
    if (typeof config.worktreeDir === 'function') return config.worktreeDir(safe) || null;
  } catch {
    /* config unavailable — fall through to cwd detection */
  }
  return null;
}

/**
 * Resolve the ticket's worktree root independent of the caller's cwd.
 *
 * @param {string} ticketId - e.g. "GH-219" or "PROJ-123/phase1"
 * @param {object} [opts]
 * @param {string} [opts.cwd] - detection cwd (defaults to process.cwd())
 * @param {object} [opts.config] - injectable config module (tests)
 * @param {string|null} [opts.pluginToplevel] - injectable plugin checkout
 *   toplevel (tests); defaults to the real one derived from __dirname
 * @returns {string|null} absolute worktree path, or null when unresolvable
 */
function resolveTicketWorktree(ticketId, opts = {}) {
  // 1. Ticket id + env config (WORKTREES_BASE/REPO_NAME pattern)
  const configured = configuredWorktreeDir(ticketId, opts);
  if (configured && fs.existsSync(configured)) return configured;

  // 2. Cwd git-detection — only when it points at a repo whose toplevel
  //    differs from the plugin checkout (prevents the plugin source tree
  //    being mistaken for the ticket worktree).
  const cwdTop = gitToplevel(opts.cwd || process.cwd());
  if (cwdTop) {
    const pluginTop =
      opts.pluginToplevel !== undefined ? opts.pluginToplevel : pluginCheckoutToplevel();
    if (!pluginTop || safeRealpath(cwdTop) !== safeRealpath(pluginTop)) return cwdTop;
  }

  return null;
}

module.exports = { resolveTicketWorktree, configuredWorktreeDir, gitToplevel };
