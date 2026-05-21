#!/usr/bin/env node

/**
 * workflow-router-hook.js
 *
 * Single UserPromptSubmit hook that routes slash commands to the workflow engine.
 * Scans plugin workflows/ and $HOME/.claude/workflows/ for matching commands.
 *
 * When a match is found, runs the workflow engine's `plan` subcommand
 * and injects the formatted plan into the chat context.
 *
 * Pattern follows work-orchestrator-hook.js.
 */

const fs = require('fs');
const path = require('path');
const { logHookError } = require(path.join(__dirname, '..', 'hook-error-log'));
const { safeExec } = require(path.join(__dirname, '..', 'safe-exec'));

process.on('uncaughtException', (err) => {
  logHookError(__filename, err);
  process.exit(0);
});
process.on('unhandledRejection', (err) => {
  logHookError(__filename, err);
  process.exit(0);
});

const WORKFLOWS_DIR = path.join(__dirname, '..', '..');
const ENGINE_PATH = path.join(__dirname, '..', 'workflow-engine.js');

// Tokenize args string into positional single-token values.
// Quoted multi-word args are NOT supported by design — matches pre-execFileSync
// shell tokenization behavior. Used by both /work and /work slash commands.
function tokenizeArgs(rawArgs) {
  return rawArgs.split(/\s+/).filter((token) => token.length > 0);
}

function main() {
  const userPrompt = process.env.CLAUDE_USER_PROMPT || '';

  // Build a map of command → workflow name from discovered workflows
  const commandMap = buildCommandMap();
  if (Object.keys(commandMap).length === 0) {
    process.exit(0); // No workflows found, pass through
  }

  // Check if prompt matches any registered workflow command
  let matched = null;
  let args = '';

  for (const [command, workflowName] of Object.entries(commandMap)) {
    // Build regex: command at start of prompt, followed by space + args
    const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^\\s*${escaped}\\s+(.+)`, 'i');
    const m = userPrompt.match(re);
    if (m) {
      matched = workflowName;
      args = m[1].trim();
      break;
    }
  }

  if (!matched) {
    process.exit(0); // Not a workflow command, pass through
  }

  // Tokenize via the named helper to make the intent obvious at the call site.
  // See tokenizeArgs() above for the scope-constraint rationale.
  const parsedArgs = tokenizeArgs(args);

  // Run the workflow engine via safeExec (uses execFileSync internally, no shell).
  // Use a null fallback so we can distinguish a failure from empty output.
  const result = safeExec(process.execPath, [ENGINE_PATH, matched, 'plan', ...parsedArgs], {
    timeout: 30000,
    fallback: null,
  });

  if (result === null) {
    logHookError(__filename, new Error('workflow engine invocation failed'));
    console.log('WORKFLOW ENGINE FAILED: command returned null');
    process.exit(0);
  }

  let plan;
  try {
    plan = JSON.parse(result);
  } catch (err) {
    logHookError(__filename, err);
    console.log(`WORKFLOW ENGINE FAILED: ${err.message}`);
    process.exit(0);
  }

  if (plan.error) {
    console.log(`WORKFLOW ENGINE ERROR: ${plan.message}`);
    process.exit(0);
  }

  // Use the formatted output from the engine
  if (plan.formatted) {
    console.log(plan.formatted);
  } else {
    // Fallback: output raw JSON
    console.log(JSON.stringify(plan, null, 2));
  }

  process.exit(0);
}

/**
 * Scan workflows directory and build command → name map.
 * @returns {{ [command: string]: string }}
 */
function buildCommandMap() {
  const map = {};

  if (!fs.existsSync(WORKFLOWS_DIR)) return map;

  // Scan the workflows dir and one level of subdirectories for *.workflow.js
  const searchDirs = [WORKFLOWS_DIR];
  for (const entry of fs.readdirSync(WORKFLOWS_DIR, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      !entry.name.startsWith('.') &&
      entry.name !== 'node_modules' &&
      entry.name !== 'lib' &&
      entry.name !== '__tests__'
    ) {
      searchDirs.push(path.join(WORKFLOWS_DIR, entry.name));
    }
  }

  for (const dir of searchDirs) {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.workflow.js'));
    for (const file of files) {
      try {
        const wf = require(path.join(dir, file));
        if (wf.command && wf.name) {
          map[wf.command] = wf.name;
        }
      } catch {
        // Skip invalid workflow files
      }
    }
  }

  return map;
}

try {
  main();
} catch {
  process.exit(0);
}
