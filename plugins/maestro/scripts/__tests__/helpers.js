// Shared test harness for the maestro session-detection suites (Task 1, GH-429).
//
// Provides `runScript()`, which executes a bash script with the fixture stub
// directory (containing fake `tmux` / `node` / `git` binaries) placed first on
// PATH, captures stdout/stderr/status, and surfaces the recorded
// `tmux new-session` invocations via `newSessionCalls`.
//
// No bats: tests are plain `node:test` + `node:assert/strict` per repo
// convention. The fixtures are configured purely through environment
// variables (see each stub's header for the supported knobs).
'use strict';

const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

/** Absolute path to the directory holding the fake tmux/node/git stubs. */
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

/**
 * Ensure the fixture stub files are executable. They are checked in with the
 * executable bit, but a fresh checkout / clone on some filesystems can drop
 * it, so we defensively chmod them once per process.
 */
let _ensuredExec = false;
function ensureFixturesExecutable() {
  if (_ensuredExec) return;
  for (const name of ['tmux', 'node', 'git']) {
    const p = path.join(FIXTURES_DIR, name);
    try {
      fs.chmodSync(p, 0o755);
    } catch {
      // Best-effort: a missing stub will surface as a test failure elsewhere.
    }
  }
  _ensuredExec = true;
}

/**
 * Read the tmux capture log and return one entry per recorded mutating call.
 * @param {string} logPath
 * @returns {string[]}
 */
function readCaptureLog(logPath) {
  let raw;
  try {
    raw = fs.readFileSync(logPath, 'utf8');
  } catch {
    return [];
  }
  return raw.split('\n').filter((line) => line.trim().length > 0);
}

/**
 * @typedef {Object} RunScriptOptions
 * @property {Record<string,string>} [env]  Extra env vars layered over process.env.
 * @property {string} [fakeBin]  Override fixtures dir (defaults to ./fixtures).
 * @property {string[]} [args]  Positional args passed to the script.
 * @property {number} [timeout]  spawnSync timeout in ms (default 15000).
 */

/**
 * @typedef {Object} RunScriptResult
 * @property {string} stdout
 * @property {string} stderr
 * @property {number|null} status
 * @property {string[]} newSessionCalls  Full argv of each `tmux new-session` call.
 * @property {string[]} killSessionCalls Full argv of each `tmux kill-session` call.
 * @property {string[]} tmuxCalls        All recorded mutating tmux calls.
 */

/**
 * Run a bash script with the fake stub dir first on PATH and capture output.
 *
 * @param {string} scriptPath  Absolute path to the bash script to run.
 * @param {RunScriptOptions} [options]
 * @returns {RunScriptResult}
 */
function runScript(scriptPath, options = {}) {
  ensureFixturesExecutable();

  const fakeBin = options.fakeBin || FIXTURES_DIR;
  const args = options.args || [];
  const timeout = options.timeout || 15000;

  // Per-run capture log so concurrent/sequential runs don't bleed into each
  // other. Lives in a unique temp dir.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-run-'));
  const captureLog = path.join(tmpDir, 'tmux-calls.log');

  const env = {
    ...process.env,
    ...(options.env || {}),
    // Fixture dir first so the stubs shadow real binaries.
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
    FAKE_TMUX_CAPTURE_LOG: captureLog,
  };

  const result = spawnSync('bash', [scriptPath, ...args], {
    encoding: 'utf8',
    env,
    timeout,
  });

  const tmuxCalls = readCaptureLog(captureLog);
  const newSessionCalls = tmuxCalls.filter((c) => /\bnew-session\b/.test(c));
  const killSessionCalls = tmuxCalls.filter((c) => /\bkill-session\b/.test(c));

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
    newSessionCalls,
    killSessionCalls,
    tmuxCalls,
  };
}

module.exports = { runScript, FIXTURES_DIR, readCaptureLog };
