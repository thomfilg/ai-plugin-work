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

/**
 * Read and parse the Claude Code hook stdin payload.
 * @returns {object|null} parsed payload or null on parse failure
 */
function readHookData() {
  try {
    const input = fs.readFileSync(0, 'utf8');
    return JSON.parse(input);
  } catch {
    return null;
  }
}

/**
 * Resolve TASKS_BASE + WORKTREES_BASE via the canonical workflow config.
 * @returns {{TASKS_BASE: string, WORKTREES_BASE: string}|null}
 */
function resolveBases() {
  try {
    const resolveMod = require(
      path.join(__dirname, '..', 'scripts', 'workflows', 'work', 'lib', 'resolve-plugin-root')
    );
    const { libDir } = resolveMod.resolvePluginPaths(__dirname, 2);
    const cfg = require(path.join(libDir, 'get-config'));
    const wt = cfg('WORKTREES_BASE') || '';
    const tb = cfg('TASKS_BASE') || (wt ? path.join(wt, 'tasks') : '');
    return tb ? { TASKS_BASE: tb, WORKTREES_BASE: wt } : null;
  } catch {
    return null;
  }
}

async function main() {
  const hookData = readHookData();
  if (!hookData) process.exit(0);

  // Guard: do NOT fire inside sub-agents — sub-agent tool calls would
  // double-dispatch extension events at both parent and sub-agent boundaries.
  const transcriptPath = hookData.transcript_path || '';
  if (transcriptPath.includes('/subagents/')) process.exit(0);

  const bases = resolveBases();
  if (!bases) process.exit(0);

  try {
    // Prevent work-hook.js's bottom-of-file main() from auto-firing the
    // /work orchestrator when we only want the exported firePreToolCall.
    process.env.WORK_HOOK_NO_MAIN = '1';
    const { firePreToolCall } = require(path.join(__dirname, 'work-hook'));
    // Await so async extension handlers complete before the hook process
    // terminates (was fire-and-forget; would silently cut off long chains).
    await firePreToolCall({
      toolName: hookData.tool_name,
      toolInput: hookData.tool_input,
      tasksBase: bases.TASKS_BASE,
      repoRoot: bases.WORKTREES_BASE || process.cwd(),
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
