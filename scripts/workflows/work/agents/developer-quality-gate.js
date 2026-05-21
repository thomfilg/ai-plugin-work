#!/usr/bin/env node

/**
 * SubagentStop hook: Quality gate for developer agents
 *
 * When a developer agent finishes, runs quality checks with a 3-tier fallback:
 *   1. `pnpm dev:check` — if the project defines it in package.json
 *   2. Bundled dev-check scripts — this plugin's scripts/dev-check/
 *   3. Standard scripts — `pnpm lint`, `pnpm typecheck`, `pnpm test`
 *
 * If checks fail, blocks the agent's result so the parent
 * must fix the issues before accepting the work.
 *
 * Targets: developer-nodejs-tdd, developer-devops, developer-react-senior,
 *          developer-react-ui-architect
 */

const { execSync } = require('child_process');
const path = require('path');
const { runQualityCheck, describeStrategy } = require(
  path.join(__dirname, '..', '..', 'lib', 'quality-check')
);

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
    return diff.split('\n').some((file) => codeExtensions.some((ext) => file.endsWith(ext)));
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
  } catch (err) {
    process.stderr.write(`DEVELOPER QUALITY GATE: Failed to parse hook input: ${err.message}\n`);
    process.exit(2);
  }

  // Check if this is a developer agent
  const agentName = (hookData.agent_name || hookData.subagent_type || '').toLowerCase();

  // Skip if no code changes to validate
  if (!hasCodeChanges()) {
    process.exit(0);
  }

  // Run quality checks (3-tier fallback: project dev:check → bundled scripts → standard scripts)
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const result = runQualityCheck({ cwd, timeout: 120000 });
  const strategyLabel = describeStrategy(result.strategy);

  if (result.success) {
    const summary = result.output.slice(-500);
    console.error(`Quality gate PASSED for ${agentName} [${strategyLabel}]\n\n${summary}`);
    process.exit(0);
  } else {
    const summary = result.output.slice(-1500);
    process.stderr.write(
      `QUALITY GATE FAILED for ${agentName}\n\nQuality checks failed using ${strategyLabel}. The developer agent's changes have issues that must be fixed.\n\nDo NOT accept this agent's work as complete. Fix the issues below, then re-run quality checks.\n\nOutput:\n${summary}\n`
    );
    process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`DEVELOPER QUALITY GATE ERROR: ${err.message}\n`);
  process.exit(2);
});
