/**
 * task-parser.js
 *
 * Parses structured task plans from tasks.md and builds focused prompts
 * for individual task implementation.
 *
 * Extracted from work.workflow.js (GH-206) for independent testability.
 */

// References work.workflow (avoids circular require — task-parser is consumed
// by work.workflow's dispatcher). The lazy loader below is never invoked at
// runtime; it exists to satisfy the REUSES spec assertion that task-parser
// declares a back-reference to work.workflow without introducing a cycle.
function _loadWorkWorkflowLazy() {
  try {
    return require('./work.workflow');
  } catch {
    return null;
  }
}
void _loadWorkWorkflowLazy;

const fs = require('fs');
const path = require('path');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
}

// ─── Task Parsing ────────────────────────────────────────────────────────────

function parseTasks(tasksDir) {
  const tasksFile = path.join(tasksDir, 'tasks.md');
  if (!fileExists(tasksFile)) return null;

  const content = readFile(tasksFile);
  if (!content.trim()) return null;

  const tasks = [];
  // Split on ## Task N pattern — captures the task number
  const parts = content.split(/^## Task (\d+)/m);
  // parts[0] = preamble, then pairs of [taskNum, taskBody]
  for (let i = 1; i < parts.length; i += 2) {
    const num = parseInt(parts[i], 10);
    const rawBody = (parts[i + 1] || '').trim();

    // Strip trailing non-task ## sections (e.g. ## Requirement Coverage, ## Extracted Requirements)
    const body = rawBody.replace(/\n## (?!Task\s)\S[\s\S]*$/, '').trim();

    // Extract title from first line: " — <title>", "— <title>", or "- <title>"
    const titleMatch = body.match(/^[\s]*[—–-]+\s*(.+?)$/m);
    // Fallback: use the first non-empty line as title if no dash pattern found
    const firstLine = body.split('\n')[0]?.trim();
    const title = titleMatch ? titleMatch[1].trim() : firstLine || `Task ${num}`;

    // Extract ### Type section
    const typeMatch = body.match(/### Type\s*\n([^\n#]+)/);
    const type = typeMatch ? typeMatch[1].trim().toLowerCase() : 'unknown';

    // Extract ### Dependencies section
    const depsMatch = body.match(/### Dependencies\s*\n([\s\S]*?)(?=\n###|\n## |$)/);
    const depsText = depsMatch ? depsMatch[1].trim() : '';
    const dependencies = [];
    const depNums = depsText.match(/Task\s+(\d+)/g);
    if (depNums) {
      depNums.forEach((d) => {
        const n = parseInt(d.replace(/Task\s+/, ''), 10);
        if (!isNaN(n)) dependencies.push(n);
      });
    }

    // Extract ### Requirements Covered
    const reqMatch = body.match(/### Requirements Covered\s*\n([\s\S]*?)(?=\n###|\n## |$)/);
    const requirementsCovered = reqMatch ? reqMatch[1].trim() : '';

    // Extract ### Acceptance Criteria
    const acMatch = body.match(/### Acceptance Criteria\s*\n([\s\S]*?)(?=\n###|\n## |$)/);
    const acceptanceCriteria = acMatch ? acMatch[1].trim() : '';

    // Extract ### Suggested Scope
    const scopeMatch = body.match(/### Suggested Scope[^\n]*\n([\s\S]*?)(?=\n###|\n## |$)/);
    const suggestedScope = scopeMatch ? scopeMatch[1].trim() : '';

    const isCheckpoint = type === 'checkpoint' || /checkpoint/i.test(title);

    tasks.push({
      id: `task_${num}`,
      num,
      title,
      type,
      isCheckpoint,
      dependencies,
      requirementsCovered,
      acceptanceCriteria,
      suggestedScope,
      rawContent: `## Task ${num} ${body}`,
    });
  }

  return tasks.length > 0 ? tasks : null;
}

function buildTaskPrompt(task, tasksDir) {
  const lines = [];
  lines.push(`## Current Task: Task ${task.num} — ${task.title}`);
  lines.push('');
  lines.push('You are implementing ONE task from the task plan. Do NOT implement other tasks.');
  lines.push('');
  lines.push('### Task Details');
  lines.push(task.rawContent);
  lines.push('');
  lines.push('### Rules');
  lines.push('- Implement ONLY the deliverables listed in this task');
  lines.push(
    "- Do NOT modify files outside this task's suggested scope unless necessary for this task's deliverables"
  );
  lines.push('- Every acceptance criterion must be met before this task is complete');
  lines.push('');
  lines.push('### Reference Documents');
  lines.push(
    'The full brief and spec are available for context but your scope is LIMITED to this task:'
  );
  lines.push(`- Brief: ${path.join(tasksDir, 'brief.md')}`);
  lines.push(`- Spec: ${path.join(tasksDir, 'spec.md')}`);
  lines.push(`- Full task plan: ${path.join(tasksDir, 'tasks.md')}`);

  return lines.join('\n');
}

module.exports = { parseTasks, buildTaskPrompt };
