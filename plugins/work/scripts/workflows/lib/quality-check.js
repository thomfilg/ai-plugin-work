#!/usr/bin/env node

/**
 * quality-check.js
 *
 * Shared utility for running quality checks with a 4-tier fallback:
 *   0. Env-var overrides — `$LINT_COMMAND`/`$TYPECHECK_COMMAND`/`$TEST_COMMAND`
 *      from .envrc. Routed through the bundled dev-check.sh which honors them.
 *   1. `pnpm dev:check` — project defines it in package.json
 *   2. Bundled dev-check scripts — this plugin's scripts/dev-check/
 *   3. Standard scripts — `$LINT_COMMAND`/`$TYPECHECK_COMMAND`/`$TEST_COMMAND`,
 *      else `pnpm run <script>` for whichever of lint/typecheck/test exist
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

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { resolvePluginRootHonouringEnv } = require('../work/lib/resolve-plugin-root');

// BUNDLED_DEV_CHECK below is derived from PLUGIN_ROOT, so the user's
// CLAUDE_PLUGIN_ROOT must be honoured verbatim when probing lands on an
// unrelated install. Falls back to __dirname-based resolution otherwise.
const PLUGIN_ROOT =
  resolvePluginRootHonouringEnv(__dirname, 2) || path.join(__dirname, '..', '..');
const BUNDLED_DEV_CHECK = path.join(
  PLUGIN_ROOT,
  'workflows',
  'lib',
  'scripts',
  'dev-check',
  'dev-check.sh'
);

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
      stdio: 'pipe',
      cwd,
      encoding: 'utf8',
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
  const envOverridesPresent =
    process.env.LINT_COMMAND || process.env.TYPECHECK_COMMAND || process.env.TEST_COMMAND;

  // Tier 0: Env-var overrides take precedence — route through the bundled
  // dev-check.sh which honors $LINT_COMMAND / $TYPECHECK_COMMAND / $TEST_COMMAND.
  // This makes the repo's .envrc the source of truth, bypassing whatever
  // `dev:check` happens to do in package.json.
  if (envOverridesPresent && hasBundledDevCheck()) {
    return { command: BUNDLED_DEV_CHECK, strategy: 'env-overrides' };
  }

  // Tier 1: Project has dev:check in package.json
  if (scripts['dev:check']) {
    return { command: 'pnpm dev:check', strategy: 'project-dev-check' };
  }

  // Tier 2: Use bundled dev-check scripts from this plugin
  if (hasBundledDevCheck()) {
    return { command: BUNDLED_DEV_CHECK, strategy: 'bundled-dev-check' };
  }

  // Tier 3: Standard scripts (run whichever exist)
  const standardScripts = ['lint', 'typecheck', 'test'].filter((s) => s in scripts);
  if (standardScripts.length > 0) {
    const command = standardScripts.map((s) => `pnpm run ${s}`).join(' && ');
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

  // For standard-scripts, run each individually to get per-script failure info.
  // Use execFileSync so the script name and pnpm path are passed as argv tokens
  // — no shell interpolation, no command-injection surface from env-derived
  // paths or unusual script names.
  if (strategy === 'standard-scripts') {
    const failures = [];
    let allOutput = '';

    for (const script of scripts) {
      try {
        const output = execFileSync('pnpm', ['run', script], {
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
      const details = failures.map((f) => `[${f.script}]\n${f.output}`).join('\n\n');
      return {
        success: false,
        output: `${failures.length}/${scripts.length} check(s) failed:\n${details}`,
        strategy,
        command,
      };
    }

    return { success: true, output: allOutput, strategy, command };
  }

  // For Tier 1 and Tier 2: run via execFileSync with a strategy-derived argv.
  // The `command` string is preserved for the return value (so callers see what
  // ran), but execution uses an explicit file+args pair so env-derived paths
  // like BUNDLED_DEV_CHECK are never re-parsed by a shell.
  const spec =
    strategy === 'project-dev-check'
      ? { file: 'pnpm', args: ['dev:check'] }
      : { file: BUNDLED_DEV_CHECK, args: [] };
  try {
    const output = execFileSync(spec.file, spec.args, {
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
    case 'env-overrides':
      return 'bundled dev-check.sh honoring $LINT_COMMAND/$TYPECHECK_COMMAND/$TEST_COMMAND';
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
