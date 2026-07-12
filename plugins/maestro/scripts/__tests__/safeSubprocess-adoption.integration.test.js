// safeSubprocess-adoption.integration.test.js — Task 5 (GH-690)
//
// Verifies that maestro's production subprocess call sites have been migrated
// onto the vendored safeSubprocess wrappers (plugins/maestro/lib/safeSubprocess).
//
// The migration is behavior-preserving: each caller keeps its exact success
// predicate over the raw result object; the ONLY intended delta is the enforced
// default timeout (15000 ms) applied when a call site set no timeout. Genuinely
// long-running sites (none, here — all maestro sites are best-effort quick
// probes) would carry an explicit non-empty `noTimeout` justification string.
//
// Strategy: we intercept `node:child_process.spawnSync` in a spawned child of
// the real maestro-cleanup.js script (via a NODE_OPTIONS --require preload
// shim) so we observe the exact options object that reaches child_process
// AFTER the wrapper has applied its policy. This tests real end-to-end
// behavior, not source text, and survives refactoring of the call sites.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const MAESTRO_SCRIPTS = path.join(REPO_ROOT, 'plugins', 'maestro', 'scripts');
const CLEANUP = path.join(MAESTRO_SCRIPTS, 'maestro-cleanup.js');
const SIGNAL = path.join(MAESTRO_SCRIPTS, 'maestro-signal.js');
const VENDOR_DIR = path.join(REPO_ROOT, 'plugins', 'maestro', 'lib', 'safeSubprocess');

// R10: subprocess-spawning tests must pin TASKS_BASE and BASE_BRANCH in the
// child env — config.js re-derives them from the git toplevel when unset,
// which fails on CI (shallow clone / detached HEAD). Pin them here.
const CHILD_ENV_PINS = {
  TASKS_BASE: process.env.TASKS_BASE || path.join(REPO_ROOT, 'tasks'),
  BASE_BRANCH: process.env.BASE_BRANCH || 'main',
};

const PRODUCTION_CALL_SITE_FILES = [CLEANUP, SIGNAL];

/**
 * Build a preload shim that intercepts `node:child_process.spawnSync`, records
 * every (command, args, options) triple to `outFile`, and short-circuits the
 * real spawn with a canned success result so the test never depends on tmux /
 * lsof being installed. The shim is applied via NODE_OPTIONS=--require.
 */
function writeSpawnSyncShim(dir, outFile) {
  const shim = path.join(dir, 'spawnsync-shim.js');
  const src = `
'use strict';
const fs = require('fs');
const cp = require('node:child_process');
const realSpawnSync = cp.spawnSync;
cp.spawnSync = function (command, args, options) {
  try {
    const rec = { command, args, options: options || {} };
    fs.appendFileSync(${JSON.stringify(outFile)}, JSON.stringify(rec) + '\\n');
  } catch {}
  // Canned success so callers that check r.status === 0 see a "killed" session.
  return { status: 0, stdout: '', stderr: '', signal: null, error: null };
};
`;
  fs.writeFileSync(shim, src);
  return shim;
}

