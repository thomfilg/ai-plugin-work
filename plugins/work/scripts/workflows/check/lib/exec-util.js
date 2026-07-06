'use strict';

/**
 * check/lib/exec-util.js — tiny shared exec helper for the /check hooks
 * (previously duplicated across check-setup.js and lib/impacted-apps.js).
 *
 * No shell: the command line is split on whitespace into an argv array and
 * executed directly, so env/config-derived values (base branch, paths) can
 * never be interpreted as shell syntax. Callers pass simple space-separated
 * command lines (git subcommands) — quoting/globbing is intentionally
 * unsupported.
 */

const { execFileSync } = require('child_process');

/**
 * Execute a command (whitespace-separated argv, no shell) and return trimmed output
 */
function exec(cmd, options = {}) {
  const [file, ...args] = String(cmd).trim().split(/\s+/);
  try {
    return execFileSync(file, args, { encoding: 'utf8', ...options }).trim();
  } catch (error) {
    if (options.throwOnError !== false) {
      return '';
    }
    throw error;
  }
}

module.exports = { exec };
