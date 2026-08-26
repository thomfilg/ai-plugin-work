'use strict';

/**
 * init-run.js — the `--init` bootstrap for follow-up-next.js.
 *
 * Drops any cached state (a stale "complete" from a previous run would
 * short-circuit the whole cycle), stamps the orchestrator pid marker, and
 * registers the session guard so the Stop hook blocks abandonment. Extracted
 * from follow-up-next.js's `main()` to keep that file inside the size gate.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Register the session guard. Idempotent: a parent /work session is reused. */
function registerSessionGuard(safeName) {
  try {
    const { spawnSync } = require('node:child_process');
    const sessionGuardPath = path.join(__dirname, '..', '..', 'lib', 'hooks', 'session-guard.js');
    spawnSync('node', [sessionGuardPath, 'init', safeName, '/follow-up'], {
      stdio: 'inherit',
      timeout: 5000,
    });
  } catch {
    /* fail-open — session guard is advisory */
  }
}

/**
 * @param {string} tasksBase
 * @param {string} safeName — sanitized ticket id
 */
function initRun(tasksBase, safeName) {
  const markerDir = path.join(tasksBase, safeName);
  fs.mkdirSync(markerDir, { recursive: true });

  const existingState = path.join(markerDir, '.follow-up-state.json');
  if (fs.existsSync(existingState)) fs.unlinkSync(existingState);

  const { ownerStamp } = require(path.join(__dirname, '..', '..', 'work', 'lib', 'marker'));
  fs.writeFileSync(
    path.join(markerDir, '.follow-up-orchestrator.pid'),
    JSON.stringify({
      ticket: safeName,
      startedAt: new Date().toISOString(),
      workflow: '/follow-up',
      ...ownerStamp(),
    })
  );

  registerSessionGuard(safeName);
}

module.exports = { initRun };
