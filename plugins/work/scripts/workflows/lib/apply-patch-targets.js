/**
 * apply-patch-targets.js
 *
 * Shared resolver for codex apply_patch write targets. The Edit/Write
 * matcher lanes alias-fire for apply_patch on codex, but the payload carries
 * a raw patch (`*** Add/Update/Delete File:` headers) instead of file_path.
 *
 * Unparseable targets (ok:false) are dropped — the advisory workflow
 * protectors fail OPEN on them; heimdall owns the fail-closed lane
 * (design C6).
 */

const path = require('path');
// Vendored dual-runtime adapter (see factories/runtime).
const { parseApplyPatch } = require('./runtime/tools');

/**
 * Parse an apply_patch payload and resolve every parseable target against
 * the hook payload's cwd (falling back to process.cwd()).
 *
 * @param {string} command — the raw apply_patch payload (toolInput.command)
 * @param {object} [hookData] — hook payload; hookData.cwd anchors relative paths
 * @returns {string[]} absolute paths touched by the patch
 */
function resolveApplyPatchTargets(command, hookData) {
  const cwd = (hookData && hookData.cwd) || process.cwd();
  const resolved = [];
  for (const target of parseApplyPatch(command)) {
    if (!target.ok || !target.path) continue;
    resolved.push(path.isAbsolute(target.path) ? target.path : path.resolve(cwd, target.path));
  }
  return resolved;
}

module.exports = { resolveApplyPatchTargets };
