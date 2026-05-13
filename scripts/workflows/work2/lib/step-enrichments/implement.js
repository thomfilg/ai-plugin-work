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

const { findReadyTasks, parseTasks } = require(path.join(__dirname, '..', 'task-graph'));

/**
 * Build a "### Previous attempt failed" block from work-state retry fields.
 * Returns an empty array when there is no retry context to surface.
 *
 * The gate persists `_tddRetryReason` / `_tddRetryCommand` / `_tddRetryExitCode`
 * / `_tddRetryOutputTail` whenever the implement-gate decides to re-dispatch.
 * Surfacing them here gives the agent the exact command, exit code, and tail
 * of test output — closing the rationale loop that previously led to TDD
 * evidence fabrication.
 */
function buildRetryFailureBlock(tasksDir, _ticket, targetTaskNum) {
  if (!tasksDir) return [];
  let ws;
  try {
    // The state file lives at <tasksDir>/.work-state.json directly. Round-tripping
    // via path.dirname(tasksDir) + ticket would break when the raw ticket
    // (e.g. "#56") differs from its sanitized directory basename ("GH-56"),
    // and would double-nest under suffix workflows. Read tasksDir directly.
    const statePath = path.join(tasksDir, '.work-state.json');
    ws = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return [];
  }
  const reason = ws && ws._tddRetryReason;
  if (!reason) return [];
  // Scope retry context to the failing task. Parallel dispatch builds one
  // delegate per task; surfacing task N's failure to task M's agent would
  // misdirect effort.
  const retryTask = ws._tddRetryTask;
  if (targetTaskNum !== null && targetTaskNum !== undefined && retryTask !== undefined) {
    if (Number(retryTask) !== Number(targetTaskNum)) return [];
  }
  const count = ws._tddRetryCount || 0;
  const cmd = ws._tddRetryCommand || '';
  const exitCode = ws._tddRetryExitCode;
  const tail = ws._tddRetryOutputTail || '';
  const lines = [`### Previous attempt failed (retry ${count})`, '', `Reason: ${reason}`];
  if (cmd) {
    lines.push('', `Test command that ran: \`${cmd}\``);
  }
  if (exitCode !== null && exitCode !== undefined) {
    lines.push(`Exit code: ${exitCode}`);
  }
  if (tail) {
    lines.push('', 'Last lines of test output:', '```', tail, '```');
  }
  lines.push(
    '',
    'What to fix:',
    '  - If the test failed → fix the source so the command above passes.',
    '  - If the command itself errored (command-not-found, syntax, missing',
    '    dependency, malformed parser output) → that is a tasks.md problem.',
    '    Stop and surface it. Do NOT write `tdd-phase.json` yourself; that',
    '    file is gate-only and any write will be blocked by the hook.',
    ''
  );
  return lines;
}

