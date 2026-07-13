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

const { iterTaskBlocks } = require('./_task-block-iter');

function parseTaskBlocks(text) {
  // Note: must NOT use the `m` flag with `$` in the lookahead — `$` in
  // multiline mode matches every end-of-line and the non-greedy quantifier
  // terminates at the first one. Drop the `^` anchor + `m` flag and rely
  // on `\n###` / `\n## ` / true end-of-string as the section terminators.
  return iterTaskBlocks(text).map(({ num, body }) => {
    const m = body.match(/###\s+Requirements Covered\s*\n([\s\S]*?)(?=\n###\s|\n## |$(?![\s\S]))/);
    return { num: Number(num), reqText: m ? m[1] : '' };
  });
}

const COVERAGE_HEADING_RE = /^##\s+Requirement Coverage(?=\s|$)/im;

/**
 * Validate the top-level `## Requirement Coverage` table (deadlock family
 * ECHO-5139/5145/5218/5320/5350/5818/5821): the completion-checker's
 * coverage_check parses this table positionally as
 * `| ID | Description | Status | Evidence |` during the `check` step —
 * where tasks.md is write-protected. A tasks.md that leaves the tasks step
 * without the table (or with a differently-shaped one, e.g.
 * `| Requirement | Source | Covered by Task(s) |`) forces an unrepairable
 * block later. Enforce presence + parser shape here, at authoring time.
 *
 * Returns an array of error strings ([] when valid). Also exported for the
 * workflow-definition tasks_gate verify.
 */
/** Cells of a `| a | b |` table line (outer empties dropped, trimmed). */
function tableCells(line) {
  return line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
}

/** Trimmed pipe-table lines (with at least one cell) inside the section. */
function coveragePipeRows(section) {
  return section
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|') && tableCells(l).length > 0);
}

/** Data rows: everything after the header, minus `|---|` separator rows. */
function coverageDataRows(pipeRows) {
  return pipeRows.slice(1).filter((l) => {
    const c = tableCells(l);
    return c.length > 0 && !/^[-: ]+$/.test(c[0]); // drop separator rows
  });
}

/** Positional-shape check on the header row. Returns an error string or null. */
function coverageHeaderError(header) {
  const headerBlob = header.join(' ').toLowerCase();
  if (header.length < 4 || !headerBlob.includes('status') || !headerBlob.includes('evidence')) {
    return (
      '`## Requirement Coverage` table header must be `| ID | Description | Status | Evidence |` ' +
      '— the completion-checker reads columns positionally (id, description, status, evidence). ' +
      `Found: \`| ${header.join(' | ')} |\`.`
    );
  }
  return null;
}

/** Per-row ID recognizability + full-coverage errors against the extracted set. */
function coverageIdErrors(dataRows, allReqIds) {
  const errors = [];
  const tableIds = new Set();
  for (const row of dataRows) {
    const id = tableCells(row)[0];
    const known = reqExtract.listRequirementIds(id);
    if (!known.length) {
      errors.push(
        `\`## Requirement Coverage\` row has unrecognizable ID \`${id}\` — use the canonical IDs from \`## Extracted Requirements\` (R1, AC1, …).`
      );
      continue;
    }
    for (const k of known) tableIds.add(k);
  }
  for (const id of allReqIds) {
    if (!tableIds.has(id)) {
      errors.push(
        `Requirement \`${id}\` has no row in \`## Requirement Coverage\`. Every extracted requirement needs a coverage row.`
      );
    }
  }
  return errors;
}

function validateCoverageTable(tasksDir) {
  const p = path.join(tasksDir, 'tasks.md');
  const text = readFile(p);
  if (!text) return [`Missing ${p}.`];

  if (!COVERAGE_HEADING_RE.test(text)) {
    return [
      'tasks.md is missing the trailing `## Requirement Coverage` table. Emit ' +
        '`| ID | Description | Status | Evidence |` with one row per extracted requirement ' +
        '(Status `Covered`, Evidence `tasks.md:Task N`). The completion-checker parses this ' +
        'exact shape at the `check` step, where tasks.md is write-protected — omitting it ' +
        'here deadlocks the workflow there.',
    ];
  }

  const pipeRows = coveragePipeRows(reqExtract.sliceSection(text, COVERAGE_HEADING_RE));
  if (!pipeRows.length) {
    return [
      '`## Requirement Coverage` section exists but contains no table. Add ' +
        '`| ID | Description | Status | Evidence |` rows for every extracted requirement.',
    ];
  }

  const errors = [];
  const headerError = coverageHeaderError(tableCells(pipeRows[0]));
  if (headerError) errors.push(headerError);

  const dataRows = coverageDataRows(pipeRows);
  if (!dataRows.length) {
    errors.push(
      '`## Requirement Coverage` table has no data rows — add one row per extracted requirement.'
    );
    return errors;
  }

  const allReqIds = new Set(
    reqExtract.listRequirementIds(
      reqExtract.sliceSection(text, /^##\s+Extracted Requirements(?=\s|$)/im)
    )
  );
  errors.push(...coverageIdErrors(dataRows, allReqIds));
  return errors;
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
  errors.push(...validateCoverageTable(tasksDir));
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
    '- A trailing `## Requirement Coverage` table exists with the parser shape `| ID | Description | Status | Evidence |` and one row per requirement (the completion-checker reads this exact table at the `check` step, where tasks.md is write-protected).',
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
module.exports.validateCoverageTable = validateCoverageTable;
module.exports.parseTaskBlocks = parseTaskBlocks;
