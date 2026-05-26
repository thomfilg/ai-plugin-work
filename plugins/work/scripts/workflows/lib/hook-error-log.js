/**
 * hook-error-log.js
 *
 * Logs hook errors to a file instead of stderr, preventing false
 * "hook error" noise in Claude Code (which treats any stderr as an error).
 *
 * When ENFORCE_HOOK_DEBUG=1: writes to stderr (for interactive debugging)
 * Otherwise: appends to /tmp/claude-hook-errors.log (silent, reviewable later)
 *
 * TOCTOU-safe: opens the log file ONCE via file descriptor with O_CREAT |
 * O_APPEND | O_WRONLY and mode 0o600. All subsequent writes use the fd
 * directly — no path-based reopens after the initial open.
 *
 * Auto-rotates: truncates via fd when file exceeds MAX_LOG_SIZE (1MB).
 *
 * Usage (basic -- error message only):
 *   const { logHookError } = require('./hook-error-log');
 *   main().catch(err => { logHookError(__filename, err); process.exit(0); });
 *
 * Usage (with session context -- for richer debugging):
 *   main().catch(err => {
 *     logHookError(__filename, err, { tool: hookData.tool_name, input: hookData.tool_input });
 *     process.exit(0);
 *   });
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Default log path -- overridable via HOOK_ERROR_LOG env var.
// File is created with 0o600 permissions (owner-only read/write) to mitigate /tmp security risks.
const LOG_FILE = process.env.HOOK_ERROR_LOG || '/tmp/claude-hook-errors.log';
const MAX_LOG_SIZE = 1024 * 1024; // 1MB cap before auto-rotation

// File descriptor for the log file -- opened once, reused for all writes.
// Using an fd eliminates TOCTOU races: no path-based reopens after initial open.
let _logFd = null;

/**
 * Open the log file once and return the fd. Subsequent calls return the cached fd.
 * Returns -1 sentinel if the open failed (caller should silently discard).
 */
function getLogFd() {
  if (_logFd !== null) return _logFd;
  try {
    // O_APPEND ensures atomic-ish writes; 0o600 = owner-only permissions
    // Opening by fd avoids TOCTOU -- no path-based reopens after this point
    const flags = fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY;

    // Guard against symlink attacks before opening: lstatSync checks the link
    // itself (not its target), so a malicious symlink is detected and removed.
    if (fs.existsSync(LOG_FILE)) {
      const stat = fs.lstatSync(LOG_FILE);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(LOG_FILE);
      }
    }

    _logFd = fs.openSync(LOG_FILE, flags, 0o600);
  } catch {
    _logFd = -1; // sentinel: open failed, don't retry on subsequent calls
  }
  return _logFd;
}

// Cache branch detection per process (hooks are short-lived, branch won't change mid-run)
let _branch;
function getBranch() {
  if (_branch !== undefined) return _branch;
  try {
    _branch =
      execSync('git branch --show-current 2>/dev/null', {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['pipe', 'pipe', 'pipe'],
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
 * @param {object} [context] - Optional session context for richer debugging
 * @param {string} [context.tool] - Tool name (e.g. "Edit", "Bash", "Task")
 * @param {object} [context.input] - Tool input (file_path, command, etc.)
 */
function logHookError(sourceFile, err, context) {
  const name = path.basename(sourceFile);
  const message = err?.message || String(err);
  const timestamp = new Date().toISOString();
  const pid = process.pid;
  const cwd = process.cwd();
  const branch = getBranch();

  // Build structured context: pid identifies this specific hook invocation
  const parts = [`pid=${pid}`];
  if (branch) parts.push(`branch=${branch}`);
  parts.push(`cwd=${cwd}`);
  if (context?.tool) parts.push(`tool=${context.tool}`);
  if (context?.input?.file_path) parts.push(`file=${context.input.file_path}`);
  if (context?.input?.command) {
    // Truncate long commands to keep the line under PIPE_BUF for atomic writes
    const cmd =
      context.input.command.length > 200
        ? context.input.command.slice(0, 200) + '...'
        : context.input.command;
    parts.push(`cmd=${cmd}`);
  }
  if (context?.input?.skill) parts.push(`skill=${context.input.skill}`);
  if (context?.input?.subagent_type) parts.push(`agent=${context.input.subagent_type}`);

  const ctx = parts.join(' ');
  // Raw line before sanitization -- may contain newlines or exceed PIPE_BUF limit
  const line = `[${timestamp}] ${name} | ${ctx} | ${message}`;

  if (process.env.ENFORCE_HOOK_DEBUG) {
    // In debug mode, write to stderr with optional stack trace for visibility
    const stack = err?.stack?.split('\n')[1]?.trim() || '';
    process.stderr.write(`[${name}] ${ctx} | ${message}${stack ? '\n  ' + stack : ''}\n`);
    return;
  }

  const fd = getLogFd();
  if (fd <= 0) return; // can't log -- fd open failed, silently discard

  try {
    // Auto-rotate: check size via fstatSync on the fd (no path-based reopen needed)
    const stat = fs.fstatSync(fd);
    if (stat.size > MAX_LOG_SIZE) {
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, `[${timestamp}] --- log rotated ---\n`);
    }

    // Sanitize: flatten to single line and truncate to stay under ~4KB (PIPE_BUF)
    const MAX_BYTES = 3800;
    const safeLine = line.replace(/\n/g, ' ').replace(/\r/g, '');
    let finalLine = safeLine + '\n';
    if (Buffer.byteLength(finalLine, 'utf8') > MAX_BYTES) {
      // Truncate by slicing characters in chunks until under byte limit
      let truncated = safeLine;
      while (Buffer.byteLength(truncated + '...\n', 'utf8') > MAX_BYTES && truncated.length > 0) {
        truncated = truncated.slice(0, -100);
      }
      finalLine = truncated + '...\n';
    }

    // Write via fd -- O_APPEND + short line = effectively atomic on Linux ext4/xfs
    fs.writeSync(fd, finalLine);
  } catch {
    // Can't log -- silently discard. Never write to stderr from hooks.
  }
}

/** @see lib/__tests__/hook-error-log.test.js for tests covering fd-based writes, rotation, symlink guard, and truncation */
module.exports = { logHookError, LOG_FILE };
