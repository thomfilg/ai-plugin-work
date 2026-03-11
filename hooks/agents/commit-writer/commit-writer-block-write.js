#!/usr/bin/env node

/**
 * PreToolUse guard for commit-writer agent.
 * Allows: Read, Grep, Glob (read-only), Bash (git commands only)
 * Blocks: everything else (Write, Edit, Task, Skill, non-git Bash, etc.)
 *
 * Uses exit codes for decision control (most reliable per Claude Code docs):
 *   exit 0  = allow the tool call
 *   exit 2  = block the tool call (stderr message fed back to Claude)
 */

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch (err) {
    process.stderr.write(`COMMIT-WRITER GUARD: Failed to parse hook input: ${err.message}\n`);
    process.exit(2);
  }

  const toolName = hookData.tool_name || '';

  // Allow read-only tools
  if (['Read', 'Grep', 'Glob'].includes(toolName)) {
    process.exit(0);
  }

  // Allow Bash but only safe, non-destructive git commands + setup chain
  if (toolName === 'Bash') {
    const command = (hookData.tool_input?.command || '').trim();

    // Setup chain for commitlint/cz detection
    if (/^\s*(grep\s.*package\.json|ls\s\.commitlintrc)/.test(command)) {
      process.exit(0);
    }

    // Allowlist of safe git subcommands
    const safeGitCommands = [
      'git commit',
      'git status',
      'git diff',
      'git log',
      'git show',
      'git rev-parse',
      'git branch',
      'git remote',
      'git config',
      'git push',
      'git tag',
      'git ls-files',
      'git cat-file',
      'git describe',
      'git shortlog',
      'git name-rev',
      'git for-each-ref',
    ];

    const isSafeGit = safeGitCommands.some(cmd => {
      const pattern = new RegExp(`^\\s*${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
      return pattern.test(command);
    });

    if (isSafeGit) {
      process.exit(0);
    }

    // Block unsafe Bash commands
    process.stderr.write(
      `COMMIT-WRITER GUARD: Only safe git commands allowed (commit, status, diff, log, show, push, branch, remote, config). Blocked: ${command.substring(0, 100)}\n`
    );
    process.exit(2);
  }

  // Block everything else (Write, Edit, Task, Skill, etc.)
  process.stderr.write(
    `COMMIT-WRITER GUARD: "${toolName}" is not allowed. Only Read, Grep, Glob, and safe git commands allowed.\n`
  );
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`COMMIT-WRITER GUARD ERROR: ${err.message}\n`);
  process.exit(2);
});
