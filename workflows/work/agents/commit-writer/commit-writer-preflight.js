#!/usr/bin/env node

/**
 * PreToolUse hook for Task tool — blocks commit-writer from spawning
 * if there are no staged changes or if quality checks fail.
 *
 * Uses shared quality-check utility with 3-tier fallback:
 *   1. `pnpm dev:check` — project defines it in package.json
 *   2. Bundled dev-check scripts — this plugin's scripts/dev-check/
 *   3. Standard scripts — `pnpm lint`, `pnpm typecheck`, `pnpm test`
 *   4. No scripts found → approve (not a Node.js project or no checks configured)
 */

const { execSync } = require('child_process');
const path = require('path');

let didBlock = false;
process.on('uncaughtException', () => process.exit(didBlock ? 2 : 0));
process.on('unhandledRejection', () => process.exit(didBlock ? 2 : 0));

let runQualityCheck, describeStrategy;
try {
  const qc = require(path.join(__dirname, '..', '..', '..', 'lib', 'quality-check'));
  runQualityCheck = qc.runQualityCheck;
  describeStrategy = qc.describeStrategy;
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND' && /['"].*lib\/quality-check['"]/.test(err.message)) {
    process.exit(0); // Can't load quality checks — fail open
  } else {
    throw err;
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
    process.stderr.write(`COMMIT-WRITER PREFLIGHT: Failed to parse hook input: ${err.message}\n`);
    didBlock = true;
    process.exit(2);
  }

  // Only intercept Task tool calls
  if (hookData.tool_name !== 'Task') {
    process.exit(0);
  }

  // Only intercept commit-writer agent
  const subagentType = hookData.tool_input?.subagent_type || '';
  if (subagentType !== 'commit-writer' && subagentType !== 'work-workflow:commit-writer') {
    process.exit(0);
  }

  const cwd = hookData.cwd || process.cwd();

  // Check 1: Are there staged changes?
  try {
    execSync('git diff --staged --quiet', { stdio: 'pipe', cwd });
    // Exit code 0 means NO changes staged
    process.stderr.write('COMMIT-WRITER PREFLIGHT: No staged changes found. Stage files with `git add` first.\n');
    didBlock = true;
    process.exit(2);
  } catch {
    // Exit code 1 means there ARE staged changes — continue
  }

  // Check 2: Run quality checks (3-tier fallback)
  const result = runQualityCheck({ cwd, timeout: 300000 });
  const strategyLabel = describeStrategy(result.strategy);

  if (result.strategy === 'none') {
    // No quality scripts found — approve (config repo, docs, etc.)
    process.exit(0);
  }

  if (!result.success) {
    const summary = result.output.split('\n').slice(-20).join('\n');
    process.stderr.write(`COMMIT-WRITER PREFLIGHT: Quality checks failed [${strategyLabel}]:\n${summary}\n`);
    didBlock = true;
    process.exit(2);
  }

  // All checks passed
  process.exit(0);
}

main().catch(() => process.exit(didBlock ? 2 : 0));
