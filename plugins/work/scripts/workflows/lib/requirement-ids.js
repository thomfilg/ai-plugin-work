'use strict';

/**
 * requirement-ids.js — canonical requirement-ID grammar.
 *
 * Single source of truth shared by the generator side
 * (work-tasks/lib/phases/requirements_extract.js — extraction + traceability)
 * and the consumer side (work-completion-checker subsection coverage
 * fallback). The two sides previously carried different grammars: the
 * generator matched IDs anywhere in text while the completion-checker
 * fallback demanded exactly one bare token per bullet — so a tasks.md with
 * `- R1, R6, R7` passed tasks_gate and then deadlocked the check step with
 * `requirement_coverage_missing` (issue #498). One grammar, both sides.
 *
 * Matches "R1", "R-3", "AC1", "AC-2", "spec §2.1", "brief AC-3".
 */
const REQUIREMENT_ID_RE_SOURCE = '\\b(R-?\\d+|AC-?\\d+|spec\\s*§[\\d.]+|brief\\s+AC-\\d+)\\b';

function requirementIdRe() {
  return new RegExp(REQUIREMENT_ID_RE_SOURCE, 'gi');
}

/**
 * Every canonical requirement ID found in `text`, deduped, in first-seen
 * order. Liberal by design: IDs are recognized inside prose, comma lists,
 * and one-per-line bullets alike.
 */
function listRequirementIds(text) {
  if (!text) return [];
  const out = new Set();
  const re = requirementIdRe();
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[0]);
  return [...out];
}

/**
 * Requirement IDs from a `### Requirements Covered` bullet block. Canonical
 * IDs are extracted with the shared grammar; additionally, a bullet whose
 * ENTIRE content is one bare identifier token (the shape the old
 * completion-checker fallback required, e.g. `- REQ_CUSTOM_1`) is kept for
 * backward compatibility with non-canonical ID conventions.
 */
function extractRequirementIdsFromBulletBlock(blockText) {
  if (!blockText) return [];
  const out = new Set(listRequirementIds(blockText));
  for (const line of blockText.split('\n')) {
    const m = line.match(/^\s*[-*]\s+([A-Za-z0-9_-]+)\s*$/);
    if (m) out.add(m[1]);
  }
  return [...out];
}

module.exports = {
  REQUIREMENT_ID_RE_SOURCE,
  requirementIdRe,
  listRequirementIds,
  extractRequirementIdsFromBulletBlock,
};
