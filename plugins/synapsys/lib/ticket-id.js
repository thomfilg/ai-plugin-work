'use strict';

/**
 * Synapsys-local ticket-id resolver.
 *
 * A standalone copy of the work-plugin resolver pattern — NO cross-plugin
 * require, so synapsys keeps working when installed without the work plugin.
 * Resolves a `GH-N` / `PROJ-N` ticket id from (in precedence order) an env
 * override, the current git branch, then the cwd path.
 *
 * @module lib/ticket-id
 */

const { execSync } = require('node:child_process');

const TICKET_PATTERN = /([A-Z]+-\d+)/i;
const GH_PATTERN = /GH-(\d+)/i;

/**
 * Default branch reader — shells out to git in `cwd`. Injectable via the
 * `exec` option so unit tests never touch a real repository.
 *
 * @param {string} cwd
 * @returns {string} current branch name (trimmed) or '' on failure
 */
function readGitBranch(cwd) {
  return execSync('git branch --show-current', {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Resolve the current ticket id.
 *
 * Precedence:
 *   1. `env.SYNAPSYS_CORTEX_TICKET` explicit override
 *   2. git branch — `GH-N` first, then any `PROJ-N`
 *   3. cwd path — `GH-N` first, then any `PROJ-N`
 *
 * @param {string} [cwd] working directory to inspect
 * @param {object} [opts]
 * @param {(cwd: string) => string} [opts.exec] injectable branch reader
 * @param {Record<string,string>} [opts.env] injectable environment
 * @returns {string} a `GH-N` / `PROJ-N` id, or '' when nothing matches
 */
function getCurrentTaskId(cwd = process.cwd(), opts = {}) {
  const env = opts.env || process.env;
  const exec = opts.exec || readGitBranch;

  // 1. Explicit override (used when running outside a worktree).
  if (env.SYNAPSYS_CORTEX_TICKET) return env.SYNAPSYS_CORTEX_TICKET;

  // 2. Prefer the git branch — authoritative in symlinked worktrees where the
  //    cwd basename can lie. Fall through to cwd matching on any exec error.
  try {
    const id = matchTicket(exec(cwd));
    if (id) return id;
  } catch {
    // Ignore branch-read errors — fall through to cwd matching.
  }

  // 3. Fallback: the cwd path itself.
  return matchTicket(cwd);
}

/**
 * Extract a normalized ticket id from a string, preferring `GH-N`.
 *
 * @param {string} value branch name or path to scan
 * @returns {string} `GH-N` / `PROJ-N`, or '' when no pattern matches
 */
function matchTicket(value) {
  if (!value) return '';

  const ghMatch = value.match(GH_PATTERN);
  if (ghMatch) return `GH-${ghMatch[1]}`;

  const ticketMatch = value.match(TICKET_PATTERN);
  if (ticketMatch) return ticketMatch[1].toUpperCase();

  return '';
}

if (require.main === module) {
  // eslint-disable-next-line no-console
  console.log(getCurrentTaskId());
}

module.exports = { getCurrentTaskId };
