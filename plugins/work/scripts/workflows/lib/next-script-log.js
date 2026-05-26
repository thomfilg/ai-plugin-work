/**
 * next-script-log.js
 *
 * Append-only JSONL invocation log for the self-paced "next" runners
 * (task-next.js, brief-next.js) and for write-token mint/consume events
 * in the hook. One line per event, written synchronously so partial
 * state survives crashes.
 *
 * Logs live under `~/.claude/work-workflow/logs/`:
 *   - next-scripts.jsonl   — every task-next/brief-next invocation
 *   - write-token.jsonl    — every token mint and consume attempt
 *
 * Set `NEXT_SCRIPT_LOG_DIR=/path` to override the directory.
 * Set `NEXT_SCRIPT_LOG=0` to disable logging entirely.
 *
 * Pure module. No deps beyond `node:fs`/`node:path`/`node:os`.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_DIR = path.join(os.homedir(), '.claude', 'work-workflow', 'logs');

function logsEnabled() {
  return process.env.NEXT_SCRIPT_LOG !== '0';
}

function logDir() {
  return process.env.NEXT_SCRIPT_LOG_DIR || DEFAULT_DIR;
}

function logPath(basename) {
  return path.join(logDir(), basename);
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  } catch {
    /* fail-open */
  }
}

/**
 * Append a JSON record as one line. Synchronous, best-effort, never throws.
 *
 * @param {string} file - log basename, e.g. 'next-scripts.jsonl'
 * @param {object} record - serializable object (ts will be auto-added)
 */
function append(file, record) {
  if (!logsEnabled()) return;
  try {
    const dir = logDir();
    ensureDir(dir);
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        pid: process.pid,
        ppid: process.ppid,
        ...record,
      }) + '\n';
    fs.appendFileSync(path.join(dir, file), line, { mode: 0o644 });
  } catch {
    /* fail-open — telemetry must never break the workflow */
  }
}

/**
 * Convenience wrapper for next-script invocations.
 */
function logNextScriptEvent(script, payload) {
  append('next-scripts.jsonl', { script, ...payload });
}

/**
 * Convenience wrapper for write-token events.
 */
function logTokenEvent(event, payload) {
  append('write-token.jsonl', { event, ...payload });
}

module.exports = {
  append,
  logNextScriptEvent,
  logTokenEvent,
  logPath,
  logDir,
};
