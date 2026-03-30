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
 * Pattern follows work2-orchestrator-hook.js.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

const WORKFLOWS_DIR = path.join(__dirname, '..', 'workflows');
const ENGINE_PATH = path.join(__dirname, '..', 'lib', 'workflow-engine.js');

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

  try {
    // Run the workflow engine
    const result = execSync(
      `node "${ENGINE_PATH}" ${matched} plan ${args}`,
      { encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const plan = JSON.parse(result);

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

  } catch (err) {
    console.log(`WORKFLOW ENGINE FAILED: ${err.message}`);
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

  const files = fs.readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.workflow.js'));

  for (const file of files) {
    try {
      const wf = require(path.join(WORKFLOWS_DIR, file));
      if (wf.command && wf.name) {
        map[wf.command] = wf.name;
      }
    } catch {
      // Skip invalid workflow files
    }
  }

  return map;
}

try { main(); } catch { process.exit(0); }
