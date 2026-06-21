/**
 * gh-exec.js — Shared gh CLI wrapper
 *
 * Executes `gh` commands via execFileSync with JSON parsing,
 * error handling, and optional non-zero exit tolerance.
 *
 * Auth diagnostic: when `gh` exits non-zero with an auth-shaped stderr
 * (matched by AUTH_ERROR_REGEX), `ghExec` spawns `gh auth status` with a
 * scrubbed env (no GH_TOKEN/GITHUB_TOKEN) and appends a diagnostic block to
 * the thrown Error.message listing the active gh account, other configured
 * accounts, the `gh auth switch --user <other>` hint, and a reminder to
 * unset GH_TOKEN/GITHUB_TOKEN. Set `GH_EXEC_NO_DIAG=1` (strict string match)
 * to opt out and restore today's raw-error behavior.
 */
const { execFileSync } = require('child_process');

const AUTH_ERROR_REGEX =
  /Could not resolve to a Repository|Resource not accessible|HTTP 40[134]|requires authentication/i;

function buildChildEnv() {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}

function looksLikeAuthFailure(stderrText) {
  if (!stderrText) return false;
  return AUTH_ERROR_REGEX.test(stderrText);
}

/**
 * Parse `gh auth status` stdout/stderr into `{ active, others }`.
 * Only extracts account names — never echoes raw output.
 */
function parseGhAuthStatusOutput(text) {
  if (!text || typeof text !== 'string') return null;
  const lines = text.split('\n');
  const accounts = [];
  let active = null;
  let lastAccount = null;
  for (const raw of lines) {
    const line = raw.trim();
    const acctMatch = line.match(/Logged in to [^\s]+ account ([A-Za-z0-9_.-]+)/);
    if (acctMatch) {
      lastAccount = acctMatch[1];
      accounts.push(lastAccount);
      continue;
    }
    const activeMatch = line.match(/Active account:\s*(true|false)/i);
    if (activeMatch && lastAccount && activeMatch[1].toLowerCase() === 'true') {
      active = lastAccount;
    }
  }
  if (!active && accounts.length > 0) active = accounts[0];
  if (!active) return null;
  const others = accounts.filter((a) => a !== active);
  return { active, others };
}

function runGhAuthStatus() {
  try {
    let stdout = '';
    let stderr = '';
    try {
      stdout = execFileSync('gh', ['auth', 'status'], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
        env: buildChildEnv(),
      });
    } catch (err) {
      // gh auth status often prints to stderr even on success; capture both.
      stdout = err.stdout ? err.stdout.toString() : '';
      stderr = err.stderr ? err.stderr.toString() : '';
      if (!stdout && !stderr) return null;
    }
    const combined = `${stdout}\n${stderr}`;
    return parseGhAuthStatusOutput(combined);
  } catch {
    return null;
  }
}

function buildAuthDiagnostic(parsed) {
  if (!parsed) {
    return '\n↳ Likely auth issue. Run `gh auth status` to inspect active account.';
  }
  const lines = [];
  lines.push('');
  lines.push('↳ Likely auth issue.');
  lines.push(`   Active gh account: ${parsed.active}`);
  if (parsed.others && parsed.others.length > 0) {
    lines.push(`   Other configured accounts: ${parsed.others.join(', ')}`);
    for (const other of parsed.others) {
      lines.push(`   Try: gh auth switch --user ${other}`);
    }
  }
  lines.push(
    '   If GH_TOKEN or GITHUB_TOKEN is set in your env, unset them so gh uses the keyring.'
  );
  return lines.join('\n');
}

/**
 * Execute a gh CLI command synchronously.
 *
 * On non-zero exits whose stderr matches AUTH_ERROR_REGEX, appends an auth
 * diagnostic block (active account + switch hints) to the thrown Error.message.
 * Set `GH_EXEC_NO_DIAG=1` (strict) to suppress the diagnostic and restore
 * today's raw-error behavior.
 *
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
      timeout: 60000,
      env: buildChildEnv(),
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
    const baseMessage = `gh command failed: gh ${args.join(' ')}\n${stderr}`;
    if (process.env.GH_EXEC_NO_DIAG === '1') {
      throw new Error(baseMessage);
    }
    if (!looksLikeAuthFailure(stderr)) {
      throw new Error(baseMessage);
    }
    const parsed = runGhAuthStatus();
    throw new Error(baseMessage + buildAuthDiagnostic(parsed));
  }
}

module.exports = { ghExec, buildChildEnv };
