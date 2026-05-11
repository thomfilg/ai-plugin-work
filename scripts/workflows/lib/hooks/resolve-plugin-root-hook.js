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
const { logHookError } = require(path.join(__dirname, '..', 'hook-error-log'));

// Fail-open: unexpected errors should never block unrelated commands
process.on('uncaughtException', (err) => {
  logHookError(__filename, err);
  process.exit(0);
});
process.on('unhandledRejection', (err) => {
  logHookError(__filename, err);
  process.exit(0);
});

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..', '..', '..');

async function main() {
  let input = ''; // read hook JSON from stdin
  for await (const chunk of process.stdin) input += chunk;

  const hookData = JSON.parse(input);
  const command = hookData?.tool_input?.command || '';

  // Check if command contains unresolved CLAUDE_PLUGIN_ROOT
  if (!command.includes('${CLAUDE_PLUGIN_ROOT}') && !command.includes('$CLAUDE_PLUGIN_ROOT')) {
    process.exit(0); // allow — nothing to resolve
  }

  // Replace unescaped variable refs with actual path (negative lookbehind skips escaped \$)
  const fixed = command
    .replace(/(?<!\\)\$\{CLAUDE_PLUGIN_ROOT\}/g, () => PLUGIN_ROOT)
    .replace(/(?<!\\)\$CLAUDE_PLUGIN_ROOT\b/g, () => PLUGIN_ROOT);

  // No match (escaped \$, similar var like _DIR) — allow the command unchanged
  if (fixed === command) {
    process.exit(0);
  }
  // Block with the corrected command so the AI can re-run it directly
  const message = `CLAUDE_PLUGIN_ROOT resolved → ${PLUGIN_ROOT}\n\nRun this instead:\n${fixed}\n`;
  process.stderr.write(message);
  process.exit(2);
}

main().catch((err) => {
  logHookError(__filename, err);
  process.exit(0);
});
