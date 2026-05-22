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
const { parseShapeFromSpec } = require('../../../work-spec/lib/component-shape');

let parseTasks;
try {
  ({ parseTasks } = require('../../../work/lib/task-parser'));
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

const SHARED_PATH_RE = /(^|\/)(shared|ui|packages\/ui|src\/shared|src\/ui|components\/shared)\//i;

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function parseTaskBlocks(text) {
  const parts = text.split(/^##\s+Task\s+(\d+)/m);
  const blocks = [];
  for (let i = 1; i < parts.length; i += 2) {
    const num = Number(parts[i]);
    const rest = parts[i + 1] || '';
    // First line after the number is the title (after the dash).
    const firstNewline = rest.indexOf('\n');
    const titleLine = firstNewline === -1 ? rest : rest.slice(0, firstNewline);
    const body = rest.replace(/\n## (?!Task\s)\S[\s\S]*$/, '');
    blocks.push({ num, title: titleLine.replace(/^[\s—\-:]+/, '').trim(), body });
  }
  return blocks;
}

function extractFilesInScope(body) {
  // Split on `### ` headings and locate the "Files in scope" section.
  const sections = body.split(/^###\s+/m);
  let target = null;
  for (const sec of sections) {
    if (/^Files in scope\b/.test(sec)) {
      target = sec.replace(/^Files in scope\b[^\n]*\n?/, '');
      break;
    }
  }
  if (target == null) return [];
  const files = [];
  for (const line of target.split('\n')) {
    if (/^###\s/.test(line)) break;
    const bullet = line.match(/^\s*[-*]\s+`?([^`\s]+)`?/);
    if (bullet) files.push(bullet[1]);
  }
  return files;
}

function validateSharedComponentOrdering(tasksDir, taskBlocks) {
  const errors = [];
  const { rows } = parseShapeFromSpec(path.join(tasksDir, 'spec.md'));
  const genericRows = rows.filter((r) => r.isGenericSplit);
  if (genericRows.length === 0) return errors; // nothing to enforce
  if (taskBlocks.length === 0) return errors; // earlier check already reports

  // Locate the task ACTUALLY numbered 1 (per `## Task 1` heading), not just
  // the first task in document order. Authors sometimes write tasks
  // out-of-order in the file; the scaffold-first rule applies to Task 1 by
  // number, which is the implement-gate's anchor. If no `## Task 1` exists,
  // fall back to the first task in document order and report its real number.
  const task1 = taskBlocks.find((t) => t.num === 1) || taskBlocks[0];
  const taskLabel = `Task ${task1.num}`;
  const filesInTask = extractFilesInScope(task1.body);
  const taskTouchesShared = filesInTask.some((f) => SHARED_PATH_RE.test(f));

  const sharedNames = genericRows
    .map((r) => r.genericName)
    .filter(Boolean)
    .map((n) => n.toLowerCase());
  const taskMentionsSharedName = sharedNames.some((n) => {
    const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return re.test(task1.title) || re.test(task1.body);
  });

  if (!taskTouchesShared) {
    errors.push(
      `${taskLabel} must scaffold the shared component(s) declared Generic-split in spec.md's \`## Component Shape Decision\` (${genericRows
        .map((r) => `\`${r.proposed}\` → \`${r.genericName || '?'}\``)
        .join(
          ', '
        )}), but ${taskLabel}'s \`### Files in scope\` contains no path under \`shared/\`, \`ui/\`, \`packages/ui/\`, or similar. Reorder so the generic shell lands first; page-specific wrappers depend on it.`
    );
  }
  if (sharedNames.length > 0 && !taskMentionsSharedName) {
    errors.push(
      `${taskLabel} must mention the shared component name(s) from the Generic-split decision (${sharedNames
        .map((n) => `\`${n}\``)
        .join(
          ', '
        )}) in its title or body so the implement-gate can match the scaffold to the decision.`
    );
  }
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
  // If the spec's Component Shape Decision chose Generic-split for any
  // component, Task 1 must scaffold the shared shell before page wrappers.
  // This is the ECHO-4452 lesson translated into an implementation-order rule.
  const taskBlocks = parseTaskBlocks(text);
  errors.push(...validateSharedComponentOrdering(tasksDir, taskBlocks));
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
    '# Use the canonical envelope so repos can override the runner via .envrc.',
    '# Pick ONE of: $TEST_UNIT_COMMAND, $TEST_INTEGRATION_COMMAND, $TEST_E2E_COMMAND.',
    '# Never hardcode `pnpm test`/`pnpm vitest`/etc. — the implement-gate runs this verbatim.',
    'CHANGED_FILES="path/to/file.test.ts" eval "$TEST_UNIT_COMMAND"',
    '```',
    '```',
    '',
    'Keep the `## Extracted Requirements` section at the top of the file.',
    '',
    '### Shared-component ordering (when spec declared Generic-split)',
    '',
    'If `spec.md`\'s `## Component Shape Decision` has any row whose Decision is **Generic-split** (e.g. "Split: Generic `Table` + Specific `UsersTable`"), Task 1 MUST scaffold the generic shell:',
    '- Title or body mentions the generic component name (e.g. `Table`).',
    '- `### Files in scope` contains at least one path under `shared/`, `ui/`, `packages/ui/`, `src/shared/`, `src/ui/`, or `components/shared/`.',
    '- Page-specific wrapper tasks declare Task 1 in their `### Dependencies`.',
    '',
    'This translates the spec-level "build the shell once" decision into an implementation-order constraint. Without it, the developer agent can inline the shell in the page-specific task and silently duplicate work (the ECHO-4452 pattern).',
    '',
    '### What I will check before advancing',
    '- At least one `## Task N` block',
    `- Each task has \`### ${REQUIRED_SUBSECTIONS.join('\`, \`### ')}\` subsections`,
    '- If spec declared Generic-split, Task 1 mentions the shared component name and lists a shared/ui path in `### Files in scope`',
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
module.exports.parseTaskBlocks = parseTaskBlocks;
module.exports.extractFilesInScope = extractFilesInScope;
module.exports.validateSharedComponentOrdering = validateSharedComponentOrdering;
module.exports.SHARED_PATH_RE = SHARED_PATH_RE;
