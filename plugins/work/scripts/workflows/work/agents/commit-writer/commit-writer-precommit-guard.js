#!/usr/bin/env node

/**
 * PostToolUse hook for commit-writer agent — detects pre-commit hook failures.
 *
 * When git commit fails due to a pre-commit hook, saves the full error
 * to the tasks folder and blocks further tool calls.
 *
 * Exit codes:
 *   0 = allow (no pre-commit failure detected)
 *   2 = block (pre-commit hook failed — agent must stop)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { logHookError } = require(path.join(__dirname, '..', '..', '..', 'lib', 'hook-error-log'));
const getConfig = require(path.join(__dirname, '..', '..', '..', 'lib', 'get-config'));

process.on('uncaughtException', (err) => {
  logHookError(__filename, err);
  process.exit(0); // fail-open
});

function resolveTasksDir(cwd) {
  const tasksBase = getConfig('TASKS_BASE') || '';
  if (!tasksBase) return null;

  // Try to get ticket ID from branch name
  try {
    const { execSync } = require('child_process');
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // Extract ticket ID from branch (e.g., GH-279-foo → GH-279, ECHO-4399-bar → ECHO-4399)
    const match = branch.match(/^(?:feature\/)?([A-Z]+-\d+|GH-\d+)/i);
    if (match) return path.join(tasksBase, match[1]);
  } catch { /* ignore */ }

  return null;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  if (hookData.tool_name !== 'Bash') process.exit(0);

  const command = (hookData.tool_input?.command || '').trim();
  const result = hookData.tool_result || '';

  if (!/\bgit\s+commit\b/.test(command)) process.exit(0);

  // Detect pre-commit hook failure
  const isHookFailure =
    /pre-commit hook/i.test(result) ||
    /husky.*hook/i.test(result) ||
    /lint-staged/i.test(result) ||
    (/hook\b/i.test(result) && /fail|error|exit/i.test(result));

  const hasError =
    /exit code [1-9]/i.test(result) ||
    /exited with code [1-9]/i.test(result) ||
    /Command failed/i.test(result);

  if (!isHookFailure && !(hasError && /hook/i.test(result))) {
    process.exit(0);
  }

  // Save full error to tasks folder
  const cwd = hookData.cwd || process.cwd();
  const tasksDir = resolveTasksDir(cwd);
  let errorFile = '';

  if (tasksDir) {
    try {
      fs.mkdirSync(tasksDir, { recursive: true });
      errorFile = path.join(tasksDir, 'precommit-error.log');
      fs.writeFileSync(errorFile, [
        `# Pre-commit Hook Failure`,
        `**Date:** ${new Date().toISOString()}`,
        `**Command:** ${command}`,
        '',
        '## Full Output',
        '```',
        result,
        '```',
      ].join('\n'));
    } catch { /* fail-open on write */ }
  }

  const msg = errorFile
    ? `COMMIT FAILED: Pre-commit hook error. Full output saved to: ${errorFile}`
    : `COMMIT FAILED: Pre-commit hook error. Fix the issues and try again.`;

  process.stderr.write(msg + '\n');
  process.exit(2);
}

main().catch((err) => {
  logHookError(__filename, err);
  process.exit(0);
});
