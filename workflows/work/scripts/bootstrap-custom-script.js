#!/usr/bin/env node

/**
 * bootstrap-custom-script.js
 *
 * Executes a user-provided bootstrap script during the /bootstrap workflow.
 * Configured via BOOTSTRAP_SCRIPT env var (absolute or relative path).
 *
 * Fail-open: any error (missing script, non-zero exit, timeout) logs a
 * warning and exits 0 so the bootstrap workflow continues.
 *
 * Usage:
 *   node bootstrap-custom-script.js <worktree-path> <ticket-id>
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const getConfig = require('../../lib/get-config');
const { logHookError } = require('../../lib/hook-error-log');

/** Default timeout for the custom script in seconds */
const DEFAULT_TIMEOUT_SECONDS = 120;

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
  const scriptConfig = getConfig('BOOTSTRAP_SCRIPT');
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

  try {
    const stdout = execFileSync(resolved, [worktreePath, ticketId], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (stdout) console.log(stdout);
    return { ok: true, stdout };
  } catch (err) {
    const isTimeout = err.killed || err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM';

    if (isTimeout) {
      console.log(`WARNING: bootstrap script timed out after ${timeoutMs / 1000}s, skipping`);
    } else {
      const stderr = err.stderr || '';
      console.log(
        `WARNING: bootstrap script failed (exit ${err.status}): ${stderr.trim() || err.message}`
      );
    }

    logHookError(__filename, err);
    return { ok: false, error: err.message };
  }
}

module.exports = { executeCustomScript, resolveScriptPath, getTimeoutMs };

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const [worktreePath, ticketId] = args;

  if (!worktreePath || !ticketId) {
    console.error('Usage: bootstrap-custom-script.js <worktree-path> <ticket-id>');
    process.exit(1);
  }

  executeCustomScript(worktreePath, ticketId);
}
