'use strict';

/**
 * Codex apply_patch alias hop (dual-runtime, WP-05). Split out of matcher.js
 * so that file stays under the quality gate's max-lines budget — same
 * self-contained sibling pattern as matcher-content.js / matcher-stop.js.
 *
 * Edit/Write/MultiEdit/NotebookEdit specs also match `apply_patch` events
 * when a parsed write-target path matches the pattern, so user memories keep
 * firing on codex with ZERO data migration (codex file edits carry a raw
 * patch payload and no `file_path` — ground truth §2.5.5). Same tool-alias
 * semantics as the shared runtime lib's matchesToolSpec, but the pattern
 * compiles through synapsys's own safeRegex (case-insensitive) so a spec
 * behaves identically whether the event arrives as a Claude Edit or a codex
 * apply_patch. Claude payloads never carry tool_name 'apply_patch', so the
 * claude matcher path is byte-identical.
 */

const { safeRegex } = require('./matcher-regex');
const { CLAUDE_WRITE_TOOLS, extractWriteTargets } = require('./runtime/tools');

function parseArgBlob(argBlob) {
  try {
    const parsed = JSON.parse(argBlob);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// True when a Claude write-tool `tool:pat` spec matches an apply_patch event
// whose stringified tool_input is `argBlob`. A patless spec matches any
// apply_patch event (it is a write); a patterned spec fails closed when the
// patch targets cannot be parsed.
function applyPatchAliasMatches(tool, pat, argBlob) {
  if (!CLAUDE_WRITE_TOOLS.has(tool)) return false;
  if (!pat) return true;
  const re = safeRegex(pat);
  if (!re) return false;
  const targets = extractWriteTargets('apply_patch', parseArgBlob(argBlob), 'codex');
  return targets.some((t) => t.ok && typeof t.path === 'string' && re.test(t.path));
}

module.exports = { applyPatchAliasMatches };
