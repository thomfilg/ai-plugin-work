/**
 * Implement step enrichment.
 *
 * Self-paced TDD model: the developer agent receives a minimal prompt that
 * tells it to invoke `task-next.js`, which then dictates RED → GREEN →
 * REFACTOR instructions, runs tests, validates phase transitions, and
 * records evidence via `tdd-phase-state.js`.
 *
 * This file selects the right developer agent type per task and builds the
 * dispatch payload (single or parallel). It no longer embeds TDD rules,
 * test commands, file-scope lists, or retry summaries into the prompt —
 * task-next.js owns all of that.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { resolveTaskType } = require(path.join(__dirname, '..', 'resolve-task-type'));
const { findReadyTasks } = require(path.join(__dirname, '..', 'task-graph'));

const TASK_NEXT_SCRIPT = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'work-implement',
  'task-next.js'
);

/**
 * Resolve the developer agent type from task metadata. Same heuristics as
 * the prior dispatcher — only the prompt body has been simplified.
 */
function resolveAgentType(tasksDir, taskNum) {
  if (process.env.IMPLEMENT_AGENT) return process.env.IMPLEMENT_AGENT;

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

  const hasReactFiles =
    /\.(tsx|jsx)\b/.test(suggestedScope) || /react|component/i.test(suggestedScope);
  const hasInfraFiles = /dockerfile|\.ya?ml|terraform|\.tf\b|ci\/cd|pipeline/i.test(suggestedScope);

  if (hasReactFiles) return 'developer-react-senior';
  if (hasInfraFiles) return 'developer-devops';
  if (taskType === 'frontend') return 'developer-react-senior';
  if (taskType === 'devops' || taskType === 'infra') return 'developer-devops';
  return 'developer-nodejs-tdd';
}

/**
 * Build the minimal agent prompt. The agent invokes task-next.js and follows
 * the structured Markdown response it prints (current phase, what to touch,
 * what to verify, how to advance). The script is the source of truth for
 * everything else.
 */
function buildSelfPacedPrompt(ticket, taskNum, totalTasks, taskTitle) {
  return [
    `## Task ${taskNum}${totalTasks ? `/${totalTasks}` : ''} — ${taskTitle}`,
    '',
    'You are a self-paced TDD agent. Do NOT plan ahead, write tests, or change',
    'source until you are told what phase you are in.',
    '',
    '### Single instruction',
    '```bash',
    `node ${TASK_NEXT_SCRIPT} ${ticket} task${taskNum}`,
    '```',
    '',
    'Run that command. Follow the Markdown response verbatim:',
    '- It will tell you the current phase (RED / GREEN / REFACTOR).',
    '- It will tell you which files you may touch in this phase.',
    '- It will tell you the test command it will run on your behalf.',
    '- It will tell you what must be true to advance.',
    '',
    'When you finish a phase, re-invoke the same command. The script will run',
    'the test, validate, record evidence, and either advance you or tell you',
    'precisely why it did not. Stop only when the script tells you the task',
    'is complete.',
    '',
    '### Rules',
    `- Implement ONLY Task ${taskNum} deliverables.`,
    '- Do NOT touch tdd-phase.json or .work-state.json — those are written by',
    '  the script via the authorized recorder. Direct edits are blocked.',
    '- Do NOT invoke /work-implement, /work, or any other slash command.',
  ].join('\n');
}

module.exports = function registerImplement(register) {
  register('implement', (entry, ctx) => {
    if (!entry.agentPrompt) return;

    const ticket = ctx.ticket || 'TICKET';
    const tasksDir = ctx.tasksDir || '';
    const taskMatch = entry.agentPrompt.match(/Task (\d+) of (\d+)/);
    const currentTaskNum = taskMatch ? parseInt(taskMatch[1], 10) : null;
    const totalTasks = taskMatch ? parseInt(taskMatch[2], 10) : null;

    // Parallel dispatch path: one delegate per ready-to-run task.
    if (tasksDir && totalTasks && totalTasks > 1) {
      const { parallelTasks } = findReadyTasks(tasksDir, currentTaskNum - 1);
      if (parallelTasks.length > 1) {
        const { parseTasks: parseFullTasks } = require(
          path.join(__dirname, '..', '..', '..', 'work', 'lib', 'task-parser')
        );
        const allTasks = parseFullTasks(tasksDir) || [];

        const delegates = parallelTasks.map((num) => {
          const task = allTasks.find((t) => t.num === num);
          const title = task?.title || 'Implementation';
          const agentType = resolveAgentType(tasksDir, num);
          return {
            type: 'task',
            agentType,
            description: `Task ${num}/${totalTasks} — ${title}`,
            prompt: buildSelfPacedPrompt(ticket, num, totalTasks, title),
            note: 'Pass the prompt directly to the agent.',
          };
        });

        entry._overrideInstruction = {
          type: 'work_instruction',
          action: 'execute',
          state: { ticket, currentStep: 'implement', progress: `${currentTaskNum}/${totalTasks}` },
          continue: true,
          parallel: true,
          delegates,
          note: `Launch ALL ${delegates.length} agents IN PARALLEL (single message, multiple Task tool calls). Each task is independent.`,
        };
        return;
      }
    }

    // Single-task path.
    const taskNum = taskMatch ? taskMatch[1] : null;
    const titleMatch = entry.agentPrompt.match(/## Current Task: Task \d+ — (.+?)(?:\n|$)/);
    const taskTitle = titleMatch ? titleMatch[1].trim() : 'Implementation';

    if (tasksDir) {
      try {
        const { markProgress } = require(path.join(__dirname, '..', 'mark-task-progress'));
        markProgress(tasksDir);
      } catch {
        /* fail-open */
      }
    }

    // Checkpoint tasks: pure verification, no TDD. Keep the dedicated path.
    const taskType = resolveTaskType(tasksDir, taskNum);
    if (taskType === 'checkpoint') {
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

    entry.agentPrompt = buildSelfPacedPrompt(ticket, taskNum, totalTasks, taskTitle);
    entry.agentType = resolveAgentType(tasksDir, taskNum);
  });
};
