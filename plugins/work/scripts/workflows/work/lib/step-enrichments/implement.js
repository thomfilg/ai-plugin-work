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
const { T, renderDelegateForRuntime, getRuntime } = require(
  path.join(__dirname, '..', '..', '..', 'lib', 'instruction-vocab')
);
const { WORK_TASK_TRAILER } = require(
  path.join(__dirname, '..', '..', '..', 'task-verify', 'collect', 'attribution')
);

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
  let scopeText = '';
  try {
    const content = fs.readFileSync(path.join(tasksDir, 'tasks.md'), 'utf8');
    const pattern = new RegExp(
      `## Task ${taskNum}\\b[\\s\\S]*?### Type\\s*\\n(\\w+)[\\s\\S]*?### Files in scope[^\\n]*\\n([\\s\\S]*?)(?=\\n###|\\n## |$)`,
      'm'
    );
    const match = content.match(pattern);
    if (match) {
      taskType = match[1].trim().toLowerCase();
      scopeText = match[2].trim().toLowerCase();
    }
  } catch {
    /* no tasks.md */
  }

  const hasReactFiles = /\.(tsx|jsx)\b/.test(scopeText) || /react|component/i.test(scopeText);
  const hasInfraFiles = /dockerfile|\.ya?ml|terraform|\.tf\b|ci\/cd|pipeline/i.test(scopeText);

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

/**
 * GH-756 OUTCOME MODE prompt: the agent develops freely — no phases, no
 * evidence recording, no phase-scoped edit rules. Quality is verified at the
 * task boundary by the outcome verifier (task-verify/) over the task's
 * actual commits. Advisory feedback: when the previous boundary was
 * CONTRADICTED, the verifier's guidance is injected as INFORMATION.
 */
function buildOutcomePrompt(ticket, taskNum, totalTasks, taskTitle, tasksDir) {
  let retryReason = null;
  try {
    const ws = JSON.parse(fs.readFileSync(path.join(tasksDir, '.work-state.json'), 'utf8'));
    retryReason = ws && ws._tddRetryReason ? String(ws._tddRetryReason) : null;
  } catch {
    /* no state — no advisory block */
  }
  const lines = [
    `## Task ${taskNum}${totalTasks ? `/${totalTasks}` : ''} — ${taskTitle}`,
    '',
    `Read the "## Task ${taskNum}" section of ${path.join(tasksDir, 'tasks.md')}: the`,
    'Gherkin scenarios describe the behavior to build; Files in scope bounds',
    'where you may work.',
    '',
    '### How to work (outcome mode)',
    '- Implement the task freely: write tests and source in whatever order',
    '  serves you; run tests locally as often as you like.',
    '- Commit your work when done (per-task commit, ticket-tagged).',
    '- At the task boundary a verifier checks your COMMITS: non-empty in-scope',
    '  diff, promised files present, your tests fail on base and pass on head',
    '  with a real test count. Tests that also pass on the base tree are',
    '  flagged as tautologies for review — write tests that specify the NEW',
    '  behavior.',
    '',
    '### Rules',
    `- Implement ONLY Task ${taskNum} deliverables (stay in Files in scope).`,
    '- Do NOT edit .work-state.json — it is orchestrator-managed.',
    '- Do NOT invoke /work-implement, /work, or any other slash command.',
  ];
  if (retryReason) {
    lines.push(
      '',
      '### Previous boundary verdict (advisory)',
      'Your last attempt did not verify. The contradiction was:',
      '```',
      retryReason.slice(0, 1500),
      '```',
      'Address it, commit, and the boundary check will re-run.'
    );
  }
  return lines.join('\n');
}

/**
 * Extract task coordinates from the buildTaskPrompt output. The
 * "## Current Task: Task N — title" header is always emitted by
 * buildTaskPrompt; the "Task N of M" context block is only present when
 * allTasks.length > 1. Parse the header for the task number so single-task
 * plans don't produce "Task null" / "tasknull" in the dispatched prompt.
 */
