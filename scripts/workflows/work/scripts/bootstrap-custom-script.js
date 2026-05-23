#!/usr/bin/env node

/**
 * bootstrap-custom-script.js
 *
 * Executes a user-provided bootstrap script during the /bootstrap workflow.
 * Configured via BOOTSTRAP_SCRIPT env var (absolute or relative path).
 *
 * Uses spawnSync (not execFileSync) to capture stderr on successful runs.
 * Fail-open: any error (missing script, non-zero exit, timeout) logs a
 * warning and exits 0 so the bootstrap workflow continues.
 *
 * Usage:
 *   node bootstrap-custom-script.js <worktree-path> <ticket-id>
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const getConfig = require('../../lib/get-config');
const { logHookError } = require('../../lib/hook-error-log');

/** Default timeout for the custom script in seconds */
const DEFAULT_TIMEOUT_SECONDS = 120;

/**
 * Source `.envrc` from candidate directories and merge missing vars into
 * process.env. Direnv may not be active in the orchestrator's spawning
 * shell, so the workflow can't rely on env vars from `.envrc` being present.
 *
 * Existing process.env values are preserved (env wins over .envrc) so that
 * explicit overrides from the caller still take precedence.
 *
 * @param {string[]} candidateDirs - Directories to check for a .envrc
 * @returns {string[]} Paths of .envrc files that were sourced
 */
function loadEnvrcFromDirs(candidateDirs) {
  const sourced = [];
  const seen = new Set();
  for (const dir of candidateDirs) {
    if (!dir) continue;
    const envrcPath = path.join(dir, '.envrc');
    if (seen.has(envrcPath)) continue;
    seen.add(envrcPath);
    if (!fs.existsSync(envrcPath)) continue;

    const result = spawnSync(
      'bash',
      ['-c', `set -a; source "${envrcPath}" >/dev/null 2>&1; env -0`],
      { encoding: 'utf-8', timeout: 10000, maxBuffer: 5 * 1024 * 1024 }
    );

    if (result.status !== 0 || !result.stdout) continue;

    for (const entry of result.stdout.split('\0')) {
      if (!entry) continue;
      const eq = entry.indexOf('=');
      if (eq <= 0) continue;
      const key = entry.slice(0, eq);
      const value = entry.slice(eq + 1);
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
    sourced.push(envrcPath);
  }
  return sourced;
}

/**
 * Resolve the script path. Supports absolute and cwd-relative paths.
 * @param {string} scriptPath - Raw path from config
 * @returns {string} Resolved absolute path
 */
function resolveScriptPath(scriptPath) {
  if (path.isAbsolute(scriptPath)) return scriptPath;
  return path.resolve(process.cwd(), scriptPath);
}

/**
 * Get the timeout in milliseconds from config or default.
 * @returns {number} Timeout in milliseconds
 */
function getTimeoutMs() {
  const raw = getConfig('BOOTSTRAP_SCRIPT_TIMEOUT');
  if (raw) {
    const seconds = parseInt(raw, 10);
    if (!isNaN(seconds) && seconds > 0) return seconds * 1000;
  }
  return DEFAULT_TIMEOUT_SECONDS * 1000;
}

/**
 * Execute the custom bootstrap script.
 * @param {string} worktreePath - Path to the worktree
 * @param {string} ticketId - Ticket identifier
 * @returns {{ ok: boolean, stdout?: string, stderr?: string, error?: string }}
 */
function executeCustomScript(worktreePath, ticketId) {
  let scriptConfig = getConfig('BOOTSTRAP_SCRIPT');

  if (!scriptConfig) {
    const sourced = loadEnvrcFromDirs([worktreePath, path.dirname(worktreePath)]);
    if (sourced.length > 0) {
      console.log(`Sourced .envrc from: ${sourced.join(', ')}`);
    }
    scriptConfig = getConfig('BOOTSTRAP_SCRIPT');
  }

  if (!scriptConfig) {
    console.log('BOOTSTRAP_SCRIPT not set, skipping custom bootstrap script');
    return { ok: true };
  }

  const resolved = resolveScriptPath(scriptConfig);

  if (!fs.existsSync(resolved)) {
    console.log(`WARNING: bootstrap script not found at ${resolved}, skipping`);
    return { ok: true };
  }

  const timeoutMs = getTimeoutMs();

  console.log(`Running: ${resolved} ${worktreePath} ${ticketId}`);

  try {
    const result = spawnSync(resolved, [worktreePath, ticketId], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 50 * 1024 * 1024, // 50 MB — bootstrap scripts may run verbose installs
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.log(`STDERR: ${result.stderr}`);

    if (result.error || result.status !== 0) {
      const isTimeout =
        result.signal === 'SIGKILL' || (result.error && result.error.code === 'ETIMEDOUT');
      const exitInfo = result.status != null ? `exit ${result.status}` : 'spawn failed';

      if (isTimeout) {
        console.log(`WARNING: bootstrap script timed out after ${timeoutMs / 1000}s, skipping`);
      } else {
        const stderr = result.stderr || '';
        const msg = stderr.trim() || (result.error ? result.error.message : 'unknown error');
        console.log(`WARNING: bootstrap script failed (${exitInfo}): ${msg}`);
      }

      logHookError(__filename, result.error || new Error(exitInfo));
      return { ok: false, error: result.error ? result.error.message : exitInfo };
    }

    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    console.log(`WARNING: bootstrap script execution error: ${err.message}`);
    logHookError(__filename, err);
    return { ok: false, error: err.message };
  }
}

module.exports = { executeCustomScript, resolveScriptPath, getTimeoutMs, loadEnvrcFromDirs };

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const [worktreePath, ticketId] = args;

  if (!worktreePath || !ticketId) {
    console.error('Usage: bootstrap-custom-script.js <worktree-path> <ticket-id>');
    process.exit(1);
  }

  executeCustomScript(worktreePath, ticketId);
  process.exit(0);
}
