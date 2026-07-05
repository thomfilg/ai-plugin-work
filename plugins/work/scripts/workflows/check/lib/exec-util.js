'use strict';

/**
 * check/lib/exec-util.js — tiny shared shell helper for the /check hooks
 * (previously duplicated across check-setup.js and lib/impacted-apps.js).
 */

const { execSync } = require('child_process');

/**
 * Execute a shell command and return trimmed output
 */
function exec(cmd, options = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', ...options }).trim();
  } catch (error) {
    if (options.throwOnError !== false) {
      return '';
    }
    throw error;
  }
}

module.exports = { exec };
