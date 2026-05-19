/**
 * Phase: draft — every `## Task N` block must have required subsections.
 *
 * Reuses the existing task-parser via lazy require so the parser owns the
 * truth about what a task block looks like.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { TASKS_PHASES } = require('../../tasks-phase-registry');

let parseTasks;
try {
  ({ parseTasks } = require('../../../work/task-parser'));
} catch {
  parseTasks = null;
}

const REQUIRED_SUBSECTIONS = [
  'Type',
  'Dependencies',
  'Requirements Covered',
  'Acceptance Criteria',
  'Files in scope',
];

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function validateArtifacts(tasksDir) {
  const errors = [];
  const p = path.join(tasksDir, 'tasks.md');
  const text = readFile(p);
  if (!text) {
    errors.push(`Missing ${p}.`);
    return errors;
  }
  // Must have at least one `## Task N` block.
  const blocks = text.match(/^##\s+Task\s+\d+/gm) || [];
  if (blocks.length === 0) {
    errors.push(
      `tasks.md has zero \`## Task N\` blocks. Decompose the spec into at least one numbered task.`
    );
    return errors;
  }
  // For each block, check required subsections.
  const parts = text.split(/^##\s+Task\s+(\d+)/m);
  for (let i = 1; i < parts.length; i += 2) {
    const num = parts[i];
    const body = (parts[i + 1] || '').replace(/\n## (?!Task\s)\S[\s\S]*$/, '');
    for (const sub of REQUIRED_SUBSECTIONS) {
      const re = new RegExp(`^###\\s+${sub}\\b`, 'm');
      if (!re.test(body)) {
        errors.push(`Task ${num} is missing required subsection \`### ${sub}\`.`);
      }
    }
  }
  return errors;
}

function validate(ctx) {
  const errors = validateArtifacts(ctx.tasksDir);
  if (errors.length) return { ok: false, errors };
  let count = 0;
  if (parseTasks) {
    try {
      const tasks = parseTasks(ctx.tasksDir);
      count = (tasks && tasks.length) || 0;
    } catch {
      /* parser quirk — already validated structure above */
    }
  }
  return { ok: true, summary: `${count} task block(s) parsed` };
}

function instructions(ctx) {
  return [
    `# tasks-next — Phase 3 of 7: DRAFT`,
    `Ticket: ${ctx.ticket}`,
    '',
    '### What you do',
    `Write the full \`${path.join(ctx.tasksDir, 'tasks.md')}\`. Each task is a section:`,
    '',
    '```markdown',
    '## Task 1 — <one-line title>',
    '',
    '### Type',
    'frontend | backend | wiring | e2e | devops | fullstack | checkpoint',
    '',
    '### Dependencies',
    'Task 0 (or "none")',
    '',
    '### Requirements Covered',
    '- R1',
    '- R2',
    '',
    '### Acceptance Criteria',
    '- bullet1',
    '- bullet2',
    '',
    '### Files in scope',
    '- `path/to/file.ts`',
    '',
    '### Files explicitly out of scope',
    '- `path/sibling-owned/file.ts` — owned by ECHO-XXXX',
    '',
    '### Test Command',
    '```bash',
    "# command that runs ONLY this task's tests",
    'pnpm test path/to/file.test.ts',
    '```',
    '```',
    '',
    'Keep the `## Extracted Requirements` section at the top of the file.',
    '',
    '### What I will check before advancing',
    '- At least one `## Task N` block',
    `- Each task has \`### ${REQUIRED_SUBSECTIONS.join('\`, \`### ')}\` subsections`,
    '',
    'Re-invoke me when the tasks are filled out.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(TASKS_PHASES.draft, {
    next: TASKS_PHASES.traceability,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.validateArtifacts = validateArtifacts;
module.exports.REQUIRED_SUBSECTIONS = REQUIRED_SUBSECTIONS;