function runScriptWithShim(scriptPath, argv, tmpDir) {
  const outFile = path.join(tmpDir, 'spawn-calls.ndjson');
  fs.writeFileSync(outFile, '');
  const shim = writeSpawnSyncShim(tmpDir, outFile);
  const res = spawnSync(process.execPath, [scriptPath, ...argv], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ...CHILD_ENV_PINS,
      STATE_DIR: path.join(tmpDir, 'state'),
      MAESTRO_INBOX_DIR: path.join(tmpDir, 'inbox'),
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${shim}`.trim(),
    },
  });
  const calls = fs
    .readFileSync(outFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return { res, calls };
}

test('vendored safeSubprocess module is available to maestro call sites', () => {
  const mod = require(VENDOR_DIR);
  assert.equal(typeof mod.safeSpawnSync, 'function', 'safeSpawnSync export missing');
  assert.equal(typeof mod.safeExecFileSync, 'function', 'safeExecFileSync export missing');
});

test('production call-site files no longer destructure raw spawnSync/execFileSync/execSync from child_process', () => {
  for (const file of PRODUCTION_CALL_SITE_FILES) {
    const src = fs.readFileSync(file, 'utf8');
    // The migrated file must import the vendored wrapper.
    assert.match(
      src,
      /require\(['"][^'"]*lib\/safeSubprocess['"]\)/,
      `${path.basename(file)} must require the vendored safeSubprocess wrapper`
    );
    // And must NOT keep a raw child_process spawnSync/execFileSync/execSync import.
    assert.doesNotMatch(
      src,
      /require\(['"](?:node:)?child_process['"]\)/,
      `${path.basename(file)} must not import raw child_process directly after migration`
    );
  }
});

test('maestro-cleanup tmux kill-session applies the enforced default timeout when the call site set none', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-adopt-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const { res, calls } = runScriptWithShim(CLEANUP, ['GH-999', '--tmux'], tmpDir);
  assert.equal(res.status, 0, `maestro-cleanup exited nonzero: ${res.stderr}`);

  const tmuxKill = calls.find(
    (c) => c.command === 'tmux' && Array.isArray(c.args) && c.args[0] === 'kill-session'
  );
  assert.ok(tmuxKill, 'expected a tmux kill-session spawnSync call to be recorded');
  // Enforced default: the wrapper injects timeout: 15000 for a site with no timeout.
  assert.equal(
    tmuxKill.options.timeout,
    15000,
    'enforced default timeout (15000 ms) must be applied when the call site set none'
  );
  // The wrapper always forces shell: false.
  assert.equal(tmuxKill.options.shell, false, 'wrapper must force shell: false');
});

test('migrated call site preserves its success predicate (status === 0 counts a killed session)', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-adopt-pred-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // The shim returns { status: 0 } for every tmux kill; killTmux counts each
  // status===0 as a killed session. With --tmux on a ticket, cleanup prints
  // "killed N tmux session(s)" — the predicate must survive the migration.
  const { res } = runScriptWithShim(CLEANUP, ['GH-999', '--tmux'], tmpDir);
  assert.equal(res.status, 0, `maestro-cleanup exited nonzero: ${res.stderr}`);
  assert.match(
    res.stdout,
    /killed 2 tmux session\(s\)/,
    'status===0 success predicate must be preserved (2 sessions: work + listen)'
  );
});

test('maestro-signal tmux/lsof probes preserve their explicit timeout through the wrapper', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-adopt-sig-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const { res, calls } = runScriptWithShim(SIGNAL, ['GH999', 'hello world'], tmpDir);
  assert.equal(res.status, 0, `maestro-signal exited nonzero: ${res.stderr}`);

  // maestro-signal's lsof + tmux probes set an explicit timeout: 2000; the
  // wrapper must use a caller-supplied positive timeout as-is (no override).
  const probeCalls = calls.filter((c) => c.command === 'tmux' || c.command === 'lsof');
  assert.ok(probeCalls.length >= 1, 'expected at least one lsof/tmux probe call recorded');
  for (const c of probeCalls) {
    assert.equal(
      c.options.timeout,
      2000,
      `${c.command} probe must keep its explicit 2000 ms timeout, not the default`
    );
    assert.equal(c.options.shell, false, `${c.command} probe must run with shell: false`);
  }
});

test('any noTimeout justification present in a migrated call site is a non-empty string', () => {
  // No maestro site is genuinely long-running, so migrated files should not
  // carry a noTimeout at all — but if one does, its justification must be a
  // non-empty string literal (R9 behavior-preservation evidence).
  const NOTIMEOUT_RE = /noTimeout\s*:\s*(['"])((?:(?!\1).)*)\1/g;
  for (const file of PRODUCTION_CALL_SITE_FILES) {
    const src = fs.readFileSync(file, 'utf8');
    let m;
    while ((m = NOTIMEOUT_RE.exec(src)) !== null) {
      assert.ok(
        m[2].trim().length > 0,
        `${path.basename(file)}: noTimeout justification must be a non-empty string`
      );
    }
    // A bare `noTimeout: true` / `noTimeout,` shorthand is never acceptable.
    assert.doesNotMatch(
      src,
      /noTimeout\s*:\s*(?:true|false|\d|null|undefined)/,
      `${path.basename(file)}: noTimeout must be a justification string, never a boolean/number`
    );
  }
});
