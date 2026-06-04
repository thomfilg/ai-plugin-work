/**
 * Phase: traceability — bidirectional req↔task coverage.
 *
 * - Every `R-id` in `## Extracted Requirements` must be referenced by ≥1 task.
 * - Every task's `### Requirements Covered` must list ≥1 known R-id.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { TASKS_PHASES } = require('../../tasks-phase-registry');
const reqExtract = require('./requirements_extract');

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function parseTaskBlocks(text) {
  const out = [];
  if (!text) return out;
  const parts = text.split(/^##\s+Task\s+(\d+)/m);
  for (let i = 1; i < parts.length; i += 2) {
    const num = parts[i];
    const body = (parts[i + 1] || '').replace(/\n## (?!Task\s)\S[\s\S]*$/, '');
    // Note: must NOT use the `m` flag with `$` in the lookahead — `$` in
    // multiline mode matches every end-of-line and the non-greedy
    // quantifier terminates at the first one. Drop the `^` anchor + `m`
    // flag and rely on `\n###` / `\n## ` / true end-of-string as the
    // section terminators.
    const m = body.match(/###\s+Requirements Covered\s*\n([\s\S]*?)(?=\n###\s|\n## |$(?![\s\S]))/);
    const reqText = m ? m[1] : '';
    out.push({ num: Number(num), reqText });
  }
  return out;
}

function validateArtifacts(tasksDir) {
  const errors = [];
  const p = path.join(tasksDir, 'tasks.md');
  const text = readFile(p);
  if (!text) {
    errors.push(`Missing ${p}.`);
    return errors;
  }
  const allReqIds = new Set(
    reqExtract.listRequirementIds(
      reqExtract.sliceSection(text, /^##\s+Extracted Requirements(?=\s|$)/im)
    )
  );
  if (allReqIds.size === 0) {
    errors.push('No requirement IDs found — re-run requirements_extract phase first.');
    return errors;
  }
  const blocks = parseTaskBlocks(text);
  if (!blocks.length) {
    errors.push('No `## Task N` blocks — re-run draft phase first.');
    return errors;
  }

  const coveredByTask = new Set();
  for (const b of blocks) {
    const ids = reqExtract.listRequirementIds(b.reqText);
    if (!ids.length) {
      errors.push(
        `Task ${b.num} has no recognizable R-id in \`### Requirements Covered\`. Reference at least one ID from \`## Extracted Requirements\`.`
      );
      continue;
    }
    for (const id of ids) {
      if (!allReqIds.has(id)) {
        errors.push(
          `Task ${b.num} references unknown requirement ID \`${id}\`. Add it to \`## Extracted Requirements\` or fix the reference.`
        );
      } else {
        coveredByTask.add(id);
      }
    }
  }
  for (const id of allReqIds) {
    if (!coveredByTask.has(id)) {
      errors.push(
        `Requirement \`${id}\` is not covered by any task. Add a task that references it, or remove it from \`## Extracted Requirements\` with rationale.`
      );
    }
  }
  return errors;
}

function validate(ctx) {
  const errors = validateArtifacts(ctx.tasksDir);
  if (errors.length) return { ok: false, errors };
  return { ok: true, summary: 'every requirement covered, every task references known IDs' };
}

function instructions(ctx) {
  return [
    `# tasks-next — Phase 4 of 7: TRACEABILITY`,
    `Ticket: ${ctx.ticket}`,
    '',
    '### What I check',
    '- Every `R-id` listed in `## Extracted Requirements` is referenced by ≥1 task.',
    "- Every task's `### Requirements Covered` lists ≥1 known R-id (no orphan IDs).",
    '',
    'If a requirement has no task: add one, or delete the requirement with a note in `## Extracted Requirements`.',
    'If a task references an unknown ID: fix the typo or add the missing requirement.',
    '',
    'Re-invoke me to verify.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(TASKS_PHASES.traceability, {
    next: TASKS_PHASES.kind_assign,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.validateArtifacts = validateArtifacts;
module.exports.parseTaskBlocks = parseTaskBlocks;