module.exports = function registerImplement(register) {
  register('implement', (entry, ctx) => {
    if (!entry.agentPrompt) return;

    const ticket = ctx.ticket || 'TICKET';

    // Check for parallel tasks
    const tasksDir = ctx.tasksDir || '';
    const taskMatch = entry.agentPrompt.match(/Task (\d+) of (\d+)/);
    const currentTaskNum = taskMatch ? parseInt(taskMatch[1], 10) : null;
    const totalTasks = taskMatch ? parseInt(taskMatch[2], 10) : null;

    if (tasksDir && totalTasks && totalTasks > 1) {
      const { parallelTasks } = findReadyTasks(tasksDir, currentTaskNum - 1);
      if (parallelTasks.length > 1) {
        // Use task-parser (not task-graph) to get testCommand and suggestedScope
        const { parseTasks: parseFullTasks } = require(
          path.join(__dirname, '..', '..', '..', 'work', 'task-parser')
        );
        const allTasks = parseFullTasks(tasksDir) || parseTasks(tasksDir);

        const getConfig = require(path.join(__dirname, '..', '..', '..', 'lib', 'get-config'));
        const delegates = parallelTasks.map((num) => {
          const task = allTasks.find((t) => t.num === num);
          const agentType = resolveAgentType(tasksDir, num);
          const parallelTestCmd = task?.testCommand || null;
          const parallelScope = task?.suggestedScope || '';

          // Detect suite per-delegate so each parallel task gets the right
          // TEST_*_COMMAND in its prompt.
          const pType = String(task?.type || '').toLowerCase();
          const pTitle = String(task?.title || '');
          const pIsE2E =
            /e2e|playwright/i.test(parallelScope) ||
            pType === 'e2e' ||
            /e2e|playwright/i.test(pTitle);
          const pIsInt =
            /integration|\.int\./i.test(parallelScope) ||
            pType === 'integration' ||
            /integration/i.test(pTitle);
          const pSuite = pIsE2E ? 'e2e' : pIsInt ? 'integration' : 'unit';
          const pEnvVar =
            pSuite === 'e2e'
              ? 'TEST_E2E_COMMAND'
              : pSuite === 'integration'
                ? 'TEST_INTEGRATION_COMMAND'
                : 'TEST_UNIT_COMMAND';
          const pCmd = (() => {
            try {
              return getConfig(pEnvVar) || '';
            } catch {
              return '';
            }
          })();
          const parallelTestCmdsBlock = pCmd
            ? [
                '### Test Commands',
                `This task is a **${pSuite}** task. Run tests with:`,
                '```bash',
                `# ${pEnvVar} (resolved):`,
                pCmd,
                '```',
                'Invoke via:',
                '```bash',
                `CHANGED_FILES="<files-you-touched>" eval "$${pEnvVar}"`,
                '```',
                '',
              ]
            : [
                '### Test Commands',
                `Run tests via \`$${pEnvVar}\` (project-configured).`,
                '```bash',
                `CHANGED_FILES="<files-you-touched>" eval "$${pEnvVar}"`,
                '```',
                '',
              ];

          const parallelTddSection = parallelTestCmd
            ? [
                ...(parallelScope
                  ? [
                      '### Files to implement',
                      ...parallelScope
                        .split('\n')
                        .map((l) => l.trim())
                        .filter(Boolean)
                        .map((l) => `- \`${l.replace(/^[-*+]\s+/, '').replace(/`/g, '')}\``),
                      '',
                    ]
                  : []),
                ...parallelTestCmdsBlock,
                '### How to verify',
                `Run \`${parallelTestCmd}\` and ensure it passes before stopping.`,
              ]
            : parallelTestCmdsBlock;

          const delegateRetryBlock = buildRetryFailureBlock(tasksDir, ticket, num);
          return {
            type: 'task',
            agentType,
            description: `Task ${num}/${totalTasks} — ${task?.title || 'Implementation'}`,
            prompt: [
              `## Implement Task ${num}/${totalTasks} — ${task?.title || 'Implementation'}`,
              '',
              ...delegateRetryBlock,
              ...parallelTddSection,
              '',
              '### Required Reading',
              `- **Task details:** ${path.join(tasksDir, 'tasks.md')} (find "## Task ${num}" section)`,
              `- **Spec:** ${path.join(tasksDir, 'spec.md')}`,
              `- **Brief:** ${path.join(tasksDir, 'brief.md')}`,
              '',
              '### Rules',
              `- Implement ONLY Task ${num} deliverables`,
              '- Do NOT touch files reserved for other tasks',
            ].join('\n'),
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

    // Reuse taskMatch/totalTasks from parallel check above
    const taskNum = taskMatch ? taskMatch[1] : null;

    // Extract task title from prompt
    const titleMatch = entry.agentPrompt.match(/## Current Task: Task \d+ — (.+?)(?:\n|$)/);
    const taskTitle = titleMatch ? titleMatch[1].trim() : 'Implementation';

    // Mark current progress in tasks.md (shows [-] for in-progress task)
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

    // Detect task suite (e2e / integration / unit) from scope + type + title.
    // Used to surface the matching TEST_*_COMMAND env var to the agent.
    let testSuite = null;
    let e2eRules = '';
    try {
      const content = fs.readFileSync(path.join(tasksDir, 'tasks.md'), 'utf8');
      const scopeMatch = content.match(
        new RegExp(
          `## Task ${taskNum}\\b[\\s\\S]*?### Suggested Scope[^\\n]*\\n([\\s\\S]*?)(?=\\n###|\\n## |$)`,
          'm'
        )
      );
      const scope = scopeMatch ? scopeMatch[1] : '';
      const isE2E =
        /e2e|playwright/i.test(scope) || taskType === 'e2e' || /e2e|playwright/i.test(taskTitle);
      const isIntegration =
        /integration|\.int\./i.test(scope) ||
        taskType === 'integration' ||
        /integration/i.test(taskTitle);
      if (isE2E) testSuite = 'e2e';
      else if (isIntegration) testSuite = 'integration';
      else testSuite = 'unit';

      if (isE2E) {
        e2eRules = [
          '',
          '### E2E Test Rules (MANDATORY)',
          '- **Selectors:** Use `data-testid` ONLY. Never `getByRole`, `getByText`, `.first()`, `.nth()`, `[role=...]`, CSS classes. Add `data-testid` to production components if missing.',
          '- **Waits:** NEVER assert immediately after click/navigate/submit. Always wait for expected state (`waitFor`, `toBeVisible`, `waitForURL`).',
          '- **Timeouts:** NEVER hardcode timeouts. Use project timeout tiers if they exist. Never increase timeouts — fix the root cause instead.',
          '- **Race conditions:** Wait for API response before checking state. Wait for UI to reflect mutations before polling.',
        ].join('\n');
      }
    } catch {
      /* fail-open */
    }

    // Pick up the configured TEST_*_COMMAND for this suite so the agent runs
    // the project's canonical test runner (with $CHANGED_FILES placeholder
    // expansion) instead of inventing its own command line.
    let suiteEnvVar = null;
    let suiteCommand = '';
    try {
      const getConfig = require(path.join(__dirname, '..', '..', '..', 'lib', 'get-config'));
      if (testSuite === 'e2e') {
        suiteEnvVar = 'TEST_E2E_COMMAND';
        suiteCommand = getConfig('TEST_E2E_COMMAND') || '';
      } else if (testSuite === 'integration') {
        suiteEnvVar = 'TEST_INTEGRATION_COMMAND';
        suiteCommand = getConfig('TEST_INTEGRATION_COMMAND') || '';
      } else if (testSuite === 'unit') {
        suiteEnvVar = 'TEST_UNIT_COMMAND';
        suiteCommand = getConfig('TEST_UNIT_COMMAND') || '';
      }
    } catch {
      /* fail-open */
    }

    // Read task metadata (testCommand, suggestedScope) from task-parser
    let hasGateTDD = false;
    let taskTestCommand = null;
    let taskScope = '';
    try {
      const { parseTasks: parseFullTasks } = require(
        path.join(__dirname, '..', '..', '..', 'work', 'task-parser')
      );
      const allParsedTasks = parseFullTasks(tasksDir);
      const currentTask = allParsedTasks?.find((t) => t.num === Number(taskNum));
      taskTestCommand = currentTask?.testCommand || null;
      taskScope = currentTask?.suggestedScope || '';
      hasGateTDD = !!taskTestCommand;
    } catch {
      /* fail-open */
    }

    // Build the "### Test Commands" block listing the suite-specific
    // env-var-based command for this task. The agent should run it via:
    //   CHANGED_FILES="<files>" eval "$TEST_E2E_COMMAND"
    // (or the integration / unit variant). $CHANGED_FILES gets expanded
    // against the suggested scope.
    const testCommandsBlock =
      suiteEnvVar && suiteCommand
        ? [
            '### Test Commands',
            `This task is a **${testSuite}** task. Run tests with the project-configured runner:`,
            '```bash',
            `# ${suiteEnvVar} (resolved):`,
            suiteCommand,
            '```',
            'Invoke via:',
            '```bash',
            `CHANGED_FILES="<files-you-touched>" eval "$${suiteEnvVar}"`,
            '```',
            'Do NOT invent your own test command. If $CHANGED_FILES is unset, use the resolved command above.',
            '',
          ]
        : suiteEnvVar
          ? [
              '### Test Commands',
              `This task is a **${testSuite}** task. The project should expose \`$${suiteEnvVar}\` — invoke via:`,
              '```bash',
              `CHANGED_FILES="<files-you-touched>" eval "$${suiteEnvVar}"`,
              '```',
              `If \`$${suiteEnvVar}\` is unset, ask the user to configure it before proceeding.`,
              '',
            ]
          : [];

    const tddSection = hasGateTDD
      ? [
          ...(taskScope
            ? [
                '### Files to implement',
                ...taskScope
                  .split('\n')
                  .map((l) => l.trim())
                  .filter(Boolean)
                  .map((l) => `- \`${l.replace(/^[-*+]\s+/, '').replace(/`/g, '')}\``),
                '',
              ]
            : []),
          ...testCommandsBlock,
          '### How to verify',
          'Run this and ensure it passes before stopping:',
          '```',
          taskTestCommand,
          '```',
        ]
      : testCommandsBlock;

    const singleRetryBlock = buildRetryFailureBlock(
      tasksDir,
      ticket,
      taskNum != null ? Number(taskNum) : null
    );
    const devPrompt = [
      `## Implement Task ${taskNum || '?'}/${totalTasks || '?'} — ${taskTitle}`,
      '',
      ...singleRetryBlock,
      ...tddSection,
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
      e2eRules,
    ].join('\n');

    entry.agentPrompt = devPrompt;
    entry.agentType = resolveAgentType(tasksDir, taskNum);
  });
};
