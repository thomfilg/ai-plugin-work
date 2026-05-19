/**
 * Phase: file_coverage — agents/code-checker.md "Step 3.5": confirm every
 * changed file was actually opened. The agent must list reviewed files
 * under a `## Files Reviewed` heading; this phase verifies the list size
 * is >= changed-file count (or that the gap is justified with confidence
 * downgrade).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { CODE_PHASES } = require('../../code-phase-registry');
const { readChangedFiles, sliceSection } = require('../kind-checks/shared');

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function listReviewedFiles(reportText) {
  if (!reportText) return [];
  const block = sliceSection(reportText, /^##\s+Files Reviewed\b/im);
  if (!block) return [];
  const out = [];
  for (const line of block.split('\n')) {
    const m = line.match(/`([^`\n]+)`/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

function validate(ctx) {
  const report = readFile(path.join(ctx.tasksDir, 'code-review.check.md'));
  const reviewed = listReviewedFiles(report);
  const changed = readChangedFiles(ctx);
  const errors = [];
  const warnings = [];

  if (!reviewed.length) {
    return {
      ok: false,
      errors: [
        'code-review.check.md is missing a `## Files Reviewed` section listing the files you opened. Add it before proceeding.',
      ],
    };
  }

  if (changed.length > 0) {
    const reviewedSet = new Set(reviewed);
    const unreviewed = changed.filter((f) => !reviewedSet.has(f));
    const ratio = (changed.length - unreviewed.length) / changed.length;
    if (ratio < 0.5) {
      errors.push(
        `Only ${changed.length - unreviewed.length}/${changed.length} changed files reviewed (<50%). Per code-checker spec, Confidence MUST be Low and the gap blocks advance until you read the rest.`
      );
    } else if (unreviewed.length) {
      warnings.push(
        `${unreviewed.length} changed file(s) not in \`## Files Reviewed\`: ${unreviewed
          .slice(0, 3)
          .map((f) => `\`${f}\``)
          .join(
            ', '
          )}${unreviewed.length > 3 ? ', …' : ''}. Either read them or downgrade Confidence.`
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${reviewed.length} reviewed of ${changed.length} changed`,
  };
}

function instructions(ctx) {
  return [
    '# code-next — Phase 3 of 8: FILE COVERAGE',
    `Ticket: ${ctx.ticket}`,
    '',
    'Add a `## Files Reviewed` section to `code-review.check.md` listing every file you opened (one backticked path per line). I will compare it to the diff.',
    '',
    'If you cannot review every file, list what you did read and explicitly downgrade Confidence (Low if < 50%).',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(CODE_PHASES.file_coverage, {
    next: CODE_PHASES.standards_audit,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.listReviewedFiles = listReviewedFiles;
