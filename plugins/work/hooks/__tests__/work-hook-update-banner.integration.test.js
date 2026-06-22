/**
 * Spawned-hook integration tests for the update-check banner wiring (GH-314, Task 2).
 *
 * These drive the REAL work-hook.js process via child_process.spawn (mirroring
 * work-hook-injection.test.js) for a "/work GH-1" prompt and assert that the
 * update banner is prepended to the orchestrator plan without ever blocking the
 * plan or changing the exit code:
 *
 *   - update-available source  → stdout contains the banner AND the plan section, exit 0
 *   - unreachable/erroring src  → stdout contains the plan section, NO banner, exit 0
 *
 * The test supplies the version source to the hook through env-var injection
 * seams (no real network):
 *   WORK_UPDATE_CHECK_TEST_LATEST=<X.Y.Z>  → inject a fetch shim resolving to that version
 *   WORK_UPDATE_CHECK_TEST_FAIL=1          → inject a fetch shim that throws (offline)
 *
 * Run with: node --test hooks/__tests__/work-hook-update-banner.integration.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HOOK_PATH = path.join(__dirname, '..', 'work-hook.js');

// Stable substrings.
const PLAN_MARKER = 'WORK2 ORCHESTRATOR PLAN';
const BANNER_MARKER = 'new version of work-workflow is available';

let tmpRoot;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'work-hook-banner-'));
});

afterEach(() => {
  if (tmpRoot) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  }
});

/**
 * Spawn the real hook for a prompt with isolated cache/marker dirs so the
 * 24h cache and per-session marker never bleed between runs.
 */
function runHook(userPrompt, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      CLAUDE_USER_PROMPT: userPrompt,
      // Isolate every persistence seam to this run's temp dir.
      WORK_UPDATE_CHECK_CACHE_DIR: path.join(tmpRoot, 'cache'),
      WORK_UPDATE_CHECK_MARKER_DIR: path.join(tmpRoot, 'marker'),
      ...extraEnv,
    };
    // Never let a globally-set opt-out suppress the check under test.
    delete env.WORK_DISABLE_UPDATE_CHECK;

    const proc = spawn(process.execPath, [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
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
    proc.stdin.end();
  });
}

describe('work-hook update banner integration', () => {
  it('emits the banner AND the plan section and exits 0 when an update is available', async () => {
    const { code, stdout } = await runHook('/work GH-1', {
      WORK_UPDATE_CHECK_TEST_LATEST: '3.99.0',
    });

    assert.strictEqual(code, 0, 'hook must exit 0 even with the banner');
    assert.ok(
      stdout.includes(BANNER_MARKER),
      `stdout should contain the update banner, got:\n${stdout}`
    );
    assert.ok(
      stdout.includes('3.99.0'),
      `stdout should name the injected latest version 3.99.0, got:\n${stdout}`
    );
    assert.ok(
      stdout.includes(PLAN_MARKER),
      `stdout should still contain the orchestrator plan section, got:\n${stdout}`
    );
  });

  it('emits the plan section with NO banner and exits 0 when the source is unreachable', async () => {
    const { code, stdout } = await runHook('/work GH-1', {
      WORK_UPDATE_CHECK_TEST_FAIL: '1',
    });

    assert.strictEqual(code, 0, 'hook must exit 0 when the version source is unreachable');
    assert.ok(
      stdout.includes(PLAN_MARKER),
      `stdout should still contain the orchestrator plan section, got:\n${stdout}`
    );
    assert.ok(
      !stdout.includes(BANNER_MARKER),
      `stdout should NOT contain the update banner when offline, got:\n${stdout}`
    );
  });
});
