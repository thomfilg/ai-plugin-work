'use strict';

/**
 * git-hunk-changed — detect whether a single-line "hunk" of a file has been
 * touched by any git commit since a given ISO-8601 timestamp.
 *
 * Used by the Copilot stale-thread heuristic in `follow-up-pr-comments.js`:
 * a Copilot review comment whose original line range was already modified
 * after the comment's `created_at` is treated as "code-addressed, thread-
 * stale" and auto-resolved locally.
 *
 * Constraints (GH-531 spec):
 *   - Node built-ins only (zero runtime deps).
 *   - `execFileSync` with arg array — never shell interpolation (C7).
 *   - `sinceIso` is validated against `^\d{4}-\d{2}-\d{2}T` BEFORE being
 *     passed to git, defense-in-depth against any caller-controlled value.
 */

const { execFileSync } = require('node:child_process');

const ISO_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T/;

/**
 * Return `true` if `git log -L <line>,<line>:<file> --since <sinceIso>`
 * produces non-empty output (i.e. at least one commit since `sinceIso`
 * touched the given line range), `false` otherwise.
 *
 * @param {string} filePath    repo-relative path to the file under inspection
 * @param {number} originalLine 1-indexed line of the original comment anchor
 * @param {string} sinceIso    ISO-8601 timestamp (must start `YYYY-MM-DDT`)
 * @param {{ cwd?: string }} [ctx] optional context — `cwd` is forwarded to
 *   execFileSync so callers can pin the git invocation to a specific worktree.
 *   When omitted, git inherits `process.cwd()`.
 * @returns {boolean}
 * @throws {Error} if `sinceIso` fails the ISO-prefix regex
 */
function gitHunkChangedSince(filePath, originalLine, sinceIso, ctx) {
  if (typeof sinceIso !== 'string' || !ISO_PREFIX_RE.test(sinceIso)) {
    throw new Error(
      `gitHunkChangedSince: invalid sinceIso — expected ISO-8601 timestamp starting YYYY-MM-DDT, got ${JSON.stringify(sinceIso)}`
    );
  }
  const line = Number(originalLine);
  const lArg = `${line},${line}:${filePath}`;
  const opts = {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  };
  if (ctx && typeof ctx.cwd === 'string') opts.cwd = ctx.cwd;
  const out = execFileSync('git', ['log', '--since', sinceIso, '-L', lArg], opts);
  return String(out).trim().length > 0;
}

module.exports = { gitHunkChangedSince };
