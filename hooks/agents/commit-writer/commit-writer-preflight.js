#!/usr/bin/env node

/**
 * PreToolUse hook for Task tool — blocks commit-writer from spawning
 * if there are no staged changes or if quality checks fail.
 *
 * Smart script detection: reads package.json to find available scripts.
 * Priority order:
 *   1. dev:check (composite — runs lint+typecheck+test on changed files)
 *   2. Individual dev: scripts (dev:lint, dev:typecheck, dev:test)
 *   3. Standard scripts (lint, typecheck, test)
 *   4. No scripts found → approve (not a Node.js project or no checks configured)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Scripts to look for, in priority tiers
// Each tier: { scripts[], composite (single vs multi), stopOnMatch (don't check lower tiers) }
const SCRIPT_TIERS = [
  // Tier 1: composite check (runs everything in one shot)
  { scripts: ['dev:check'], composite: true },
  // Tier 2: individual dev-mode scripts (faster, changed-files-only)
  { scripts: ['dev:lint', 'dev:typecheck', 'dev:test'], composite: false },
  // Tier 3: standard scripts (full project)
  { scripts: ['lint', 'typecheck', 'test'], composite: false },
];

/**
 * Find git repo root from cwd
 */
function findRepoRoot(cwd) {
  try {
    return execSync('git rev-parse --show-toplevel', {
      stdio: 'pipe', cwd, encoding: 'utf8',
    }).trim();
  } catch {
    return cwd;
  }
}

/**
 * Read available scripts from package.json at the given root
 */
function getAvailableScripts(repoRoot) {
  const pkgPath = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return {};
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.scripts || {};
  } catch {
    return {};
  }
}

/**
 * Determine which quality scripts to run.
 * Returns array of script names, or empty if nothing available.
 */
function selectScriptsToRun(availableScripts) {
  for (const tier of SCRIPT_TIERS) {
    const found = tier.scripts.filter(s => s in availableScripts);
    if (tier.composite && found.length > 0) {
      // Composite script found — use only that
      return found;
    }
    if (!tier.composite && found.length > 0) {
      // Individual scripts — run all that exist in this tier
      return found;
    }
  }
  return [];
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
    process.exit(2);
  } catch {
    // Exit code 1 means there ARE staged changes — continue
  }

  // Check 2: Detect and run available quality scripts
  const repoRoot = findRepoRoot(cwd);
  const availableScripts = getAvailableScripts(repoRoot);
  const scriptsToRun = selectScriptsToRun(availableScripts);

  if (scriptsToRun.length === 0) {
    // No package.json or no quality scripts — approve (config repo, docs, etc.)
    process.exit(0);
  }

  // Run each selected script
  const failures = [];
  for (const script of scriptsToRun) {
    try {
      execSync(`pnpm run ${script} 2>&1`, {
        stdio: 'pipe',
        timeout: 300000, // 5 min max per script
        cwd: repoRoot,
        encoding: 'utf8',
      });
    } catch (err) {
      const output = err.stdout?.toString() || err.stderr?.toString() || err.message || '';
      const lines = output.split('\n');
      const truncated = lines.slice(-15).join('\n');
      failures.push({ script, output: truncated });
    }
  }

  if (failures.length > 0) {
    const details = failures.map(f => `[${f.script}]\n${f.output}`).join('\n\n');
    process.stderr.write(`COMMIT-WRITER PREFLIGHT: ${failures.length}/${scriptsToRun.length} check(s) failed:\n${details}\n`);
    process.exit(2);
  }

  // All checks passed
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`COMMIT-WRITER PREFLIGHT ERROR: ${err.message}\n`);
  process.exit(2);
});
