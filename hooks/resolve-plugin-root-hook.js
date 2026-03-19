#!/usr/bin/env node

/**
 * PreToolUse Bash hook: Auto-resolve ${CLAUDE_PLUGIN_ROOT} in commands.
 *
 * When the AI copies a command from SKILL.md containing ${CLAUDE_PLUGIN_ROOT},
 * the shell variable is unset in the AI's Bash environment. This hook:
 * 1. Detects the unresolved variable in the command
 * 2. Resolves the actual path using process.env.CLAUDE_PLUGIN_ROOT, falling back to __dirname
 * 3. Blocks and provides the corrected command with the resolved path (parent of __dirname)
 *
 * The AI then re-runs the corrected command — zero guessing needed.
 */

const path = require('path');

// Fail-open: unexpected errors should never block unrelated commands
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

// Resolved by Claude Code when running hooks; falls back to parent of __dirname for direct invocation
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const hookData = JSON.parse(input);
  const command = hookData?.tool_input?.command || '';

  // Check if command contains unresolved CLAUDE_PLUGIN_ROOT
  if (
    !command.includes('${CLAUDE_PLUGIN_ROOT}') &&
    !command.includes('$CLAUDE_PLUGIN_ROOT')
  ) {
    process.exit(0); // allow — nothing to resolve
  }

  // Replace variable with actual path (use replacer function to avoid $ special sequences)
  const fixed = command
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () => PLUGIN_ROOT)
    .replace(/\$CLAUDE_PLUGIN_ROOT\b/g, () => PLUGIN_ROOT);

  // Guard: if regex didn't match (e.g. $CLAUDE_PLUGIN_ROOT_DIR), allow unchanged command
  if (fixed === command) {
    process.exit(0);
  }

  process.stderr.write(
    `CLAUDE_PLUGIN_ROOT resolved → ${PLUGIN_ROOT}\n\nRun this instead:\n${fixed}\n`
  );
  process.exit(2); // block — AI should retry with the corrected command
}

main().catch(() => process.exit(0));
