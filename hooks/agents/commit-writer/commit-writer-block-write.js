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

    if (!command) {
      process.stderr.write('COMMIT-WRITER GUARD: Empty command blocked.\n');
      process.exit(2);
    }

    // Destructive git patterns — checked per-segment (start of segment only)
    // to avoid false positives from arguments like git log --grep="git reset"
    const destructivePatterns = [
      /^\s*git\s+(reset|rebase|revert|checkout|restore|clean|stash|cherry-pick|merge|am|apply)\b/,
      /^\s*git\s+add\b/,
      /^\s*git\s+rm\b/,
      /^\s*git\s+branch\s+-[dD]\b/,
      /^\s*git\s+tag\s+-d\b/,
      /^\s*git\s+push\s+.*--force\b/,
      /^\s*git\s+push\s+.*-f\b/,
    ];

    // Write commands: ONLY git commit and git push (no --force)
    // Read-only commands: safe for inspection only
    const safeGitCommands = [
      'git commit', 'git push',
      'git status', 'git diff', 'git log', 'git show',
      'git rev-parse', 'git branch', 'git remote', 'git config',
      'git ls-files', 'git cat-file', 'git describe', 'git shortlog',
      'git name-rev', 'git for-each-ref', 'git tag',
    ];

    // Split by shell separators (&&, ||, ;, |) to validate each segment
    const segments = command.split(/\s*(?:&&|\|\||[;|])\s*/).filter(s => s.trim());

    if (segments.length === 0) {
      process.stderr.write('COMMIT-WRITER GUARD: Empty command blocked.\n');
      process.exit(2);
    }

    for (const segment of segments) {
      const trimmed = segment.trim();

      // Setup chain for commitlint/cz detection
      if (/^\s*(grep\s.*package\.json|ls\s\.commitlintrc)/.test(trimmed)) {
        continue;
      }

      // Block destructive git commands at start of segment
      if (destructivePatterns.some(p => p.test(trimmed))) {
        process.stderr.write(
          `COMMIT-WRITER GUARD: Destructive git command blocked. Only git commit and git push (write), plus read-only git commands allowed. Blocked: ${trimmed.substring(0, 100)}\n`
        );
        process.exit(2);
      }

      // Check if segment starts with a safe git command
      const isSafe = safeGitCommands.some(cmd => {
        const pattern = new RegExp(`^\\s*${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
        return pattern.test(trimmed);
      });

      if (!isSafe) {
        process.stderr.write(
          `COMMIT-WRITER GUARD: Only git commit, git push, and read-only git commands allowed. Blocked: ${trimmed.substring(0, 100)}\n`
        );
        process.exit(2);
      }
    }

    // All segments are safe
    process.exit(0);
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
