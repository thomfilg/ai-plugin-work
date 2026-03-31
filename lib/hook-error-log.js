/**
 * hook-error-log.js
 *
 * Logs hook errors to a file instead of stderr, preventing false
 * "hook error" noise in Claude Code (which treats any stderr as an error).
 *
 * When ENFORCE_HOOK_DEBUG=1: writes to stderr (for interactive debugging)
 * Otherwise: appends to /tmp/claude-hook-errors.log (silent, reviewable later)
 *
 * Race-condition safe: uses O_APPEND with short writes. On Linux ext4/xfs,
 * appends under ~4KB are effectively atomic. Each line includes PID
 * to distinguish concurrent Claude instances.
 *
 * Auto-rotates: truncates when file exceeds MAX_LOG_SIZE (1MB).
 *
 * Usage (basic — error message only):
 *   const { logHookError } = require('./hook-error-log');
 *   main().catch(err => { logHookError(__filename, err); process.exit(0); });
 *
 * Usage (with session context — for richer debugging):
 *   main().catch(err => {
 *     logHookError(__filename, err, { tool: hookData.tool_name, input: hookData.tool_input });
 *     process.exit(0);
 *   });
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Default log path — overridable via HOOK_ERROR_LOG env var.
// File is created with 0o600 permissions (owner-only read/write) to mitigate /tmp security risks.
const LOG_FILE = process.env.HOOK_ERROR_LOG || '/tmp/claude-hook-errors.log';
const MAX_LOG_SIZE = 1024 * 1024; // 1MB

// Ensure log file has restrictive permissions (0o600) on first use
let _logFileSecured = false;
function secureLogFile() {
  if (_logFileSecured) return;
  _logFileSecured = true;
  try {
    if (fs.existsSync(LOG_FILE)) {
      // Guard against symlink attacks: lstatSync checks the link itself (not its target),
      // so a malicious symlink pointing elsewhere is detected and removed before writing.
      const stat = fs.lstatSync(LOG_FILE);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(LOG_FILE);
        const fd = fs.openSync(LOG_FILE, fs.constants.O_CREAT | fs.constants.O_WRONLY, 0o600);
        fs.closeSync(fd);
        return;
      }
      try { fs.chmodSync(LOG_FILE, 0o600); } catch {}
    } else {
      const fd = fs.openSync(LOG_FILE, fs.constants.O_CREAT | fs.constants.O_WRONLY, 0o600);
      fs.closeSync(fd);
    }
  } catch {}
}

// Cache branch detection per process (hooks are short-lived, branch won't change)
let _branch;
function getBranch() {
  if (_branch !== undefined) return _branch;
  try {
    _branch = execSync('git branch --show-current 2>/dev/null', {
      encoding: 'utf8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || null;
  } catch {
    _branch = null;
  }
  return _branch;
}

/**
 * Log a hook error to file (or stderr when ENFORCE_HOOK_DEBUG=1).
 *
 * @param {string} sourceFile - Pass __filename
 * @param {Error|string} err - The caught error
 * @param {object} [context] - Optional session context
 * @param {string} [context.tool] - Tool name (e.g. "Edit", "Bash", "Task")
 * @param {object} [context.input] - Tool input (file_path, command, etc.)
 */
function logHookError(sourceFile, err, context) {
  secureLogFile();
  const name = path.basename(sourceFile);
  const message = err?.message || String(err);
  const timestamp = new Date().toISOString();
  const pid = process.pid;
  const cwd = process.cwd();
  const branch = getBranch();

  // Build context: process.pid identifies this specific hook invocation (not the parent Claude process)
  const parts = [`pid=${pid}`];
  if (branch) parts.push(`branch=${branch}`);
  parts.push(`cwd=${cwd}`);
  if (context?.tool) parts.push(`tool=${context.tool}`);
  if (context?.input?.file_path) parts.push(`file=${context.input.file_path}`);
  if (context?.input?.command) {
    // Truncate long commands to keep line under PIPE_BUF
    const cmd = context.input.command.length > 200
      ? context.input.command.slice(0, 200) + '...'
      : context.input.command;
    parts.push(`cmd=${cmd}`);
  }
  if (context?.input?.skill) parts.push(`skill=${context.input.skill}`);
  if (context?.input?.subagent_type) parts.push(`agent=${context.input.subagent_type}`);

  const ctx = parts.join(' ');
  // Raw line before sanitization — may contain newlines or exceed PIPE_BUF
  const line = `[${timestamp}] ${name} | ${ctx} | ${message}`;

  if (process.env.ENFORCE_HOOK_DEBUG) {
    // In debug mode, also include first line of stack trace
    const stack = err?.stack?.split('\n')[1]?.trim() || '';
    process.stderr.write(`[${name}] ${ctx} | ${message}${stack ? '\n  ' + stack : ''}\n`);
    return;
  }

  try {
    // Auto-rotate: truncate if file is too large (best-effort, race-tolerant)
    try {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > MAX_LOG_SIZE) {
        fs.writeFileSync(LOG_FILE, `[${timestamp}] --- log rotated (was ${stat.size} bytes) ---\n`);
      }
    } catch {
      // File doesn't exist yet or stat failed — fine, appendFileSync will create it
    }

    // Sanitize: flatten to single line and truncate to stay under ~4KB (PIPE_BUF) for atomic O_APPEND writes
    const MAX_BYTES = 3800;
    const safeLine = line.replace(/\n/g, ' ').replace(/\r/g, '');
    let finalLine = safeLine + '\n';
    if (Buffer.byteLength(finalLine, 'utf8') > MAX_BYTES) {
      // Truncate by slicing characters until under byte limit
      let truncated = safeLine;
      while (Buffer.byteLength(truncated + '...\n', 'utf8') > MAX_BYTES && truncated.length > 0) {
        truncated = truncated.slice(0, -100);
      }
      finalLine = truncated + '...\n';
    }

    // O_APPEND + short line = effectively atomic on Linux ext4/xfs (no interleaving between processes)
    fs.appendFileSync(LOG_FILE, finalLine);
  } catch {
    // Can't log — silently discard. Never write to stderr.
  }
}

/** @see lib/__tests__/hook-error-log.test.js for unit tests covering rotation, symlink guard, and truncation */
module.exports = { logHookError, LOG_FILE };
