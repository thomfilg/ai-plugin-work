#!/usr/bin/env node

/**
 * PreToolUse hook for pr-generator agent.
 *
 * Blocks any Bash command that attempts to modify files, fix tests,
 * run test/lint/typecheck commands, or alter source code.
 * The pr-generator is a READ-ONLY agent — it can only read code and
 * run git/gh commands.
 *
 * Exception: `pnpm dev:check` is allowed as a read-only quality gate.
 * If it fails, the agent must stop — not fix anything.
 */

const { logHookError } = require(
  require('path').join(__dirname, '..', '..', '..', 'lib', 'hook-error-log')
);

// Patterns for commands that modify files
const FILE_MODIFY_PATTERNS = [
  // Direct file write/edit via shell
  /\bsed\s+-i\b/,
  /\bawk\b.*>/,
  /\becho\b.*>/,
  /\bcat\b.*<<.*>/,
  /\bprintf\b.*>/,
  /\btee\b/,
  /\bmv\b/,
  /\bcp\b/,
  /\brm\b/,
  /\bmkdir\b/,
  /\btouch\b/,
  // Redirect operators (but not git/gh piping)
  /[^|]>\s*[^&|]/,
];

// Destructive git subcommand arguments
const DESTRUCTIVE_GIT_PATTERNS = [
  /^\s*git\s+branch\s+(-[dD]|--delete)\b/,
  /^\s*git\s+push\s+.*--force\b/,
  /^\s*git\s+push\s+.*--delete\b/,
];

// Commands that indicate attempting to fix code
const FIX_ATTEMPT_PATTERNS = [
  /\bpnpm\s+(test|lint|typecheck|dev:lint|dev:typecheck|dev:test)\b/,
  /\bvitest\b/,
  /\beslint\b.*--fix/,
  /\bprettier\b.*--write/,
  /\bnpx\b.*fix/,
  /\bnode\b.*fix/,
  /\bpatch\b/,
];

// Allowed git subcommands — read-only + commit + push (no merge, rebase, reset, etc.)
const ALLOWED_GIT_SUBCOMMANDS =
  /^\s*git\s+(diff|log|show|status|branch|rev-parse|ls-files|fetch|commit|push)\b/;

// Explicitly allowed commands (quality gate + git/gh)
const ALLOWED_COMMANDS = [
  /^\s*pnpm\s+dev:check\b/, // Quality gate — read-only verification
  /^\s*(\w+=\S+\s+)*([\w./-]*\/)?dev-check\.sh(\s+[-\w=./]+)*\s*$/, // Bundled dev-check scripts — plugin fallback (anchored, no shell chaining)
  ALLOWED_GIT_SUBCOMMANDS,
  /^\s*gh\b/,
  /^\s*DEFAULT_BRANCH=/,
  /^\s*echo\s+"/, // echo for display only (no redirect)
];

function isAllowedCommand(command) {
  for (const pattern of ALLOWED_COMMANDS) {
    if (pattern.test(command) && !/[^|]>\s*[^&|]/.test(command)) {
      return true;
    }
  }
  // gh commands are always allowed, even with pipes
  if (/^\s*gh\b/.test(command)) {
    return true;
  }
  // Allowed git subcommands with pipes (e.g., git log | head)
  if (ALLOWED_GIT_SUBCOMMANDS.test(command)) {
    return true;
  }
  return false;
}

function isBlockedCommand(command) {
  // Check for destructive git arguments
  for (const pattern of DESTRUCTIVE_GIT_PATTERNS) {
    if (pattern.test(command)) {
      return `Destructive git command detected: ${pattern}`;
    }
  }
  // Check for file modification patterns
  for (const pattern of FILE_MODIFY_PATTERNS) {
    if (pattern.test(command)) {
      return `File modification detected: ${pattern}`;
    }
  }
  // Check for fix attempt patterns
  for (const pattern of FIX_ATTEMPT_PATTERNS) {
    if (pattern.test(command)) {
      return `Test/lint/fix command detected: ${pattern}`;
    }
  }
  return null;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    // If we can't parse, approve to avoid blocking
    process.exit(0);
  }

  // Only guard pr-generator agent
  const agentName = hookData.agent_name || hookData.subagent_type || '';
  if (
    !agentName.toLowerCase().includes('pr-generator') ||
    agentName.toLowerCase().includes('post')
  ) {
    process.exit(0);
  }

  // Extract the Bash command from the tool input
  const toolInput = hookData.tool_input || hookData.input || {};
  const command = toolInput.command || '';

  if (!command) {
    process.exit(0);
  }

  // Check allowed commands first (quality gate, git, gh)
  if (isAllowedCommand(command)) {
    process.exit(0);
  }

  // Check for blocked patterns
  const blockReason = isBlockedCommand(command);
  if (blockReason) {
    process.stderr.write(
      `PR-GENERATOR READ-ONLY GUARD: ${blockReason}. The pr-generator agent is read-only and cannot modify files or run test/lint/fix commands. Report the issue and return control to the parent agent.\n`
    );
    process.exit(2);
  }

  // For any other command, approve (e.g. cat for reading, ls, etc.)
  process.exit(0);
}

main().catch((err) => {
  logHookError(__filename, err);
  // On error, approve to avoid blocking
  process.exit(0);
});
