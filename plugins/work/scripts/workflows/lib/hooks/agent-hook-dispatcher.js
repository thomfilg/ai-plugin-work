#!/usr/bin/env node
'use strict';

/**
 * Generic per-agent hook dispatcher for plugin-bundled agents.
 *
 * Why this exists: Claude Code strips the `hooks:` frontmatter field from
 * plugin subagents (security restriction). Plugin authors who need
 * per-agent gating must register globally and self-gate inside the script.
 * This dispatcher does that once for all agents listed in
 * agent-hook-registry.js.
 *
 * Wiring (in hooks/hooks.json):
 *   { "matcher": ".*", "hooks": [{ "type": "command",
 *     "command": "CLAUDE_HOOK_TYPE=PreToolUse node ${CLAUDE_PLUGIN_ROOT}/scripts/workflows/lib/hooks/agent-hook-dispatcher.js" }] }
 *
 * Flow per invocation:
 *   1. Buffer stdin (the Claude Code hookData JSON).
 *   2. Look up the active agent via isRunningInAgent(); exit 0 if none in registry.
 *   3. For each registry entry matching the current hook type AND the matcher:
 *        spawn the child synchronously, pipe the buffered stdin through, inherit env.
 *        On non-zero exit, propagate immediately (unless entry has optional:true).
 *   4. Fail-open on parse / detection errors.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { logHookError } = require(path.join(__dirname, '..', 'hook-error-log'));
const { isRunningInAgent } = require(path.join(__dirname, '..', 'agent-detection'));
const { REGISTRY } = require(path.join(__dirname, 'agent-hook-registry'));
const {
  resolvePluginRootHonouringEnv,
} = require('../../work/lib/resolve-plugin-root');

const VALID_HOOK_TYPES = new Set(['PreToolUse', 'PostToolUse', 'Stop']);

process.on('uncaughtException', (err) => {
  logHookError(__filename, err);
  process.exit(0);
});
process.on('unhandledRejection', (err) => {
  logHookError(__filename, err);
  process.exit(0);
});

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

function matcherAllows(entry, hookData, hookType) {
  // Stop events have no tool_name; only entries without a matcher run.
  if (hookType === 'Stop') return !entry.matcher;
  if (!entry.matcher) return true;
  const toolName = hookData?.tool_name || '';
  if (!toolName) return false;
  // Normalize lone '*' to '.*' (qa-* agents used this in their frontmatter)
  const pattern = entry.matcher === '*' ? '.*' : entry.matcher;
  let re;
  try {
    re = new RegExp(`^(?:${pattern})$`);
  } catch {
    return false;
  }
  return re.test(toolName);
}

function resolvePluginRoot() {
  // Dispatcher lives at <root>/scripts/workflows/lib/hooks/ — 4 levels up
  // reaches the plugin root. Use the env-honouring variant: subprocess scripts
  // referenced by the registry are resolved relative to CLAUDE_PLUGIN_ROOT, so
  // we must trust the user's env setting when probing lands on an unrelated
  // install (which is exactly what happens in test fixtures and in the
  // marketplace-nesting case tracked by GH-526).
  return (
    resolvePluginRootHonouringEnv(__dirname, 4) ||
    path.resolve(__dirname, '..', '..', '..', '..')
  );
}

function runEntry(entry, stdinBuffer, pluginRoot) {
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot };
  let result;
  if (entry.type === 'node') {
    const abs = path.isAbsolute(entry.command)
      ? entry.command
      : path.join(pluginRoot, entry.command);
    if (!fs.existsSync(abs)) {
      // Missing script — treat as optional (don't break the session).
      logHookError(__filename, new Error(`registry script missing: ${abs}`));
      return { code: 0 };
    }
    result = spawnSync(process.execPath, [abs], {
      input: stdinBuffer,
      stdio: ['pipe', 'inherit', 'inherit'],
      env,
    });
  } else if (entry.type === 'shell') {
    result = spawnSync('sh', ['-c', entry.command], {
      input: stdinBuffer,
      stdio: ['pipe', 'inherit', 'inherit'],
      env,
    });
  } else {
    logHookError(__filename, new Error(`unknown entry type: ${entry.type}`));
    return { code: 0 };
  }
  if (result.error) {
    logHookError(__filename, result.error);
    return { code: 0 };
  }
  return { code: result.status == null ? 0 : result.status };
}

async function main() {
  const hookType = process.env.CLAUDE_HOOK_TYPE;
  if (!VALID_HOOK_TYPES.has(hookType)) {
    // Misconfigured wiring — fail-open.
    process.exit(0);
  }

  const stdinBuffer = await readStdin();
  let hookData = {};
  try {
    hookData = JSON.parse(stdinBuffer.toString('utf8') || '{}');
  } catch {
    process.exit(0);
  }

  const pluginRoot = resolvePluginRoot();

  // Guard: when the current tool is Task/Agent, the call is the PARENT
  // *about to invoke* a subagent — the subagent isn't running yet.
  // hookData.tool_input.subagent_type names the target, not the active
  // agent. isRunningInAgent() would falsely match (via its secondary
  // tool_input.subagent_type check) and run that target's guard scripts
  // against the parent's Task call, blocking the agent from ever
  // starting. Skip dispatch on these meta-invocations.
  if (hookData.tool_name === 'Task' || hookData.tool_name === 'Agent') {
    process.exit(0);
  }

  // Find which registered agent (if any) is currently active.
  // Pass a hookData copy with tool_input.subagent_type stripped as a
  // belt-and-suspenders defense against any non-Task tool that happens
  // to carry that field — only the Task tool's tool_input legitimately
  // names a target agent, and we've already short-circuited that above.
  const detectionHookData =
    hookData.tool_input && hookData.tool_input.subagent_type
      ? { ...hookData, tool_input: { ...hookData.tool_input, subagent_type: undefined } }
      : hookData;
  const transcriptPath = hookData.transcript_path || '';
  let activeAgent = null;
  for (const agentName of Object.keys(REGISTRY)) {
    if (isRunningInAgent(transcriptPath, [agentName], detectionHookData)) {
      activeAgent = agentName;
      break;
    }
  }
  if (!activeAgent) process.exit(0);

  const entries = REGISTRY[activeAgent][hookType];
  if (!entries || entries.length === 0) process.exit(0);

  for (const entry of entries) {
    if (!matcherAllows(entry, hookData, hookType)) continue;
    const { code } = runEntry(entry, stdinBuffer, pluginRoot);
    if (code !== 0 && !entry.optional) {
      process.exit(code);
    }
  }

  process.exit(0);
}

main();
