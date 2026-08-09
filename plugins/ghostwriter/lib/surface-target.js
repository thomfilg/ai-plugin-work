'use strict';

/**
 * surface-target.js — where a surface actually operates.
 *
 * A git command does not necessarily act on the shell's directory or on the
 * repository it is sitting in, and every pass that reads something from disk
 * has to follow it there: a relative `-F` path, a `git config` read, and a ref
 * lookup all resolve against the target, not against the caller.
 */

const path = require('node:path');

/**
 * The directory this surface operates on.
 *
 * `-C` COMPOUNDS: `git -C outer -C inner` lands in `outer/inner`, so every
 * value applies in order rather than the last one winning. path.resolve does
 * exactly that, absolute segments included.
 */
function surfaceCwd(surface, io) {
  return surface.dirs && surface.dirs.length ? path.resolve(io.cwd, ...surface.dirs) : io.cwd;
}

/**
 * The repository whose config this surface commits under. `--git-dir` /
 * `GIT_DIR` select it independently of the process directory, so a command can
 * sit in a clean repo and author into another one.
 */
function surfaceGitDir(surface, io) {
  // A GIT_DIR already exported in the session reaches git without appearing in
  // the command at all. The guard's own `git config` read inherits it too, so
  // the two agree either way — but threading it explicitly makes that a stated
  // contract rather than a coincidence, and keeps it right if the guard's
  // environment ever stops matching the command's.
  const selected = surface.gitDir || io.env.GIT_DIR;
  return selected ? path.resolve(surfaceCwd(surface, io), selected) : null;
}

module.exports = { surfaceCwd, surfaceGitDir };
