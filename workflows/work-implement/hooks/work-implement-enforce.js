#!/usr/bin/env node

/**
 * PreToolUse hook to enforce agent usage during /work-implement command.
 *
 * When /work-implement is active, blocks direct Write/Edit operations
 * unless a developer-* agent has been invoked first.
 */

const fs = require('fs');
const { logHookError } = require(
  require('path').join(__dirname, '..', '..', 'lib', 'hook-error-log')
);

// Developer agents that satisfy the requirement
const DEVELOPER_AGENTS = [
  'developer-nodejs-tdd',
  'developer-react-senior',
  'developer-react-ui-architect',
  'developer-devops',
  ...(process.env.WORK_ARCHITECT_ENABLED === '1' ? ['code-architect'] : []),
];

// Tools that require agent invocation first
const BLOCKED_TOOLS = ['Write', 'Edit', 'MultiEdit'];

// Files that are allowed without agent (config, non-code files)
const ALLOWED_PATTERNS = [
  /\.md$/, // Markdown files
  /\.json$/, // JSON config files
  /\.ya?ml$/, // YAML files
  /\.env/, // Environment files
  /\.gitignore$/, // Git ignore
  /\.eslintrc/, // ESLint config
  /\.prettierrc/, // Prettier config
  /package\.json$/, // Package files
  /tsconfig/, // TypeScript config
  /\/\.claude\//, // Files in .claude folder (hooks, commands, agents)
  /\/__tests__\//, // Test directories
  /\.test\.[jt]sx?$/, // .test.js, .test.ts, .test.tsx
  /\.spec\.[jt]sx?$/, // .spec.js, .spec.ts, .spec.tsx
  /work-implement-enforce\.js$/, // This file specifically
];

/**
 * Check if /work-implement command is active in the transcript
 */
function isWorkImplementActive(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return false;
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');

    // Look for /work-implement invocation
    // Pattern: Skill tool with skill: "work-implement" or direct /work-implement mention
    const patterns = [
      /<command-name>\/work-implement<\/command-name>/,
      /"skill"\s*:\s*"work-implement"/,
      /# Implement Command/, // The command's header from work-implement.md
    ];

    return patterns.some((pattern) => pattern.test(content));
  } catch {
    return false;
  }
}

/**
 * Check if a developer agent has been invoked
 */