function parseTaskHeader(agentPrompt) {
  const headerMatch = agentPrompt.match(/## Current Task: Task (\d+)/);
  const totalMatch = agentPrompt.match(/Task \d+ of (\d+)/);
  const titleMatch = agentPrompt.match(/## Current Task: Task \d+ — (.+?)(?:\n|$)/);
  return {
    currentTaskNum: headerMatch ? parseInt(headerMatch[1], 10) : null,
    totalTasks: totalMatch ? parseInt(totalMatch[1], 10) : null,
    taskTitle: titleMatch ? titleMatch[1].trim() : 'Implementation',
  };
}

/**
 * GH-769 wave attribution: every commit in a parallel wave shares one worktree
 * and one branch, so the boundary observer partitions the range by a
 * `Work-Task: <N>` commit trailer. Each wave delegate is instructed to stamp
 * its own task number; a commit without the trailer cannot be attributed and
 * degrades that boundary to UNVERIFIED. The trailer key is imported from
 * attribution.js so instruction text and the parser can never drift. Serial
 * (single-task) dispatch never appends this block.
 *
 * @param {number|string} taskNum the delegate's own task number
 * @returns {string} the instruction block appended to the delegate prompt
 */
function waveAttributionInstruction(taskNum) {
  return [
    '',
    '### Commit attribution (parallel wave)',
    'Other tasks are committing into this same worktree concurrently. EVERY',
    'commit you create MUST carry the trailer identifying this task:',
    '```bash',
    `git commit --trailer "${WORK_TASK_TRAILER}: ${taskNum}" -m "..."`,
    '```',
    `A commit without this \`${WORK_TASK_TRAILER}: ${taskNum}\` trailer cannot be attributed to`,
    'your task and your boundary will degrade to UNVERIFIED.',
  ].join('\n');
}

/**
 * Parallel dispatch path: one delegate per ready-to-run task. Returns the
 * override instruction, or null when the plan has no parallel batch to run.
 */
function buildParallelOverride(ticket, tasksDir, currentTaskNum, totalTasks) {
  if (!tasksDir || !totalTasks || totalTasks <= 1) return null;
  const { parallelTasks } = findReadyTasks(tasksDir, currentTaskNum - 1);
  if (parallelTasks.length <= 1) return null;

  const { parseTasks: parseFullTasks } = require(
    path.join(__dirname, '..', '..', '..', 'work', 'lib', 'task-parser')
  );
  const allTasks = parseFullTasks(tasksDir) || [];

  const rt = getRuntime();
  const outcomeMode = process.env.WORK_TDD_MODE === 'outcome';
  const delegates = parallelTasks.map((num) => {
    const task = allTasks.find((t) => t.num === num);
    const title = task?.title || 'Implementation';
    const agentType = resolveAgentType(tasksDir, num);
    const basePrompt = outcomeMode
      ? buildOutcomePrompt(ticket, num, totalTasks, title, tasksDir)
      : buildSelfPacedPrompt(ticket, num, totalTasks, title);
    // GH-769: every wave delegate stamps its own Work-Task trailer so the
    // boundary observer resolves its diff from its own commits.
    const prompt = basePrompt + waveAttributionInstruction(num);
    return renderDelegateForRuntime(
      {
        type: 'task',
        agentType,
        description: `Task ${num}/${totalTasks} — ${title}`,
        prompt,
        note: T('delegate.task.note.short', {}, rt.name),
      },
      rt
    );
  });

  return {
    type: 'work_instruction',
    action: 'execute',
    state: { ticket, currentStep: 'implement', progress: `${currentTaskNum}/${totalTasks}` },
    continue: true,
    parallel: true,
    delegates,
    note: T('parallel.dispatch', { count: delegates.length }, rt.name),
  };
}

/** Checkpoint tasks: pure verification, no TDD. Keep the dedicated path. */
function buildCheckpointPrompt(tasksDir, taskNum, totalTasks, taskTitle) {
  return [
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
}

function markProgressSafe(tasksDir) {
  if (!tasksDir) return;
  try {
    const { markProgress } = require(path.join(__dirname, '..', 'mark-task-progress'));
    markProgress(tasksDir);
  } catch {
    /* fail-open */
  }
}

function enrichImplement(entry, ctx) {
  if (!entry.agentPrompt) return;

  const ticket = ctx.ticket || 'TICKET';
  const tasksDir = ctx.tasksDir || '';
  const { currentTaskNum, totalTasks, taskTitle } = parseTaskHeader(entry.agentPrompt);

  const override = buildParallelOverride(ticket, tasksDir, currentTaskNum, totalTasks);
  if (override) {
    entry._overrideInstruction = override;
    return;
  }

  // Single-task path.
  const taskNum = currentTaskNum != null ? String(currentTaskNum) : null;
  markProgressSafe(tasksDir);

  const taskType = resolveTaskType(tasksDir, taskNum);
  if (taskType === 'checkpoint') {
    entry.agentPrompt = buildCheckpointPrompt(tasksDir, taskNum, totalTasks, taskTitle);
    entry.agentType = 'code-checker';
    return;
  }

  entry.agentPrompt =
    process.env.WORK_TDD_MODE === 'outcome'
      ? buildOutcomePrompt(ticket, taskNum, totalTasks, taskTitle, tasksDir)
      : buildSelfPacedPrompt(ticket, taskNum, totalTasks, taskTitle);
  entry.agentType = resolveAgentType(tasksDir, taskNum);
}

module.exports = function registerImplement(register) {
  register('implement', enrichImplement);
};
