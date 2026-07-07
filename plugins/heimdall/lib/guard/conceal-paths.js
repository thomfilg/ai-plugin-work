'use strict';

/**
 * Path helpers + the codex apply_patch candidate lane for the conceal guard
 * (hooks/heimdall-conceal.js). Match-only utilities — nothing here executes a
 * command or writes a file.
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseApplyPatch } = require('../runtime/tools');

// Deny patterns are anchored on forward slashes (see heimdall-conceal.js
// buildPatterns); normalize Windows backslash separators in the target so the
// match holds cross-platform. (Match-only — the command is never executed from
// this normalized copy.)
const toPosix = (s) => s.replace(/\\/g, '/');

// Resolve symlinks (tolerating a non-existent leaf, e.g. Write to a new file),
// mirroring the lock guard's resolvePathSafe. A symlink whose own path doesn't
// match the deny pattern must not reach a concealed target.
function resolveSafe(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
    } catch {
      return p;
    }
  }
}

// apply_patch (codex) writes the files listed in its `*** Add/Update/Delete
// File:` headers — match those TARGET PATHS like the file-tool lane (raw,
// resolved against the session root, and symlink-resolved), never the patch
// body (content merely mentioning a concealed name must not block). An
// unparseable patch while a conceal policy is active throws, which the hook's
// fail-closed wrapper turns into a block.
function applyPatchCandidates(input, root) {
  const candidates = [];
  for (const t of parseApplyPatch(String(input.command || ''))) {
    if (!t.ok || !t.path) throw new Error('could not parse apply_patch targets');
    const abs = path.isAbsolute(t.path) ? t.path : path.join(root, t.path);
    candidates.push(t.path, abs);
    const real = resolveSafe(abs);
    if (real !== abs) candidates.push(real);
  }
  return candidates.map(toPosix);
}

// True when an apply_patch's EVERY target is the given (broken) config file —
// the repair-edit recovery lane for a fail-closed conceal state.
function patchTargetsOnlyConfigFile(input, cfgPath, realCfgPath) {
  const targets = parseApplyPatch(String(input.command || ''));
  return targets.every(
    (t) => t.ok && t.path && (t.path === cfgPath || resolveSafe(t.path) === realCfgPath)
  );
}

module.exports = { toPosix, resolveSafe, applyPatchCandidates, patchTargetsOnlyConfigFile };
