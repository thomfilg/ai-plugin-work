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
 * Requirement IDs from a `### Requirements Covered` bullet block, extracted
 * with the canonical grammar only. Non-canonical ID conventions (bare tokens
 * like `REQ_CUSTOM_1`, `C1`, `G5`) are NOT recognized — the generation side
 * (requirements_extract / traceability) enforces canonical IDs, so anything
 * else in this block is an authoring error to surface, not to absorb.
 */
function extractRequirementIdsFromBulletBlock(blockText) {
  return listRequirementIds(blockText);
}

module.exports = {
  REQUIREMENT_ID_RE_SOURCE,
  requirementIdRe,
  listRequirementIds,
  extractRequirementIdsFromBulletBlock,
};
