#!/usr/bin/env node

/**
 * SubagentStop hook: Quality gate for developer agents
 *
 * When a developer agent finishes, runs `pnpm dev:check` (lint + typecheck + test
 * on changed files only). If it fails, blocks the agent's result so the parent
 * must fix the issues before accepting the work.
 *
 * Targets: developer-nodejs-tdd, developer-devops, developer-react-senior,
 *          developer-react-ui-architect
 */

const { execSync } = require('child_process');

/**
 * Check if there are actual code changes to validate.
 * Skip if only docs/config changes or no git changes.
 */
function hasCodeChanges() {
  try {
    const diff = execSync(
      'git diff --name-only HEAD 2>/dev/null || git diff --name-only --cached 2>/dev/null || echo ""',
      { encoding: 'utf8', timeout: 5000 }
    ).trim();

    if (!diff) return false;

    const codeExtensions = ['.ts', '.tsx', '.js', '.jsx'];
    return diff.split('\n').some(file =>
      codeExtensions.some(ext => file.endsWith(ext))
    );
  } catch {
    // If git fails, try to run dev:check anyway
    return true;
  }
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  // Check if this is a developer agent
  const agentName = (hookData.agent_name || hookData.subagent_type || '').toLowerCase();


  // Skip if no code changes to validate
  if (!hasCodeChanges()) {
    process.exit(0);
  }

  // Run quality checks
  try {
    const output = execSync('pnpm dev:check', {
      encoding: 'utf8',
      timeout: 120000,
      cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Last 500 chars of output as proof
    const summary = output.trim().slice(-500);

    // Quality gate passed - exit 0 (approve)
    // Note: reason is not supported for approve in exit code mode,
    // so we log it to stderr for debugging
    console.error(`Quality gate PASSED for ${agentName}\n\n${summary}`);
    process.exit(0);
  } catch (error) {
    const stdout = error.stdout || '';
    const stderr = error.stderr || '';
    const combined = (stdout + '\n' + stderr).trim();

    // Last 1500 chars to give enough context for fixing
    const summary = combined.slice(-1500);

    process.stderr.write(`QUALITY GATE FAILED for ${agentName}\n\npnpm dev:check failed (lint, typecheck, or tests). The developer agent's changes have issues that must be fixed.\n\nDo NOT accept this agent's work as complete. Fix the issues below, then re-run pnpm dev:check.\n\nOutput:\n${summary}\n`);
    process.exit(2);
  }
}

main().catch(err => {
  console.error('Hook error:', err.message);
  // On error, approve to avoid blocking
  process.exit(0);
});
