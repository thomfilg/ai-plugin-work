/**
 * Implement step enrichment.
 *
 * Selects the right developer agent based on task type and file scope.
 * Builds a compact prompt with file references instead of embedding content.
 * The agent reads brief/spec/tasks from disk — no need to duplicate them in the prompt.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { resolveTaskType } = require(path.join(__dirname, '..', 'resolve-task-type'));

/**
 * Resolve the developer agent type from task metadata.
 *
 * Priority:
 *   1. IMPLEMENT_AGENT env var (user override)
 *   2. Suggested scope file extensions
 *   3. Task type field
 *   4. Default: developer-nodejs-tdd
 *
 * @param {string} tasksDir - Path to ticket tasks directory
 * @param {number|string} taskNum - 1-indexed task number
 * @returns {string} Agent type identifier
 */
function resolveAgentType(tasksDir, taskNum) {
  // 1. User override via env var
  if (process.env.IMPLEMENT_AGENT) return process.env.IMPLEMENT_AGENT;

  // 2. Read task metadata from tasks.md
  let taskType = null;
  let suggestedScope = '';
  try {
    const content = fs.readFileSync(path.join(tasksDir, 'tasks.md'), 'utf8');
    const pattern = new RegExp(
      `## Task ${taskNum}\\b[\\s\\S]*?### Type\\s*\\n(\\w+)[\\s\\S]*?### Suggested Scope[^\\n]*\\n([\\s\\S]*?)(?=\\n###|\\n## |$)`,
      'm'
    );
    const match = content.match(pattern);
    if (match) {
      taskType = match[1].trim().toLowerCase();
      suggestedScope = match[2].trim().toLowerCase();
    }
  } catch {
    /* no tasks.md */
  }

  // 3. Map from suggested scope file extensions
  const hasReactFiles =
    /\.(tsx|jsx)\b/.test(suggestedScope) || /react|component/i.test(suggestedScope);
  const hasInfraFiles = /dockerfile|\.ya?ml|terraform|\.tf\b|ci\/cd|pipeline/i.test(suggestedScope);

  if (hasReactFiles) return 'developer-react-senior';
  if (hasInfraFiles) return 'developer-devops';

  // 4. Map from task type
  if (taskType === 'frontend') return 'developer-react-senior';
  if (taskType === 'devops' || taskType === 'infra') return 'developer-devops';

  // 5. Default
  return 'developer-nodejs-tdd';
}

module.exports = function registerImplement(register) {
  register('implement', (entry, ctx) => {
    if (!entry.agentPrompt) return;

    // Resolve tdd-next.js via plugin root (not __dirname) to avoid agents rewriting
    // the dev repo path to the worktree cwd where work2/ doesn't exist.
    const { resolvePluginRoot } = require(path.join(__dirname, '..', 'resolve-plugin-root'));
    const pluginRoot = resolvePluginRoot(__dirname, 4);
    const tddNextPath = path.join(pluginRoot, 'workflows', 'work2', 'tdd-next.js');
    const ticket = ctx.ticket || 'TICKET';

    // Extract task number and title from the plan generator prompt
    const taskMatch = entry.agentPrompt.match(/Task (\d+) of (\d+)/);
    const taskNum = taskMatch ? taskMatch[1] : null;
    const totalTasks = taskMatch ? taskMatch[2] : null;
    const taskFlag = taskNum ? ` --task ${taskNum}` : '';

    // Extract task title from prompt
    const titleMatch = entry.agentPrompt.match(/## Current Task: Task \d+ — (.+?)(?:\n|$)/);
    const taskTitle = titleMatch ? titleMatch[1].trim() : 'Implementation';

    // Read current TDD phase
    const { readPhase } = require(path.join(__dirname, '..', '..', 'tdd-next.js'));
    const tddState = readPhase(ticket.replace('#', 'GH-'), taskNum);
    const currentPhase = tddState?.currentPhase || 'red';
    const phaseLabel =
      {
        red: 'RED — write failing tests',
        green: 'GREEN — make tests pass with minimum code',
        refactor: 'REFACTOR — clean up code',
      }[currentPhase] || `${currentPhase} phase`;

    // Mark current progress in tasks.md (shows [-] for in-progress task)
    const tasksDir = ctx.tasksDir || '';
    if (tasksDir) {
      try {
        const { markProgress } = require(path.join(__dirname, '..', 'mark-task-progress'));
        markProgress(tasksDir);
      } catch {
        /* fail-open */
      }
    }

    // Detect task type for checkpoint handling
    const taskType = resolveTaskType(tasksDir, taskNum);

    if (taskType === 'checkpoint') {
      // Checkpoint tasks: verify, don't implement. No TDD needed.
      entry.agentPrompt = [
        `## Checkpoint: Task ${taskNum || '?'}/${totalTasks || '?'} — ${taskTitle}`,
        '',
        '### What to verify',
        `Read the acceptance criteria in ${path.join(tasksDir, 'tasks.md')} (find "## Task ${taskNum}" section).`,
        'Run each verification command listed there and confirm all pass.',
        '',
        '### Rules',
        '- Do NOT write or modify any code',
        '- Do NOT record TDD evidence',
        '- Run the test commands and report results',
      ].join('\n');
      entry.agentType = 'code-checker';
      return;
    }

    // Build compact prompt for implementation tasks
    const devPrompt = [
      `## Implement Task ${taskNum || '?'}/${totalTasks || '?'} — ${taskTitle}`,
      '',
      `### TDD Phase: ${phaseLabel}`,
      'Get phase commands:',
      '```bash',
      `node "${tddNextPath}" ${ticket}${taskFlag}`,
      '```',
      'Record evidence at each phase (init → red → green → refactor) or the task will be re-dispatched.',
      '',
      '### Required Reading (read IN FULL before implementing)',
      `- **Task details:** ${path.join(tasksDir, 'tasks.md')} (find "## Task ${taskNum}" section)`,
      `- **Spec:** ${path.join(tasksDir, 'spec.md')}`,
      `- **Brief:** ${path.join(tasksDir, 'brief.md')}`,
      '',
      '### Rules',
      `- Implement ONLY Task ${taskNum} deliverables`,
      '- Do NOT touch files reserved for other tasks',
      '- Do NOT invoke /work-implement or any other skill',
      '- Follow TDD: run tdd-next.js → do the work → record evidence → transition phase',
    ].join('\n');

    entry.agentPrompt = devPrompt;
    entry.agentType = resolveAgentType(tasksDir, taskNum);
  });
};