function hasDeveloperAgentBeenInvoked(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return false;
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');

    // Check if any developer agent has been called via Task tool
    for (const agent of DEVELOPER_AGENTS) {
      const pattern = new RegExp(`"subagent_type"\\s*:\\s*"(work-workflow:)?${agent}"`, 'i');
      if (pattern.test(content)) {
        return true;
      }
    }

    // Also check if we're currently INSIDE a developer agent
    for (const agent of DEVELOPER_AGENTS) {
      const frontmatterPattern = new RegExp(`^name:\\s*${agent}`, 'm');
      if (frontmatterPattern.test(content)) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Check if the file being edited is allowed without agent
 */
function isFileAllowed(filePath) {
  if (!filePath) return false;
  return ALLOWED_PATTERNS.some((pattern) => pattern.test(filePath));
}

/**
 * Check TDD phase restrictions for a file path.
 * Returns 'block', 'allow', 'no-file' (tdd-phase.json missing), or 'no-state' (infrastructure issue).
 */
function checkTddPhase(filePath) {
  try {
    // Get ticket ID from env or shared resolver
    const ticketId =
      process.env.TICKET_ID ||
      (() => {
        try {
          const { getCurrentTaskId } = require(
            require('path').join(__dirname, '..', '..', 'lib', 'scripts', 'get-ticket-id.js')
          );
          const id = getCurrentTaskId();
          return id || null;
        } catch {
          // Fallback: extract from branch name (supports GH-123, PROJ-123, lowercase)
          try {
            const branch = require('child_process')
              .execSync('git branch --show-current', { encoding: 'utf8' })
              .trim();
            const match = branch.match(/[A-Za-z]+-[0-9]+/i);
            return match ? match[0] : null;
          } catch {
            return null;
          }
        }
      })();

    if (!ticketId) return 'no-state';

    let taskBase;
    try {
      const cfg = require(require('path').join(__dirname, '..', '..', 'lib', 'config'));
      taskBase = process.env.TASKS_BASE || cfg.TASKS_BASE || null;
    } catch {
      taskBase = process.env.TASKS_BASE || null;
    }
    if (!taskBase) {
      taskBase = require('path').join(process.env.HOME, 'worktrees', 'tasks');
    }
    // Use TASKS_BASE from env, config module, or default HOME-based fallback
    let safeTicketId = ticketId;
    try {
      safeTicketId = require(
        require('path').join(__dirname, '..', '..', 'lib', 'config')
      ).safeTicketId(ticketId);
    } catch {}
    const statePath = require('path').join(taskBase, safeTicketId, 'tdd-phase.json');
    if (!require('fs').existsSync(statePath)) return 'no-file';

    const state = JSON.parse(require('fs').readFileSync(statePath, 'utf8'));
    const { PHASE_HOOKS } = require(require('path').join(__dirname, '..', 'tdd-phase-registry'));
    const hook = PHASE_HOOKS[state.currentPhase];

    if (hook && hook.shouldBlock(filePath)) {
      process.stderr.write(hook.blockMessage + '\n');
      return 'block';
    }

    return 'allow';
  } catch {
    return 'no-state'; // On error, don't block
  }
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const hookData = JSON.parse(input);
  const toolName = hookData.tool_name;
  const toolInput = hookData.tool_input || {};
  const transcriptPath = hookData.transcript_path;

  // Only check blocked tools
  if (!BLOCKED_TOOLS.includes(toolName)) {
    process.exit(0);
  }

  // Check if /work-implement is active
  if (!isWorkImplementActive(transcriptPath)) {
    process.exit(0);
  }

  // Get the file path being edited
  const filePath = toolInput.file_path || toolInput.path || '';

  // tdd-phase.json is NOT allowed via the generic .json allowlist
  // It must be protected by TDD phase hooks or blocked entirely
  if (filePath && /tdd-phase\.json$/.test(filePath)) {
    // Block direct edits to tdd-phase.json — only tdd-phase-state.js can write it
    process.stderr.write(
      'Direct edit of tdd-phase.json is blocked.\n' +
        'Use tdd-phase-state.js CLI to manage TDD phase state.\n'
    );
    process.exit(2);
  }

  // ── TDD Phase enforcement (BEFORE allowlist) ─────────────────────────
  // Must run before isFileAllowed() because ALLOWED_PATTERNS includes test
  // files (.test.*, .spec.*) which would bypass GREEN-phase blocking
  const tddPhaseResult = checkTddPhase(filePath);
  if (tddPhaseResult === 'block') {
    // Block message already written by checkTddPhase
    process.exit(2);
  }
  // Defense-in-depth: if TDD state doesn't exist and this is a production file,
  // block until TDD is initialized. This catches cases where auto-init didn't run.
  if (
    tddPhaseResult === 'no-file' &&
    !isFileAllowed(filePath) &&
    hasDeveloperAgentBeenInvoked(transcriptPath)
  ) {
    const tddScript = require('path').join(__dirname, '..', 'tdd-phase-state.js');
    const msg =
      'TDD not initialized. Production file writes are blocked until TDD state exists.\n' +
      `Run: node ${tddScript} init <TICKET_ID>\n` +
      `Or use: node ${tddScript} exception <TICKET_ID> --reason "<reason>"\n`;
    process.stderr.write(msg);
    process.exit(2);
  }

  // Allow config/non-code files
  if (isFileAllowed(filePath)) {
    process.exit(0);
  }

  // Check if a developer agent has been invoked
  if (hasDeveloperAgentBeenInvoked(transcriptPath)) {
    process.exit(0);
  }

  // Block the operation
  const architectLine =
    process.env.WORK_ARCHITECT_ENABLED === '1'
      ? `  subagent_type: "code-architect",            // Architecture\n`
      : '';
  process.stderr.write(
    `/work-implement requires agent delegation\n\n` +
      `Direct ${toolName} blocked. Use a developer agent first:\n\n` +
      `Task({\n` +
      `  subagent_type: "developer-nodejs-tdd",      // Backend\n` +
      `  subagent_type: "developer-react-senior",    // React logic\n` +
      `  subagent_type: "developer-react-ui-architect", // UI design\n` +
      `  subagent_type: "developer-devops",          // Infrastructure\n` +
      architectLine +
      `  prompt: "Implement: <your task>"\n` +
      `})\n\n` +
      `Or for simple config changes, edit allowed files:\n` +
      `(.md, .json, .yml, .env, package.json, tsconfig.*, etc.)\n`
  );
  process.exit(2);
}

main().catch((err) => {
  logHookError(__filename, err);
  // On error, approve to avoid blocking legitimate operations
  process.exit(0);
});
