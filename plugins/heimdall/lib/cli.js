'use strict';

/**
 * Shared CLI helpers for the heimdall scripts. Centralizing these keeps the
 * per-script boilerplate (arg parsing, list splitting, store resolution) in one
 * place instead of copy-pasted across init/protect/unprotect/list/scan.
 */

const { getProjectName, candidateStores, discoverStores } = require('./lock-store');

/**
 * Parse `--key=value` flags (and the bare `--json` switch) from argv.
 * Defaults `cwd` to the process cwd. Values may be empty when allowEmpty.
 */
function parseArgs(argv, { allowEmpty = false } = {}) {
  const out = { cwd: process.cwd() };
  const re = allowEmpty ? /^--([a-z]+)=(.*)$/ : /^--([a-z]+)=(.+)$/;
  for (const a of argv.slice(2)) {
    if (a === '--json') {
      out.json = true;
      continue;
    }
    const m = a.match(re);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Split a comma-separated flag value into a trimmed, non-empty list. */
function splitList(v) {
  return (v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve the store dirs an edit should target.
 *   --kind=<k> → just that candidate's dir (created on demand by callers).
 *   otherwise  → every active store discovered at cwd.
 * Returns { dirs, error }. `error` is a message string when resolution fails.
 */
function resolveStoreDirs(args, { requireActive = true } = {}) {
  if (args.kind) {
    const target = candidateStores(args.cwd, getProjectName(args.cwd)).find(
      (c) => c.kind === args.kind
    );
    if (!target)
      return { dirs: [], error: `unknown kind: ${args.kind} (use local|worktree|global)` };
    return { dirs: [target.dir], error: null };
  }
  const dirs = discoverStores(args.cwd).map((s) => s.dir);
  if (requireActive && dirs.length === 0) {
    return {
      dirs: [],
      error: 'no heimdall store found — run /heimdall:install first (or pass --kind).',
    };
  }
  return { dirs, error: null };
}

/**
 * Shared setup for the edit scripts (protect / unprotect): parse args, require
 * a --phrase, split --paths, and resolve target store dirs. Exits the process
 * with a message on any validation/resolution failure.
 * @returns {{ args: object, phrase: string, paths: string[], dirs: string[] }}
 */
function editContext() {
  const args = parseArgs(process.argv, { allowEmpty: true });
  const phrase = (args.phrase || '').trim();
  const paths = splitList(args.paths);
  if (!phrase) {
    console.error('missing --phrase');
    process.exit(1);
  }
  const { dirs, error } = resolveStoreDirs(args);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  return { args, phrase, paths, dirs };
}

module.exports = { parseArgs, splitList, resolveStoreDirs, editContext };
