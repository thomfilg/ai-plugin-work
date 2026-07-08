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
function truncateCommand(cmd) {
  return cmd.length > 200 ? cmd.slice(0, 200) + '...' : cmd;
}

const INPUT_FIELD_MAP = [
  ['file_path', 'file', (v) => v],
  ['command', 'cmd', truncateCommand],
  ['skill', 'skill', (v) => v],
  ['subagent_type', 'agent', (v) => v],
];

function buildInputParts(input) {
  const parts = [];
  if (!input) return parts;
  for (const [key, label, transform] of INPUT_FIELD_MAP) {
    if (input[key]) parts.push(`${label}=${transform(input[key])}`);
  }
  return parts;
}

function buildContextParts(context) {
  const parts = [`pid=${process.pid}`];
  const branch = getBranch();
  if (branch) parts.push(`branch=${branch}`);
  parts.push(`cwd=${process.cwd()}`);
  if (context?.tool) parts.push(`tool=${context.tool}`);
  parts.push(...buildInputParts(context?.input));
  return parts;
}

function sanitizeLine(line) {
  const MAX_BYTES = 3800;
  const safeLine = line.replace(/\n/g, ' ').replace(/\r/g, '');
  let finalLine = safeLine + '\n';
  if (Buffer.byteLength(finalLine, 'utf8') > MAX_BYTES) {
    let truncated = safeLine;
    while (Buffer.byteLength(truncated + '...\n', 'utf8') > MAX_BYTES && truncated.length > 0) {
      truncated = truncated.slice(0, -100);
    }
    finalLine = truncated + '...\n';
  }
  return finalLine;
}

function writeLogLine(fd, line, timestamp) {
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size > MAX_LOG_SIZE) {
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, `[${timestamp}] --- log rotated ---\n`);
    }
    fs.writeSync(fd, sanitizeLine(line));
  } catch {
    // Can't log -- silently discard. Never write to stderr from hooks.
  }
}

function logHookError(sourceFile, err, context) {
  const name = path.basename(sourceFile);
  const message = err?.message || String(err);
  const timestamp = new Date().toISOString();
  const ctx = buildContextParts(context).join(' ');
  const line = `[${timestamp}] ${name} | ${ctx} | ${message}`;

  if (process.env.ENFORCE_HOOK_DEBUG) {
    const stack = err?.stack?.split('\n')[1]?.trim() || '';
    process.stderr.write(`[${name}] ${ctx} | ${message}${stack ? '\n  ' + stack : ''}\n`);
    return;
  }

  const fd = getLogFd();
  if (fd <= 0) return;
  writeLogLine(fd, line, timestamp);
}

/** @see lib/__tests__/hook-error-log.test.js for tests covering fd-based writes, rotation, symlink guard, and truncation */
module.exports = { logHookError, LOG_FILE };
