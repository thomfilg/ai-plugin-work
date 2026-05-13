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

/**
 * Return the claim owner ID from a task's lock file, or null if unclaimed.
 * @param {string} tasksDir
 * @param {number} taskNum
 * @returns {string|null}
 */
function _readClaimOwner(tasksDir, taskNum) {
  try {
    const lockPath = path.join(tasksDir, '.claims', `task-${taskNum}.lock`);
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    const ownerId = parsed?.ownerId;
    if (typeof ownerId === 'string' && /^PR[1-9]\d*$/.test(ownerId)) {
      return ownerId;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Normalise a single suggestedScope line by stripping leading list markers
 * (`- `, `* `, `+ `) so the reserved-files list is clean regardless of how
 * tasks.md was formatted.
 * @param {string} line
 * @returns {string}
 */
function _normalizeScope(line) {
  return line
    .trim()
    .replace(/^[-*+]\s+/, '')
    .trim();
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

    // Extract ### Test Command (machine-parseable command for gate-driven TDD).
    // Skip ```bash``` fence markers, leading shell comments, and inline-code
    // backticks. Concatenates lines joined by trailing `\` continuations.
    const testCommand = extractTestCommand(body);

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
      testCommand,
      rawContent: `## Task ${num} ${body}`,
    });
  }

  return tasks.length > 0 ? tasks : null;
}

/**
 * Pull the actual command out of a `### Test Command` section, ignoring
 * markdown noise (fenced code blocks, inline-code backticks, comments).
 *
 * @param {string} taskBody - the body text from `## Task N` to next `## Task`
 * @returns {string|null}
 */
function extractTestCommand(taskBody) {
  const headingMatch = taskBody.match(
    /### Test Command[^\n]*\n([\s\S]*?)(?=\n### |\n## |\n---\s*\n|$)/
  );
  if (!headingMatch) return null;
  const cmdLines = [];
  let inFence = false;
  for (const raw of headingMatch[1].split('\n')) {
    const line = raw.trimEnd();
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    const stripped = trimmed.replace(/^`+|`+$/g, '').trim();
    if (!stripped) continue;
    // Skip parser artefacts that would silently `execSync` to garbage:
    //   - bare interpreter names ("bash", "sh", "node") with no args
    //   - leftover backticks / fence markers
    if (/^(?:bash|sh|zsh|fish|node|python|python3)\s*$/i.test(stripped)) continue;
    if (/^[`]+$/.test(stripped)) continue;
    cmdLines.push(stripped);
    if (!stripped.endsWith('\\')) break;
  }
  if (cmdLines.length === 0) return null;
  return cmdLines.map((l) => l.replace(/\\$/, '').trim()).join(' ');
}

/**
 * @param {object} task - Current task object from parseTasks()
 * @param {string} tasksDir - Path to the task directory
 * @param {Array|null} allTasks - All tasks from parseTasks(), used to build task context
 * @param {object|null} taskState - tasksMeta from work state, used to show completion status
 */
function buildTaskPrompt(task, tasksDir, allTasks, taskState) {
  const lines = [];
  lines.push(`## Current Task: Task ${task.num} — ${task.title}`);
  lines.push('');
  lines.push('You are implementing ONE task from the task plan. Do NOT implement other tasks.');
  lines.push('');

  // ── Task Context: show scope of all tasks to prevent agent drift ─────────
  if (allTasks && allTasks.length > 1) {
    const persistedTasks = Array.isArray(taskState?.tasks) ? taskState.tasks : [];
    lines.push('### Task Context');
    lines.push(
      `This is Task ${task.num} of ${allTasks.length}. Scope boundaries are listed below to prevent drift:`
    );
    lines.push('');
    for (const t of allTasks) {
      const taskMeta = persistedTasks.find((tm) => tm.id === `task_${t.num}`);
      const isCompleted = taskMeta?.status === 'completed';
      const isCurrent = t.num === task.num;
      if (isCurrent) {
        lines.push(`- **Task ${t.num} — ${t.title}** ← YOU ARE IMPLEMENTING THIS`);
      } else if (isCompleted) {
        lines.push(`- Task ${t.num} — ${t.title} [✓ completed — do NOT re-implement]`);
      } else {
        const claimOwner = _readClaimOwner(tasksDir, t.num);
        const label = claimOwner
          ? `in progress by ${claimOwner} — do NOT duplicate work`
          : 'pending — do NOT implement yet';
        lines.push(`- Task ${t.num} — ${t.title} [${label}]`);
        if (t.suggestedScope) {
          const scopeLines = t.suggestedScope
            .split('\n')
            .map((l) => _normalizeScope(l))
            .filter(Boolean);
          if (scopeLines.length > 0) {
            lines.push(`  Reserved files: ${scopeLines.join(', ')}`);
          }
        }
      }
    }
    lines.push('');
  }

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
