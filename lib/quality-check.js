#!/usr/bin/env node

/**
 * quality-check.js
 *
 * Shared utility for running quality checks with a 3-tier fallback:
 *   1. `pnpm dev:check` — project defines it in package.json
 *   2. Bundled dev-check scripts — this plugin's scripts/dev-check/
 *   3. Standard scripts — `pnpm lint`, `pnpm typecheck`, `pnpm test`
 *
 * Usage:
 *   const { runQualityCheck, resolveQualityCommand, getAvailableScripts } = require('./quality-check');
 *
 *   // Full run (returns { success, output, strategy })
 *   const result = runQualityCheck({ cwd: '/path/to/repo', timeout: 120000 });
 *
 *   // Just resolve which command would run (no execution)
 *   const { command, strategy } = resolveQualityCommand('/path/to/repo');
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
const BUNDLED_DEV_CHECK = path.join(PLUGIN_ROOT, 'scripts', 'dev-check', 'dev-check.sh');

/**
 * Read scripts from a repo's package.json
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
 * Find git repo root from a directory
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
 * Check if bundled dev-check scripts are available and executable
 */
function hasBundledDevCheck() {
  try {
    return fs.existsSync(BUNDLED_DEV_CHECK) && !!(fs.statSync(BUNDLED_DEV_CHECK).mode & 0o111);
  } catch {
    return false;
  }
}

/**
 * Resolve which quality command to run, without executing it.
 *
 * @param {string} repoRoot - Path to the repository root
 * @returns {{ command: string, strategy: string, scripts?: string[] }}
 *   - command: the shell command to run
 *   - strategy: 'project-dev-check' | 'bundled-dev-check' | 'standard-scripts' | 'none'
 *   - scripts: (for standard-scripts) which scripts were found
 */
function resolveQualityCommand(repoRoot) {
  const scripts = getAvailableScripts(repoRoot);

  // Tier 1: Project has dev:check in package.json
  if (scripts['dev:check']) {
    return { command: 'pnpm dev:check', strategy: 'project-dev-check' };
  }

  // Tier 2: Use bundled dev-check scripts from this plugin
  if (hasBundledDevCheck()) {
    return { command: BUNDLED_DEV_CHECK, strategy: 'bundled-dev-check' };
  }

  // Tier 3: Standard scripts (run whichever exist)
  const standardScripts = ['lint', 'typecheck', 'test'].filter(s => s in scripts);
  if (standardScripts.length > 0) {
    const command = standardScripts.map(s => `pnpm run ${s}`).join(' && ');
    return { command, strategy: 'standard-scripts', scripts: standardScripts };
  }

  // No quality scripts available
  return { command: '', strategy: 'none' };
}

/**
 * Run quality checks with the 3-tier fallback.
 *
 * @param {Object} options
 * @param {string} [options.cwd] - Working directory (will resolve repo root from this)
 * @param {number} [options.timeout=120000] - Timeout in ms per command
 * @returns {{ success: boolean, output: string, strategy: string, command: string }}
 */
function runQualityCheck(options = {}) {
  const cwd = options.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const timeout = options.timeout || 120000;
  const repoRoot = findRepoRoot(cwd);
  const { command, strategy, scripts } = resolveQualityCommand(repoRoot);

  if (strategy === 'none') {
    return {
      success: true,
      output: 'No quality scripts found — skipping checks',
      strategy: 'none',
      command: '',
    };
  }

  // For standard-scripts, run each individually to get per-script failure info
  if (strategy === 'standard-scripts') {
    const failures = [];
    let allOutput = '';

    for (const script of scripts) {
      try {
        const output = execSync(`pnpm run ${script} 2>&1`, {
          encoding: 'utf8',
          timeout,
          cwd: repoRoot,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        allOutput += output;
      } catch (err) {
        const output = (err.stdout || '') + '\n' + (err.stderr || '');
        allOutput += output;
        failures.push({ script, output: output.trim().split('\n').slice(-15).join('\n') });
      }
    }

    if (failures.length > 0) {
      const details = failures.map(f => `[${f.script}]\n${f.output}`).join('\n\n');
      return {
        success: false,
        output: `${failures.length}/${scripts.length} check(s) failed:\n${details}`,
        strategy,
        command,
      };
    }

    return { success: true, output: allOutput, strategy, command };
  }

  // For Tier 1 and Tier 2: run the single command
  try {
    const output = execSync(command, {
      encoding: 'utf8',
      timeout,
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return { success: true, output: output.trim(), strategy, command };
  } catch (err) {
    const stdout = err.stdout || '';
    const stderr = err.stderr || '';
    const combined = (stdout + '\n' + stderr).trim();

    return { success: false, output: combined, strategy, command };
  }
}

/**
 * Build a description of which check strategy will be used.
 * Useful for agent prompts and log messages.
 */
function describeStrategy(strategy) {
  switch (strategy) {
    case 'project-dev-check':
      return 'pnpm dev:check (project script)';
    case 'bundled-dev-check':
      return 'bundled dev-check scripts (plugin fallback)';
    case 'standard-scripts':
      return 'standard pnpm scripts (lint/typecheck/test)';
    case 'none':
      return 'no quality checks available';
    default:
      return strategy;
  }
}

module.exports = {
  runQualityCheck,
  resolveQualityCommand,
  getAvailableScripts,
  findRepoRoot,
  hasBundledDevCheck,
  describeStrategy,
  BUNDLED_DEV_CHECK,
};
