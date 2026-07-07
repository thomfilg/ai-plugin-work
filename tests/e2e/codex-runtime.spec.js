'use strict';

/**
 * codex-runtime.spec.js — thin `node --test` wrapper around the live codex
 * smoke suite (scripts/codex-smoke.sh, WP-12).
 *
 * The smoke needs a real codex binary AND a logged-in auth.json, so in CI (or
 * any machine without them) every test here SKIPS cleanly — this file must
 * never be the reason a offline run goes red. To force the live run locally:
 *
 *   CODEX_SMOKE_LIVE=1 node --test tests/e2e/codex-runtime.spec.js
 *
 * Without CODEX_SMOKE_LIVE=1 the spec only asserts the script's static
 * contract (exists, executable-parseable, declares its scenarios) so the
 * deliverable cannot silently rot.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SMOKE = path.join(REPO_ROOT, 'scripts', 'codex-smoke.sh');

function codexAvailable() {
  const which = spawnSync('sh', ['-c', 'command -v "${CODEX_BIN:-codex}"'], { encoding: 'utf8' });
  return which.status === 0 && which.stdout.trim() !== '';
}

function authAvailable() {
  const auth = process.env.CODEX_AUTH_FILE || path.join(os.homedir(), '.codex', 'auth.json');
  try {
    fs.accessSync(auth, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

describe('codex smoke script static contract (always runs)', () => {
  it('script exists and parses (bash -n)', () => {
    assert.ok(fs.existsSync(SMOKE), `${SMOKE} missing`);
    const res = spawnSync('bash', ['-n', SMOKE], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
  });

  it('script encodes the verified resume form and the /tmp lock-lane caveat', () => {
    const body = fs.readFileSync(SMOKE, 'utf8');
    // C3 RESOLVED form: positional SESSION_ID + positional PROMPT, sandbox via -c.
    assert.match(body, /exec resume "\$SESSION_ID"/);
    assert.match(body, /sandbox_mode="workspace-write"/);
    assert.match(body, /cwd-filtered/i);
    // heimdall lock lane exempts /tmp — the script must document why it only
    // smokes the conceal lane from a /tmp workspace.
    assert.match(body, /TEMP_PREFIXES|exempts \/tmp/i);
    // Never wire into CI / needs live auth.
    assert.match(body, /NOT wired into CI/);
  });
});

describe('live codex smoke (opt-in: CODEX_SMOKE_LIVE=1 + codex + auth)', () => {
  const wanted = process.env.CODEX_SMOKE_LIVE === '1';
  const runnable = wanted && codexAvailable() && authAvailable();
  const skipReason = !wanted
    ? 'set CODEX_SMOKE_LIVE=1 to run the live smoke'
    : !codexAvailable()
      ? 'codex binary not on PATH'
      : 'no readable auth.json (CODEX_AUTH_FILE or ~/.codex/auth.json)';

  it('scripts/codex-smoke.sh exits 0 end-to-end', { skip: runnable ? false : skipReason }, () => {
    const res = spawnSync('bash', [SMOKE], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      timeout: 15 * 60 * 1000,
    });
    // Exit 3 = environment prerequisites vanished mid-run — treat as failure
    // here because we pre-checked them above.
    assert.equal(res.status, 0, `smoke failed:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /RESULT: all scenario checks passed/);
  });
});
