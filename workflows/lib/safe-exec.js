'use strict';

const { execFileSync } = require('node:child_process');

/**
 * Execute a command safely using execFileSync (no shell interpolation).
 *
 * Drop-in replacement for the legacy `run()` helper that used `execSync`,
 * eliminating shell-injection risk by passing arguments as an array.
 *
 * @param {string} command  — absolute or PATH-resolved executable name
 * @param {string[]} [args] — argument list (never concatenated into a shell string)
 * @param {object}  [opts]  — options forwarded to execFileSync, plus:
 * @param {*}       [opts.fallback=''] — value returned when the command fails
 * @param {number}  [opts.timeout=15000] — execution timeout in ms
 * @param {string}  [opts.encoding='utf-8'] — output encoding
 * @param {string}  [opts.cwd] — working directory
 * @returns {string} trimmed stdout on success, or `opts.fallback` on error
 */
function safeExec(command, args = [], opts = {}) {
  // Strip fallback and shell/stdio from caller opts to prevent dangerous overrides:
  //   - shell: would enable shell interpolation (injection risk)
  //   - stdio: would allow leaking stdout/stderr to parent
  //   - fallback: not a valid execFileSync option
  const { fallback = '', shell: _shell, stdio: _stdio, ...execOpts } = opts;

  const finalOpts = {
    encoding: 'utf-8',
    timeout: 15000,
    ...execOpts,
    // Enforced after spread — callers cannot override. Shell invocation
    // is impossible because execFileSync does not spawn a shell.
    shell: false, // execFileSync does not spawn a shell; this is defense-in-depth
    stdio: ['pipe', 'pipe', 'pipe'], // enforced after spread — no override
  }; // safeExec cannot be turned into a shell invocation: shell is forced false

  try {
    return execFileSync(command, args, finalOpts).trim();
  } catch {
    return fallback;
  }
}

module.exports = { safeExec };
