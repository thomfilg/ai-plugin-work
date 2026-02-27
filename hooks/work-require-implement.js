#!/usr/bin/env node

/**
 * PreToolUse hook to enforce /work-implement usage during /work command.
 *
 * When /work is active (after bootstrap, before commit), blocks direct
 * Write/Edit operations unless /work-implement has been invoked.
 *
 * Also provides hard protection for /work-implement assets themselves,
 * preventing escape-hatch edits via allowed patterns.
 */

const fs = require('fs');
const config = require('../lib/config');

// Tools that require /work-implement first
const BLOCKED_TOOLS = ['Write', 'Edit', 'MultiEdit'];

// ─────────────────────────────────────────────────────────────────────────────
// Protect only /work-implement command assets from being edited as an escape hatch
// ─────────────────────────────────────────────────────────────────────────────
const WORK_IMPLEMENT_UNLOCK_PHRASE = 'edit work-implement';
const PROTECTED_WORK_IMPLEMENT_PATTERNS = [
  /(?:^|\/)work-implement-enforce\.js$/i,
  /(?:^|\/)work-implement\.md$/i,
  /(?:^|\/)work-implement(?:\/|$)/i, // if you keep a folder for the command
];

// Files that are allowed without /work-implement (config, non-code files)
const ALLOWED_PATTERNS = [
  /\.md$/,           // Markdown files
  /\.json$/,         // JSON config files
  /\.ya?ml$/,        // YAML files
  /\.env/,           // Environment files
  /\.gitignore$/,    // Git ignore
  /\.eslintrc/,      // ESLint config
  /\.prettierrc/,    // Prettier config
  /package\.json$/,  // Package files
  /tsconfig/,        // TypeScript config
  new RegExp(config.TASKS_BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),  // Global task tracking files
  /\.task-/,         // Task files
];

function isProtectedWorkImplementFile(filePath) {
  if (!filePath) return false;
  return PROTECTED_WORK_IMPLEMENT_PATTERNS.some(p => p.test(filePath));
}

function hasUnlockPhrase(transcriptPath, phrase) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return false;
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    return content.includes(phrase);
  } catch {
    return false;
  }
}

/**
 * Check if /work command is active in the transcript
 */
function isWorkCommandActive(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return false;
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');

    // Look for /work invocation (but not /work-implement or /work-pr)
    const workPatterns = [
      /<command-name>\/work<\/command-name>/,
      /"skill"\s*:\s*"work"[^-]/,  // "work" but not "work-implement" or "work-pr"
      /# Start Work Command/  // The command's header from work.md
    ];

    // Check if /work is active
    const hasWork = workPatterns.some(pattern => pattern.test(content));

    if (!hasWork) return false;

    // Check if we're past Step 3 (bootstrap) but before Step 6 (commit)
    // Look for signs that bootstrap is done
    const bootstrapDone = new RegExp('\\/bootstrap\\s+' + config.JIRA_PROJECT_KEY + '-\\d+').test(content) ||
                          /Worktree.*created|worktree.*exists/i.test(content) ||
                          /draft PR.*created/i.test(content);

    // Check if commit step has been reached
    const commitReached = /commit-writer|Step 6.*commit/i.test(content);

    // Only enforce during implementation phase (after bootstrap, before commit)
    return bootstrapDone && !commitReached;
  } catch {
    return false;
  }
}

/**
 * Check if /work-implement has been invoked
 */
function hasWorkImplementBeenInvoked(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return false;
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');

    // Check for /work-implement invocation
    const patterns = [
      /<command-name>\/work-implement<\/command-name>/,
      /"skill"\s*:\s*"work-implement"/,
      /# Implement Command/  // The command's header
    ];

    return patterns.some(pattern => pattern.test(content));
  } catch {
    return false;
  }
}

/**
 * Check if currently inside a developer agent.
 * Only checks the tail of the transcript to avoid matching stale historical invocations.
 */
function isInsideDeveloperAgent(transcriptPath, opts = {}) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return false;
  }

  try {
    const full = fs.readFileSync(transcriptPath, 'utf8');
    const tailBytes = typeof opts.tailBytes === 'number' ? opts.tailBytes : 20000;
    const content = full.slice(Math.max(0, full.length - tailBytes));
    const developerAgents = opts.allowAgents || [
      'developer-nodejs-tdd',
      'developer-react-senior',
      'developer-react-ui-architect',
      'developer-devops',
    ];

    // Check if we're inside a developer agent
    for (const agent of developerAgents) {
      const frontmatterPattern = new RegExp(`^name:\\s*${agent}`, 'm');
      if (frontmatterPattern.test(content)) {
        return true;
      }
      // Also check if agent was invoked via Task
      const taskPattern = new RegExp(`"subagent_type"\\s*:\\s*"${agent}"`, 'i');
      if (taskPattern.test(content)) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Check if the file being edited is allowed without /work-implement
 */
function isFileAllowed(filePath) {
  if (!filePath) return false;
  return ALLOWED_PATTERNS.some(pattern => pattern.test(filePath));
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

  // Get the file path being edited
  const filePath = toolInput.file_path || toolInput.path || '';

  // ── Hard protection: /work-implement assets ────────────────────────────────
  // This runs regardless of /work being active, so it can't be used as an escape hatch.
  if (isProtectedWorkImplementFile(filePath)) {
    const unlocked = hasUnlockPhrase(transcriptPath, WORK_IMPLEMENT_UNLOCK_PHRASE);
    const insideNodejsTdd = isInsideDeveloperAgent(transcriptPath, {
      allowAgents: ['developer-nodejs-tdd'],
      tailBytes: 20000,
    });

    if (!unlocked || !insideNodejsTdd) {
      process.stderr.write(
        `/work-implement protection\n\n` +
        `Direct ${toolName} blocked for protected /work-implement assets:\n` +
        `  ${filePath}\n\n` +
        `To edit these files you must:\n` +
        `  1) include the exact unlock phrase in the prompt:\n` +
        `     "${WORK_IMPLEMENT_UNLOCK_PHRASE}"\n` +
        `  2) delegate via developer-nodejs-tdd\n`
      );
      process.exit(2);
    }

    process.exit(0);
  }

  // Check if /work command is active in implementation phase
  if (!isWorkCommandActive(transcriptPath)) {
    process.exit(0);
  }

  // Allow config/non-code files
  if (isFileAllowed(filePath)) {
    process.exit(0);
  }

  // Check if /work-implement has been invoked
  if (hasWorkImplementBeenInvoked(transcriptPath)) {
    process.exit(0);
  }

  // Check if inside a developer agent (which means /work-implement delegated properly)
  if (isInsideDeveloperAgent(transcriptPath)) {
    process.exit(0);
  }

  // Block the operation
  process.stderr.write(
    `/work Step 4 requires /work-implement\n\n` +
    `Direct ${toolName} blocked during /work implementation phase.\n\n` +
    `You MUST invoke /work-implement first:\n\n` +
    `  /work-implement <summary of ticket requirements>\n\n` +
    `This ensures:\n` +
    `  - Proper agent delegation (developer-*)\n` +
    `  - TodoWrite planning\n` +
    `  - Quality checks before proceeding\n\n` +
    `See /work Step 4 for details.\n`
  );
  process.exit(2);
}

main().catch(err => {
  console.error('Hook error:', err.message);
  // On error, approve to avoid blocking legitimate operations
  process.exit(0);
});
