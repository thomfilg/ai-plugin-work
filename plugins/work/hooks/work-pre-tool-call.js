#!/usr/bin/env node
/**
 * work-pre-tool-call.js — PreToolUse hook entry point for /work extensions.
 *
 * Reads the standard Claude Code hook stdin JSON ({tool_name, tool_input,
 * transcript_path, ...}), resolves TASKS_BASE via get-config, and dispatches
 * the OnPreToolCall extension event. Fail-open in every branch — a broken
 * extension MUST NOT block a tool call.
 *
 * Registered in plugins/work/hooks/hooks.json under PreToolUse.
 */

'use strict';

const fs = require('fs');
const path = require('path');

process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

function main() {
  let hookData;
  try {
    const input = fs.readFileSync(0, 'utf8');
    hookData = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  // Guard: do NOT fire inside sub-agents — sub-agent tool calls would
  // double-dispatch extension events at both parent and sub-agent boundaries.
  const transcriptPath = hookData?.transcript_path || '';
  if (transcriptPath.includes('/subagents/')) process.exit(0);

  let TASKS_BASE = '';
  let WORKTREES_BASE = '';
  try {
    const { resolvePluginPaths } = require(
      path.join(__dirname, '..', 'scripts', 'workflows', 'work', 'lib', 'resolve-plugin-root')
    );
    const { libDir } = resolvePluginPaths(__dirname, 2);
    const getConfig = require(path.join(libDir, 'get-config'));
    WORKTREES_BASE = getConfig('WORKTREES_BASE') || '';
    TASKS_BASE =
      getConfig('TASKS_BASE') || (WORKTREES_BASE ? path.join(WORKTREES_BASE, 'tasks') : '');
  } catch {
    process.exit(0);
  }
  if (!TASKS_BASE) process.exit(0);

  try {
    // Prevent work-hook.js's bottom-of-file main() from auto-firing the
    // /work orchestrator when we only want the exported firePreToolCall.
    process.env.WORK_HOOK_NO_MAIN = '1';
    const { firePreToolCall } = require(path.join(__dirname, 'work-hook'));
    firePreToolCall({
      toolName: hookData?.tool_name,
      toolInput: hookData?.tool_input,
      tasksBase: TASKS_BASE,
      repoRoot: WORKTREES_BASE || process.cwd(),
    });
  } catch {
    /* fail-open */
  }

  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { main };
