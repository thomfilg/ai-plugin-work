/**
 * gh-exec.js — Shared gh CLI wrapper
 *
 * Executes `gh` commands via execFileSync with JSON parsing,
 * error handling, and optional non-zero exit tolerance.
 */
const { execFileSync } = require('child_process');

/**
 * Execute a gh CLI command synchronously.
 * @param {string|string[]} ghArgs - Command arguments (string is split on whitespace)
 * @param {object} [opts]
 * @param {boolean} [opts.json=true] - Parse stdout as JSON
 * @param {boolean} [opts.allowNonZero=false] - Tolerate non-zero exit codes
 * @returns {*} Parsed JSON or trimmed string
 */
function ghExec(ghArgs, { json = true, allowNonZero = false } = {}) {
  const args = typeof ghArgs === 'string' ? ghArgs.split(/\s+/) : ghArgs;
  try {
    const result = execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    return json ? JSON.parse(result) : result.trim();
  } catch (err) {
    if (allowNonZero && err.stdout) {
      const stdout = err.stdout.toString().trim();
      if (json && stdout) {
        try {
          return JSON.parse(stdout);
        } catch {
          /* fall through */
        }
      }
      if (!json && stdout) return stdout;
    }
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    throw new Error(`gh command failed: gh ${args.join(' ')}\n${stderr}`);
  }
}

module.exports = { ghExec };
