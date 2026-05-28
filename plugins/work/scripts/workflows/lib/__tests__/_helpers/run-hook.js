/**
 * Shared test helper for spawning hook subprocesses with a deterministic env.
 *
 * Why this exists
 * ---------------
 * Hook scripts spawned with `child_process.spawn` inherit the parent process's
 * env by default. On developer machines, `.envrc` typically exports config
 * vars like TASKS_BASE, WORKTREES_BASE, REPO_NAME, TICKET_PROVIDER, etc. The
 * shared config loader (`scripts/workflows/lib/config.js`) prefers
 * `process.env.TASKS_BASE` over its derivation from `WORKTREES_BASE`, so when
 * a test passes `{ WORKTREES_BASE: TEMP_WB }` expecting the hook to read its
 * state from `TEMP_WB/tasks`, the inherited `TASKS_BASE` from the developer
 * shell silently wins instead. The hook then looks at the wrong directory and
 * the test flakes / fails depending on which developer ran it.
 *
 * Fix: tests use `buildHookEnv()` to construct the subprocess env. The helper
 * starts from a small allow-list of vars that subprocess needs to actually
 * run (PATH, HOME, NODE_*, etc.), then layers `extraEnv` on top. This way:
 *
 *   - Tests that explicitly set a config var get exactly that value.
 *   - Tests that don't set it get the hook's own default-derivation behavior.
 *   - The developer's `.envrc` never leaks into the subprocess.
 *
 * Allow-listing (not deny-listing) is the right shape here: there's a small,
 * known set of vars subprocesses need; the universe of config vars that COULD
 * leak from `.envrc` is open-ended. New `.envrc` entries should not silently
 * affect the test harness.
 */

'use strict';

const { spawn } = require('child_process');

// Env vars the Node subprocess legitimately needs to run, regardless of test.
// Intentionally excludes ALL workflow-config vars (TASKS_BASE, WORKTREES_BASE,
// REPO_NAME, TICKET_PROVIDER, WORK_TICKET_ID, JIRA_*, GH_*, WEB_APPS, etc.) so
// tests are forced to declare the config they actually depend on.
const PASSTHROUGH_PREFIXES = ['NODE_', 'npm_', 'NPM_'];
const PASSTHROUGH_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'PWD',
  'TERM',
  // CI marker — some hooks tweak output (no colors etc.) when set.
  'CI',
  // Allow tests to opt-in to Claude session scoping via extraEnv; if not set
  // in extraEnv we deliberately do NOT inherit the developer's session id.
]);

function isPassthrough(key) {
  if (PASSTHROUGH_KEYS.has(key)) return true;
  for (const prefix of PASSTHROUGH_PREFIXES) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Build a deterministic subprocess env for a hook spawn.
 *
 * @param {Record<string,string>} extraEnv  Test-specific env overrides. These
 *   ALWAYS win over the passthrough base.
 * @param {object} [opts]
 * @param {string[]} [opts.preserveExtra]  Additional parent-env keys to keep
 *   (e.g. a test that legitimately wants to inherit the parent's TASKS_BASE).
 *   Use sparingly — prefer setting the value explicitly in `extraEnv`.
 * @returns {Record<string,string>}
 */
function buildHookEnv(extraEnv = {}, opts = {}) {
  const preserveExtra = new Set(opts.preserveExtra || []);
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (isPassthrough(key) || preserveExtra.has(key)) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    // Allow tests to explicitly UN-set an inherited var by passing `undefined`
    // or empty string. Empty string is preserved (some hooks distinguish "set
    // to empty" from "unset"); only `undefined` deletes.
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Spawn a hook script with stdin JSON input and capture exit code + streams.
 *
 * @param {string} hookPath        Absolute path to the hook .js file.
 * @param {unknown} hookData       Object written to the subprocess stdin as JSON.
 * @param {Record<string,string>} extraEnv  Env overrides (see buildHookEnv).
 * @param {object} [opts]
 * @param {string[]} [opts.args]   Extra argv passed after the hook path.
 * @param {string[]} [opts.preserveExtra]  Forwarded to buildHookEnv.
 * @param {string} [opts.cwd]      Subprocess working directory.
 * @returns {Promise<{code:number|null, stdout:string, stderr:string}>}
 */
function spawnHook(hookPath, hookData, extraEnv = {}, opts = {}) {
  const env = buildHookEnv(extraEnv, opts);
  const args = [hookPath, ...(opts.args || [])];
  return new Promise((resolve, reject) => {
    const proc = spawn('node', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: opts.cwd,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.on('error', reject);
    if (hookData !== undefined && hookData !== null) {
      proc.stdin.write(typeof hookData === 'string' ? hookData : JSON.stringify(hookData));
    }
    proc.stdin.end();
  });
}

module.exports = { buildHookEnv, spawnHook };
