/**
 * Phase: diff_audit — sanity check the diff snapshot before deep review.
 *
 * Block conditions:
 *  - Diff is empty (nothing to review).
 *  - PR touches files outside any task's scope AND the agent has not
 *    written a `## Out-of-scope justification` section in pr-review.check.md.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { PR_REVIEW_PHASES } = require('../../pr-review-phase-registry');
const { readChangedFiles, readTasks, sliceSection } = require('../kind-checks/shared');

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function parseFilesInScope(tasksText) {
  const out = new Set();
  if (!tasksText) return out;
  const re = /^###\s+Files in scope\b[\s\S]*?(?=\n###\s|\n## |$(?![\s\S]))/gim;
  let m;
  while ((m = re.exec(tasksText)) !== null) {
    for (const line of m[0].split('\n')) {
      const b = line.match(/`([^`\n]+)`/g);
      if (!b) continue;
      for (const tok of b) out.add(tok.replace(/`/g, '').trim());
    }
  }
  return out;
}

function validate(ctx) {
  const changed = readChangedFiles(ctx);
  if (!changed.length) {
    return { ok: false, errors: ['PR diff is empty — nothing to review.'] };
  }
  const inScope = parseFilesInScope(readTasks(ctx.tasksDir));
  const unaccounted = inScope.size > 0 ? changed.filter((f) => !inScope.has(f)) : [];
  const errors = [];
  const warnings = [];

  if (unaccounted.length) {
    // If the reviewer has acknowledged with a justification section, accept.
    const review = readFile(path.join(ctx.tasksDir, 'pr-review.check.md')) || '';
    const hasJustification = !!sliceSection(review, /^##\s+Out-of-scope justification\b/im);
    if (!hasJustification) {
      warnings.push(
        `PR touches ${unaccounted.length} file(s) not declared in any task's \`### Files in scope\`: ${unaccounted
          .slice(0, 5)
          .map((f) => `\`${f}\``)
          .join(
            ', '
          )}${unaccounted.length > 5 ? ', …' : ''}. Either add a \`## Out-of-scope justification\` section to pr-review.check.md (with reason per file) or request the author to split.`
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${changed.length} file(s) in PR, ${unaccounted.length} unaccounted`,
  };
}

function instructions(ctx) {
  return [
    '# pr-review-next — Phase 3 of 8: DIFF AUDIT',
    `Ticket: ${ctx.ticket}`,
    '',
    'I classify every changed file against the union of `### Files in scope` across all tasks. Unaccounted files surface as warnings — justify them in the review (under `## Out-of-scope justification`) or request a split.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(PR_REVIEW_PHASES.diff_audit, {
    next: PR_REVIEW_PHASES.standards_audit,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.parseFilesInScope = parseFilesInScope;
