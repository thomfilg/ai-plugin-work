#!/usr/bin/env node
'use strict';

/**
 * Add (or extend) a lock block in a Heimdall store.
 *
 *   node heimdall-protect.js --phrase="edit .claude" --paths=".claude,~/.claude" [--kind=local] [--cwd=<path>]
 *
 * A lock block is the tuple { protect: [<dir|file>, ...], unlockPhrase }.
 * If a block with the same unlockPhrase already exists, the new paths are
 * merged into it (de-duplicated). Otherwise a new block is appended.
 *
 * --allowed=<a,b>  optional: subdirs always writable under a protected dir.
 * --trusted=<a,b>  optional: subdirs whose internal scripts are trusted.
 *
 * Requires the store to exist (run /heimdall:install first). Defaults to the
 * highest-precedence active store when --kind is omitted.
 */

const path = require('node:path');
const os = require('node:os');
const { splitList, editContext } = require(path.join(__dirname, '..', 'lib', 'cli'));
const { readConfig, writeConfig, upsertLock, SCHEMA_VERSION, SHARED_FOLDER } = require(
  path.join(__dirname, '..', 'lib', 'lock-store')
);

const { args, phrase, paths, dirs } = editContext();
if (paths.length === 0) {
  console.error('missing --paths');
  process.exit(1);
}

// Shared stores are home-anchored; they must never protect repo-relative
// paths (a per-project file like package.json has no meaning in a HOME-wide
// store shared across worktrees). Reject any non-home-anchored path and
// suggest the three project-scoped alternatives.
function isHomeAnchored(p) {
  // Any `..` traversal escapes home regardless of prefix (~, $HOME, or
  // absolute). Reject up front — `$HOME/../etc` and `~/foo/../..` would
  // otherwise pass the prefix tests below and silently escape the
  // home-anchored contract.
  if (p.split(/[/\\]/).includes('..')) return false;
  // ~ or ~/...
  if (/^~(\/|$)/.test(p)) return true;
  // $HOME, $HOME/..., ${HOME}, ${HOME}/...
  if (/^\$\{?HOME\}?(\/|$)/.test(p)) return true;
  // Absolute path under the current user's home directory. We deliberately do
  // NOT accept bare relative paths here: `path.resolve` would resolve them
  // against `process.cwd()`, and a user running `heimdall-protect
  // --kind=shared --paths=.github` from `~/myproj` would silently insert
  // `.github` into the shared store. Require the caller to spell out the
  // home-anchored shape (~, $HOME, or an absolute path under home).
  if (path.isAbsolute(p)) {
    const home = os.homedir();
    if (!home) return false;
    const normalized = path.resolve(p);
    const normalizedHome = path.resolve(home);
    if (normalized === normalizedHome || normalized.startsWith(normalizedHome + path.sep)) {
      return true;
    }
  }
  return false;
}

const storeDir = dirs[0];

// Shared stores are home-anchored regardless of whether --kind=shared was
// passed explicitly: when the resolved store dir happens to be the shared
// store (e.g. it's the only active store, or precedence selects it via
// `discoverStores`), repo-relative paths like `package.json` still have no
// meaning in a HOME-wide store. Guard on the resolved store path, not just
// the --kind flag (Cursor bot PR #545, comment 3354852147).
const sharedStoreDir = path.join(os.homedir(), '.claude', SHARED_FOLDER);
const targetsShared = path.resolve(storeDir) === path.resolve(sharedStoreDir);
if (targetsShared) {
  const nonHome = paths.filter((p) => !isHomeAnchored(p));
  if (nonHome.length > 0) {
    console.error(
      `--kind=shared only accepts explicit home-anchored shapes — ~/..., $HOME/..., ${'${HOME}'}/..., or an absolute path literally under your home directory (no ".." traversal, no bare relative paths); ` +
        `got: ${nonHome.join(', ')}. ` +
        `use --kind=local, --kind=worktree, or --kind=global for project-relative paths`
    );
    process.exit(1);
  }
}

const cfg = readConfig(storeDir);
if (!cfg) {
  console.error(`store not initialized at ${storeDir} — run /heimdall:install first.`);
  process.exit(1);
}

const saved = upsertLock(cfg, {
  phrase,
  paths,
  allowedPaths: args.allowed ? splitList(args.allowed) : undefined,
  trustedSubdirs: args.trusted ? splitList(args.trusted) : undefined,
});

cfg.schemaVersion = SCHEMA_VERSION;
cfg.updatedAt = new Date().toISOString();
writeConfig(storeDir, cfg);

console.log(
  `protected [${saved.protect.join(', ')}] under phrase "${phrase}" ` +
    `(store: ${storeDir}, ${cfg.locks.length} block(s) total)`
);
