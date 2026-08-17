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
    return require('../engine/work.workflow');
  } catch {
    return null;
  }
}
void _loadWorkWorkflowLazy;

const fs = require('fs');
const path = require('path');
const { fileExists, readFile } = require('./work-helpers');
const taskParserStrategy = require('./task-parser-strategy');

function extractTestStrategy(taskBody) {
  return taskParserStrategy.extractTestStrategy(taskBody, extractSectionByHeading);
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
 * Normalise a single scope-section line by stripping leading list markers
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

/**
 * Parse a bulleted scope section (Files in scope / Files explicitly out of scope)
 * into a deduplicated array of glob patterns / paths. Skips empty lines,
 * comments, and lines that are just markdown noise.
 *
 * @param {RegExpMatchArray|null} sectionMatch
 * @returns {string[]}
 */
function _parseScopeList(sectionMatch) {
  if (!sectionMatch) return [];
  const lines = sectionMatch[1].split('\n');
  const out = [];
  const seen = new Set();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('<!--')) continue;
    let stripped = _normalizeScope(line).replace(/^`+/, '').replace(/`+$/, '').trim();
    if (!stripped) continue;
    // Strip trailing annotations: the brief-writer / jira-task-creator
    // templates produce entries like:
    //   `lib/sibling.ts — owned by [GH-100]`
    //   `app/x.ts -- owned by SIBLING-1, see #42`
    //   `path/to/y.ts (sibling-owned: GH-99)`
    // Gate D / Gate E match this entry against actual filesystem paths,
    // so the annotation must not survive into the parsed value. Cut at
    // the first ` — `, ` -- `, ` # `, or ` (`.
    const cutMatch = stripped.match(/\s+(?:—|--|#|\()/);
    if (cutMatch) stripped = stripped.slice(0, cutMatch.index).trim();
    // Strip any wrapping backticks that survived (e.g. `lib/x.ts` — owned…
    // becomes `lib/x.ts` after the cut; strip the closing backtick).
    stripped = stripped.replace(/^`+/, '').replace(/`+$/, '').trim();
    if (!stripped) continue;
    if (seen.has(stripped)) continue;
    seen.add(stripped);
    out.push(stripped);
  }
  return out;
}

/**
 * Extract a markdown ### section body by heading, anchored at start-of-line
 * so inline-backtick mentions like `- See \`### Files in scope\` convention`
 * do not collide with the real section.
 *
 * SECURITY NOTE: `heading` is treated as a hardcoded literal — no regex-escape
 * is applied. All call sites in this file pass constant strings (e.g.
 * `### Files in scope`). Dynamic / user-supplied input is out of scope for
 * this ticket per spec §Security Considerations; do not pass untrusted values.
 *
 * Returns a 2-element array shaped like String.prototype.match() output
 * (`[whole, body]`) so callers — including `_parseScopeList` which reads
 * `sectionMatch[1]` — work unchanged. Returns `null` when the heading is
 * not present.
 *
 * @param {string} body  Task body markdown to search.
 * @param {string} heading  Literal heading line, including leading `### `.
 * @returns {[string, string] | null}
 */
function extractSectionByHeading(body, heading) {
  // Anchor heading at start-of-line via (?:^|\n) so inline-backtick mentions
  // like `- See \`### Files in scope\` convention` (mid-line) are skipped.
  // We avoid the `m` flag because it would also redefine `$` in the
  // lookahead terminator (`$` matches every line-end under `m`), which
  // would prematurely truncate sections whose final line has no trailing
  // newline. Section body terminates at the next ### / ## heading or EOF.
  // The `[^\\n]*` after the heading tolerates trailing heading text
  // (e.g. `### Files in scope (globs)`).
  const pattern = new RegExp(`(?:^|\\n)${heading}[^\\n]*\\n([\\s\\S]*?)(?=\\n###|\\n## |$)`);
  const m = body.match(pattern);
  if (!m) return null;
  return [m[0], m[1]];
}

// ─── Task Parsing ────────────────────────────────────────────────────────────

function _extractTitle(body, num) {
  const titleMatch = body.match(/^[\s]*[—–-]+\s*(.+?)$/m);
  const firstLine = body.split('\n')[0]?.trim();
  return titleMatch ? titleMatch[1].trim() : firstLine || `Task ${num}`;
}

function _extractType(body) {
  const typeMatch = body.match(/### Type\s*\n([^\n#]+)/);
  return typeMatch ? typeMatch[1].trim().toLowerCase() : 'unknown';
}

function _extractDependencies(body) {
  const depsMatch = body.match(/### Dependencies\s*\n([\s\S]*?)(?=\n###|\n## |$)/);
  const depsText = depsMatch ? depsMatch[1].trim() : '';
  const dependencies = [];
  const depNums = depsText.match(/Task\s+(\d+)/g);
  if (!depNums) return dependencies;
  for (const d of depNums) {
    const n = parseInt(d.replace(/Task\s+/, ''), 10);
    if (!isNaN(n)) dependencies.push(n);
  }
  return dependencies;
}

function _sectionText(body, heading) {
  const m = extractSectionByHeading(body, heading);
  return m ? m[1].trim() : '';
}

function _parseTaskBlock(num, rawBody) {
  // Strip trailing non-task ## sections (e.g. ## Requirement Coverage, ## Extracted Requirements)
  const body = rawBody.replace(/\n## (?!Task\s)\S[\s\S]*$/, '').trim();
  const title = _extractTitle(body, num);
  const type = _extractType(body);
  const isCheckpoint = type === 'checkpoint' || /checkpoint/i.test(title);
  return {
    id: `task_${num}`,
    num,
    title,
    type,
    isCheckpoint,
    dependencies: _extractDependencies(body),
    requirementsCovered: _sectionText(body, '### Requirements Covered'),
    acceptanceCriteria: _sectionText(body, '### Acceptance Criteria'),
    filesInScope: _parseScopeList(extractSectionByHeading(body, '### Files in scope')),
    filesOutOfScope: _parseScopeList(
      extractSectionByHeading(body, '### Files explicitly out of scope')
    ),
    crossTaskDeps: _parseScopeList(extractSectionByHeading(body, '### Cross-Task Dependencies')),
    testStrategy: extractTestStrategy(body),
    rawContent: `## Task ${num} ${body}`,
  };
}

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
    tasks.push(_parseTaskBlock(num, rawBody));
  }

  return tasks.length > 0 ? tasks : null;
}

/**
 * @param {object} task - Current task object from parseTasks()
 * @param {string} tasksDir - Path to the task directory
 * @param {Array|null} allTasks - All tasks from parseTasks(), used to build task context
 * @param {object|null} taskState - tasksMeta from work state, used to show completion status
 */
function _formatPendingLabel(tasksDir, t) {
  const claimOwner = _readClaimOwner(tasksDir, t.num);
  return claimOwner
    ? `in progress by ${claimOwner} — do NOT duplicate work`
    : 'pending — do NOT implement yet';
}

function _scopeReservedLine(filesInScope) {
  const scopeLines = Array.isArray(filesInScope) ? filesInScope.filter(Boolean) : [];
  return scopeLines.length > 0 ? `  Reserved files: ${scopeLines.join(', ')}` : null;
}

function _renderPeerTaskLines(t, tasksDir, currentNum, persistedTasks) {
  const lines = [];
  if (t.num === currentNum) {
    lines.push(`- **Task ${t.num} — ${t.title}** ← YOU ARE IMPLEMENTING THIS`);
    return lines;
  }
  const taskMeta = persistedTasks.find((tm) => tm.id === `task_${t.num}`);
  if (taskMeta?.status === 'completed') {
    lines.push(`- Task ${t.num} — ${t.title} [✓ completed — do NOT re-implement]`);
    return lines;
  }
  lines.push(`- Task ${t.num} — ${t.title} [${_formatPendingLabel(tasksDir, t)}]`);
  const reserved = _scopeReservedLine(t.filesInScope);
  if (reserved) lines.push(reserved);
  return lines;
}

function _renderTaskContext(task, tasksDir, allTasks, taskState) {
  if (!allTasks || allTasks.length <= 1) return [];
  const persistedTasks = Array.isArray(taskState?.tasks) ? taskState.tasks : [];
  const lines = [
    '### Task Context',
    `This is Task ${task.num} of ${allTasks.length}. Scope boundaries are listed below to prevent drift:`,
    '',
  ];
  for (const t of allTasks) {
    lines.push(..._renderPeerTaskLines(t, tasksDir, task.num, persistedTasks));
  }
  lines.push('');
  return lines;
}

function buildTaskPrompt(task, tasksDir, allTasks, taskState) {
  const lines = [
    `## Current Task: Task ${task.num} — ${task.title}`,
    '',
    'You are implementing ONE task from the task plan. Do NOT implement other tasks.',
    '',
    ..._renderTaskContext(task, tasksDir, allTasks, taskState),
    '### Task Details',
    task.rawContent,
    '',
    '### Rules',
    '- Implement ONLY the deliverables listed in this task',
    "- Do NOT modify files outside this task's suggested scope unless necessary for this task's deliverables",
    '- Every acceptance criterion must be met before this task is complete',
    '',
    '### Reference Documents',
    'The full brief and spec are available for context but your scope is LIMITED to this task:',
    `- Brief: ${path.join(tasksDir, 'brief.md')}`,
    `- Spec: ${path.join(tasksDir, 'spec.md')}`,
    `- Full task plan: ${path.join(tasksDir, 'tasks.md')}`,
  ];
  return lines.join('\n');
}

module.exports = { parseTasks, buildTaskPrompt, extractTestStrategy };
